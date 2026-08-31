import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { runJob } from './runner.js';
import { buildArgs, resolveOutPath } from './argv.js';
import { discoverArtifacts, primaryArtifact } from './artifacts.js';
import { ProgressParser, isModuleLine } from './progress.js';

const EVENT_CAP = 300;       // per-job in-memory replay buffer (SSE)
const TAIL_CAP = 30;         // stderr/log tail kept for error reporting

export const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'usage_error']);

function httpError(status, message, code) {
  return Object.assign(new Error(message), { statusCode: status, errCode: code });
}

/** Recursively move every file under `src` into `dst`, preserving the relative
 *  tree (used for osgb directory uploads; staged dir → job input/). */
async function moveTree(src, dst) {
  const entries = await fsp.readdir(src, { withFileTypes: true });
  await fsp.mkdir(dst, { recursive: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await moveTree(s, d);
    else {
      await fsp.mkdir(path.dirname(d), { recursive: true });
      await fsp.rename(s, d);
    }
  }
}

export class JobManager extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.jobs = new Map();
    this.pending = [];            // FIFO of queued job ids
    this.handles = new Map();     // running id → {cancel}
    this._seq = 0;
    this._cleanupTimer = null;
  }

  /* ---------------- workspace layout ---------------- */
  jobDir(id) { return path.join(this.cfg.workspaceRoot, 'jobs', id); }
  inputDir(id) { return path.join(this.jobDir(id), 'input'); }
  outDir(id) { return path.join(this.jobDir(id), 'out'); }
  logPath(id) { return path.join(this.jobDir(id), 'run.log'); }
  metaPath(id) { return path.join(this.jobDir(id), 'job.json'); }

  async init() {
    await fsp.mkdir(path.join(this.cfg.workspaceRoot, 'jobs'), { recursive: true });
    await this.recover();
    this._cleanupTimer = setInterval(() => { this.cleanupExpired().catch(() => {}); }, 3600_000);
    this._cleanupTimer.unref?.();
    this.cleanupExpired().catch(() => {});
  }

  stop() { if (this._cleanupTimer) clearInterval(this._cleanupTimer); }

  /** Boot recovery: queued/running jobs are dead children — mark interrupted. */
  async recover() {
    let ids = [];
    try { ids = await fsp.readdir(path.join(this.cfg.workspaceRoot, 'jobs')); } catch { return; }
    for (const id of ids) {
      try {
        const meta = JSON.parse(await fsp.readFile(this.metaPath(id), 'utf8'));
        if (!TERMINAL.has(meta.status)) {
          meta.status = 'failed';
          meta.finishedAt = meta.finishedAt ?? new Date().toISOString();
          meta.error = { code: 'INTERRUPTED', message: 'server restarted while job was active' };
        }
        meta.events = [];
        this.jobs.set(id, { ...meta, _tail: [] });
        await this.persist(meta);
      } catch { /* ignore malformed dirs */ }
    }
  }

  get(id) { return this.jobs.get(id); }

  list({ type, status, limit = 50, offset = 0 } = {}) {
    let arr = [...this.jobs.values()];
    if (type) arr = arr.filter((j) => j.type === type);
    if (status) arr = arr.filter((j) => j.status === status);
    arr.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { total: arr.length, items: arr.slice(offset, offset + limit).map((j) => jobDto(j)) };
  }

  /* ---------------- job lifecycle ---------------- */

  async create({ id, type, params, input }) {
    // input = {kind:'upload', name, stagedDir?} (file in stagedDir, moved into
    // the job's input/ here) | {kind:'upload', name} (already in input/) |
    // {kind:'path', path, name}
    if (this.pending.length >= this.cfg.queueMax) {
      throw httpError(429, 'job queue is full', 'QUEUE_FULL');
    }
    if (!(await this.hasFreeDisk())) {
      throw httpError(507, 'insufficient disk space on workspace volume', 'DISK_FULL');
    }
    id = id ?? randomUUID();
    await fsp.mkdir(this.inputDir(id), { recursive: true });
    await fsp.mkdir(this.outDir(id), { recursive: true });

    if (input.kind === 'upload') {
      if (input.stagedDir) {
        for (const nm of [input.name, input.prjName, input.cpsName, input.cfgName]) {
          if (!nm) continue;
          await fsp.rename(path.join(input.stagedDir, nm),
            path.join(this.inputDir(id), nm));
        }
        await fsp.rm(input.stagedDir, { recursive: true, force: true });
        input = { kind: 'upload', name: input.name, prjName: input.prjName, cpsName: input.cpsName, cfgName: input.cfgName };
      }
      // file must already have been streamed into inputDir by the route
      const p = path.join(this.inputDir(id), input.name);
      if (!fs.existsSync(p)) {
        await fsp.rm(this.jobDir(id), { recursive: true, force: true });
        throw httpError(400, `missing uploaded file: ${input.name}`, 'INPUT_MISSING');
      }
    } else if (input.kind === 'upload-dir') {
      // directory upload: the route rebuilt the folder tree inside stagedDir;
      // move the whole tree into this job's input/ (osgb root = input dir)
      if (input.stagedDir) {
        await moveTree(input.stagedDir, this.inputDir(id));
        await fsp.rm(input.stagedDir, { recursive: true, force: true });
        input = { kind: 'upload-dir', name: input.name, prjName: input.prjName, cpsName: input.cpsName, cfgName: input.cfgName };
      }
    } else {
      input.path = path.resolve(input.path);
    }

    const job = {
      id, type, params, input,
      status: 'queued',
      progress: { done: 0, total: 0, percent: 0, phase: null, source: 'none', message: null },
      createdAt: new Date().toISOString(),
      startedAt: null, finishedAt: null, exitCode: null,
      error: null, artifacts: [], viewerUrl: null,
      events: [], _tail: [],
    };
    this.jobs.set(id, job);
    this.pending.push(id);
    await this.persist(job);
    this.emitEvent(job, { type: 'status', status: 'queued' });
    this.pump();
    return job;
  }

  pump() {
    while (this.handles.size < this.cfg.maxConcurrentJobs && this.pending.length) {
      const id = this.pending.shift();
      const job = this.jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      this.start(job).catch((err) => {
        this.setStatus(job, 'failed', { error: { code: 'RUNNER', message: String(err?.message ?? err) } });
        this.handles.delete(job.id);
        this.persist(job);
      });
    }
  }

  async start(job) {
    const io = {
      input: job.input.kind === 'upload'
        ? path.join(this.inputDir(job.id), job.input.name)
        : job.input.kind === 'upload-dir'
          ? this.inputDir(job.id)              // osgb root = the whole input dir
          : job.input.path,
      out: resolveOutPath(job, this.outDir(job.id), job.input.name ?? 'model'),
    };
    // uploaded .prj / control-point CSV / mesh config CSV land in the job's own input dir
    if (job.input.prjName) io.prjFile = path.join(this.inputDir(job.id), job.input.prjName);
    if (job.input.cpsName) io.cpsFile = path.join(this.inputDir(job.id), job.input.cpsName);
    if (job.input.cfgName) io.cfgFile = path.join(this.inputDir(job.id), job.input.cfgName);
    // inline control-points CSV → on-disk file the CLI expects (wins over upload)
    if (job.params?.georef?.controlPoints) {
      const cps = path.join(this.inputDir(job.id), '_controlpoints.csv');
      await fsp.writeFile(cps, job.params.georef.controlPoints);
      io.cpsFile = cps;
    }
    const args = buildArgs(job, io);
    io.args = args; // kept on job for audit/restart
    job.argv = args;

    this.setStatus(job, 'running', { startedAt: new Date().toISOString(), argv: args });
    await this.persist(job);

    const parser = new ProgressParser();
    const handle = runJob({
      binary: this.cfg.binary,
      args,
      logPath: this.logPath(job.id),
      timeoutMs: this.cfg.jobTimeoutS * 1000,
      onLine: (line, stream) => this.onLine(job, parser, line, stream),
    });
    this.handles.set(job.id, handle);
    const res = await handle.promise;
    this.handles.delete(job.id);
    await this.finish(job, parser, res);
    this.pump();
  }

  onLine(job, parser, line, stream) {
    if (!line.trim()) return;
    job._tail.push(line);
    if (job._tail.length > TAIL_CAP) job._tail.shift();

    const ev = parser.parse(line);
    if (ev) {
      const prev = job.progress;
      job.progress = {
        done: ev.done, total: ev.total, percent: ev.percent,
        phase: ev.phase ?? prev.phase, source: 'cli-stdout', message: ev.detail ?? line,
      };
      if (ev.type === 'done' || ev.percent !== prev.percent) {
        this.emitEvent(job, { type: 'progress', data: job.progress });
        if (ev.type === 'done' || (ev.percent - prev.percent >= 5)) this.persist(job);
      }
      return;
    }
    // forward module diagnostics ([Mod] …) and anything on stderr, capped
    if ((stream === 'stderr' || isModuleLine(line)) && job.events.length < EVENT_CAP * 3) {
      this.emitEvent(job, { type: 'log', line, stream });
    }
  }

  async finish(job, parser, res) {
    if (!res.ok) {
      this.setStatus(job, 'failed', {
        error: { code: 'SPAWN', message: `cannot launch mgo binary "${this.cfg.binary}": ${res.error}`,
          logTail: job._tail.slice(-10) },
      });
      return this.persist(job);
    }
    if (res.canceled || res.timedOut) {
      this.setStatus(job, 'canceled', {
        exitCode: null,
        error: res.timedOut ? { code: 'TIMEOUT', message: `killed after ${this.cfg.jobTimeoutS}s` } : null,
      });
      return this.persist(job);
    }
    if (res.exitCode === 0) {
      const artifacts = await discoverArtifacts(job.id, this.outDir(job.id));
      if (!artifacts.length) {
        this.setStatus(job, 'failed', {
          exitCode: 0,
          error: { code: 'NO_ARTIFACTS', message: 'exit 0 but no recognizable output', logTail: job._tail.slice(-10) },
        });
      } else {
        job.artifacts = artifacts;
        const prim = primaryArtifact(artifacts);
        job.viewerUrl = prim?.viewer
          ? `/viewer.html?asset=${encodeURIComponent(prim.viewer.url)}&type=${prim.viewer.type}`
          : null;
        job.progress = { ...job.progress, percent: 100, source: 'cli-stdout' };
        this.setStatus(job, 'succeeded', { exitCode: 0 });
      }
      return this.persist(job);
    }
    if (res.exitCode === 2) {
      // usage error means our argv mapping is wrong — surface loudly
      this.setStatus(job, 'usage_error', {
        exitCode: 2,
        error: { code: 'USAGE_ERROR', message: 'mgo rejected the arguments (service mapping bug?)',
          logTail: job._tail.slice(-15) },
      });
      return this.persist(job);
    }
    this.setStatus(job, 'failed', {
      exitCode: res.exitCode,
      error: { code: 'CONVERSION', message: `mgo exited with code ${res.exitCode}`,
        logTail: job._tail.slice(-15) },
    });
    return this.persist(job);
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw httpError(404, 'job not found', 'NOT_FOUND');
    if (TERMINAL.has(job.status)) throw httpError(409, `job already ${job.status}`, 'NOT_CANCELLABLE');
    const idx = this.pending.indexOf(id);
    if (idx >= 0) {
      this.pending.splice(idx, 1);
      this.setStatus(job, 'canceled');
      await this.persist(job);
      this.pump();
      return job;
    }
    const h = this.handles.get(id);
    if (h) h.cancel();
    return job;
  }

  async remove(id) {
    const job = this.jobs.get(id);
    if (!job) throw httpError(404, 'job not found', 'NOT_FOUND');
    if (this.handles.has(id)) { this.handles.get(id).cancel(); await onceTerminal(job, 10_000); }
    const idx = this.pending.indexOf(id);
    if (idx >= 0) this.pending.splice(idx, 1);
    this.jobs.delete(id);
    await fsp.rm(this.jobDir(id), { recursive: true, force: true });
    return true;
  }

  async logTail(id, n = 200) {
    const job = this.jobs.get(id);
    if (!job) throw httpError(404, 'job not found', 'NOT_FOUND');
    let text = '';
    try { text = await fsp.readFile(this.logPath(id), 'utf8'); } catch { return { lines: [] }; }
    const lines = text.split('\n').filter((l) => l.length);
    return { lines: lines.slice(-Math.min(n, 2000)) };
  }

  /* ---------------- infra ---------------- */

  async hasFreeDisk() {
    if (!this.cfg.minFreeGb) return true;
    try {
      const s = await fsp.statfs(this.cfg.workspaceRoot);
      return s.bsize * s.bavail > this.cfg.minFreeGb * 1024 ** 3;
    } catch { return true; }
  }

  async cleanupExpired() {
    const cutoff = Date.now() - this.cfg.ttlDays * 86400_000;
    for (const [id, job] of this.jobs) {
      if (!TERMINAL.has(job.status) || !job.finishedAt) continue;
      if (Date.parse(job.finishedAt) < cutoff) {
        await this.remove(id).catch(() => {});
      }
    }
  }

  emitEvent(job, evt) {
    const e = { seq: ++this._seq, ts: new Date().toISOString(), ...evt };
    job.events.push(e);
    if (job.events.length > EVENT_CAP) job.events.splice(0, job.events.length - EVENT_CAP);
    this.emit('event', { jobId: job.id, evt: e });
    return e;
  }

  setStatus(job, status, extra = {}) {
    Object.assign(job, extra, { status });
    if (TERMINAL.has(status)) {
      job.finishedAt = extra.finishedAt ?? new Date().toISOString();
    }
    this.emitEvent(job, { type: 'status', status, ...(status === 'succeeded'
      ? { artifacts: job.artifacts, viewerUrl: job.viewerUrl } : {}) });
  }

  async persist(job) {
    const { _tail, events, ...rest } = job;
    const tmp = this.metaPath(job.id) + '.tmp';
    try {
      await fsp.writeFile(tmp, JSON.stringify(rest, null, 2));
      await fsp.rename(tmp, this.metaPath(job.id));
    } catch { /* job dir may be gone (removed mid-run) */ }
  }
}

function onceTerminal(job, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (TERMINAL.has(job.status) || Date.now() - t0 > ms) { clearInterval(iv); resolve(); }
    }, 100);
    iv.unref?.();
  });
}

/** Public representation of a job (what REST returns). */
export function jobDto(job, { withParams = false } = {}) {
  const dto = {
    id: job.id,
    type: job.type,
    status: job.status,
    inputName: job.input?.name ?? null,
    progress: job.progress,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    error: job.error,
    artifacts: job.artifacts,
    viewerUrl: job.viewerUrl,
    links: {
      self: `/api/v1/jobs/${job.id}`,
      events: `/api/v1/jobs/${job.id}/events`,
      log: `/api/v1/jobs/${job.id}/log`,
      artifacts: `/api/v1/jobs/${job.id}/artifacts`,
      data: `/ws/${job.id}/out/`,
    },
  };
  if (withParams) dto.params = job.params;
  return dto;
}
