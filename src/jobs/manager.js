import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { runJob } from './runner.js';
import { buildArgs, buildMergeArgs, resolveOutPath, tileStem } from './argv.js';
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
    // input = {kind:'upload', name|names[], stagedDir?} (files in stagedDir,
    // moved into the job's input/ here) | {kind:'upload', name|names[]}
    // (already in input/) | {kind:'upload-dir', name} | {kind:'path', path|paths[]}
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
      const names = input.names ?? [input.name];
      if (input.stagedDir) {
        for (const nm of [...names, input.prjName, input.cpsName, input.cfgName]) {
          if (!nm) continue;
          await fsp.rename(path.join(input.stagedDir, nm),
            path.join(this.inputDir(id), nm));
        }
        await fsp.rm(input.stagedDir, { recursive: true, force: true });
        input = { kind: 'upload', name: names[0], ...(names.length > 1 ? { names } : {}),
          prjName: input.prjName, cpsName: input.cpsName, cfgName: input.cfgName };
      }
      // files must already have been streamed into inputDir by the route
      for (const nm of names) {
        if (!fs.existsSync(path.join(this.inputDir(id), nm))) {
          await fsp.rm(this.jobDir(id), { recursive: true, force: true });
          throw httpError(400, `missing uploaded file: ${nm}`, 'INPUT_MISSING');
        }
      }
    } else if (input.kind === 'upload-dir' || input.kind === 'upload-tree') {
      // directory / model-tree upload: the route rebuilt the folder tree in
      // stagedDir (relPaths folder picker or ZIP extract); move it intact into
      // this job's input/ — tiles & mesh carry side-car textures next to the
      // model there, which is where the engine looks for them.
      if (input.stagedDir) {
        await moveTree(input.stagedDir, this.inputDir(id));
        await fsp.rm(input.stagedDir, { recursive: true, force: true });
      }
      if (input.kind === 'upload-dir') {
        // osgb root = the whole input dir
        input = { kind: 'upload-dir', name: input.name, prjName: input.prjName, cpsName: input.cpsName, cfgName: input.cfgName };
      } else {
        input = { kind: 'upload-tree', models: input.models, name: input.models[0],
          ...(input.models.length > 1 ? { names: input.models } : {}),
          prjName: input.prjName, cpsName: input.cpsName, cfgName: input.cfgName };
        for (const m of input.models) {
          if (!fs.existsSync(path.join(this.inputDir(id), m))) {
            await fsp.rm(this.jobDir(id), { recursive: true, force: true });
            throw httpError(400, `missing model in uploaded tree: ${m}`, 'INPUT_MISSING');
          }
        }
      }
    } else {
      input.paths = (input.paths ?? [input.path]).map((p) => path.resolve(p));
      input.path = input.paths[0];
      if (input.paths.length > 1) input.names = input.names ?? input.paths.map((p) => path.basename(p));
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

  /* ---------------- run pipeline ---------------- */

  /** The `-i` targets of a job, in upload order: [{name, path}]. */
  jobFiles(job) {
    const inp = job.input ?? {};
    if (inp.kind === 'upload') {
      const names = inp.names ?? [inp.name];
      return names.map((n) => ({ name: n, path: path.join(this.inputDir(job.id), n) }));
    }
    if (inp.kind === 'upload-dir') return [{ name: inp.name, path: this.inputDir(job.id) }];
    if (inp.kind === 'upload-tree') {
      // model + side-car textures live at their original relative paths
      return (inp.models ?? [inp.name]).map((m) => ({
        name: m, path: path.join(this.inputDir(job.id), m),
      }));
    }
    const paths = inp.paths ?? [inp.path];
    return paths.map((p, i) => ({
      name: inp.names?.[i] ?? path.basename(p), path: p,
    }));
  }

  /** Uploaded side-car files (.prj / control-point CSV / mesh config CSV),
   *  all landing in the job's own input dir. */
  ioBase(job) {
    const io = {};
    if (job.input.prjName) io.prjFile = path.join(this.inputDir(job.id), job.input.prjName);
    if (job.input.cpsName) io.cpsFile = path.join(this.inputDir(job.id), job.input.cpsName);
    if (job.input.cfgName) io.cfgFile = path.join(this.inputDir(job.id), job.input.cfgName);
    return io;
  }

  async start(job) {
    try {
      // inline control-points CSV → on-disk file the CLI expects (wins over upload)
      if (job.params?.georef?.controlPoints) {
        const cps = path.join(this.inputDir(job.id), '_controlpoints.csv');
        await fsp.writeFile(cps, job.params.georef.controlPoints);
        job.input.cpsName = '_controlpoints.csv';
      }
      if (job.type === 'tiles') await this.runTiles(job);
      else await this.runSingle(job);
    } catch (err) {
      this.setStatus(job, 'failed', { error: { code: 'RUNNER', message: String(err?.message ?? err) } });
      this.handles.delete(job.id);
      await this.persist(job);
    }
    this.pump();
  }

  /** One mgo invocation (every job type except multi-file tiles). */
  async runSingle(job) {
    const f = this.jobFiles(job)[0];
    const io = {
      ...this.ioBase(job),
      input: f.path,
      out: resolveOutPath(job, this.outDir(job.id), f.name ?? 'model'),
    };
    const args = buildArgs(job, io);
    io.args = args; // kept on job for audit/restart
    job.argv = args;

    this.setStatus(job, 'running', { startedAt: new Date().toISOString(), argv: args });
    await this.persist(job);

    const parser = new ProgressParser();
    const res = await this.spawn(job, this.cfg.binary, args, parser);
    await this.finish(job, parser, res);
  }

  /** Emit an SSE log event AND append to run.log (audit trail for service
   *  steps that do not come from a child process, e.g. merge phase). */
  async serviceLog(job, line) {
    this.emitEvent(job, { type: 'log', stream: 'stdout', line });
    try { await fsp.appendFile(this.logPath(job.id), `${line}\n`); } catch { /* ok if missing */ }
  }

  /**
   * tiles: convert EVERY input with the SAME params into its own
   * `out/<stem>/` (identical directory logic for 1…N files), then merge the
   * per-file tilesets into one unified `out/tileset.json` via 3d-tiles-tools
   * (mergeJson — the sub tilesets stay external and keep serving fine).
   */
  async runTiles(job) {
    const files = this.jobFiles(job);
    const outDir = this.outDir(job.id);
    const used = new Set();
    // tree uploads carry relative names (bridge/root.fbx) — fold separators into
    // the stem so out/<stem>/ stays unique and readable
    const steps = files.map((f) => ({ ...f, stem: tileStem(String(f.name).split(/[\\/]+/).join('_'), used) }));
    const N = steps.length;
    const parser = new ProgressParser();

    for (let i = 0; i < N; i++) {
      const st = steps[i];
      st.tileset = path.join(outDir, st.stem, 'tileset.json');
      // the engine will not create its -o directory itself (real MGOConsole
      // exits 1 with "[TileBuilder] Cannot write …/tileset.json")
      await fsp.mkdir(path.dirname(st.tileset), { recursive: true });
      const io = { ...this.ioBase(job), input: st.path, out: path.dirname(st.tileset) };
      const args = buildArgs(job, io);
      if (i === 0) {
        job.argv = args;
        this.setStatus(job, 'running', { startedAt: new Date().toISOString(), argv: args });
        await this.persist(job);
      }
      await this.serviceLog(job, `[Service] (${i + 1}/${N}) converting ${st.name} -> out/${st.stem}/`);
      await this.serviceLog(job, `[Service] argv: ${args.join(' ')}`);
      const res = await this.spawn(job, this.cfg.binary, args, parser,
        (line, stream) => this.onLine(job, parser, line, stream, { index: i, files: N }));
      if (!res.ok) return this.finish(job, parser, res, `convert ${st.name}`);
      if (res.canceled || res.timedOut) return this.finish(job, parser, res);
      if (res.exitCode !== 0) return this.finish(job, parser, res, `convert ${st.name}`);
      if (!fs.existsSync(st.tileset)) {
        return this.fail(job, 'NO_ARTIFACTS',
          `exit 0 but no tileset.json for input "${st.name}" (expected out/${st.stem}/tileset.json)`);
      }
    }

    await this.mergeTilesets(job, parser, steps);
  }

  /** 3d-tiles-tools mergeJson → unified out/tileset.json. */
  async mergeTilesets(job, parser, steps) {
    const outDir = this.outDir(job.id);
    const merged = path.join(outDir, 'tileset.json');
    const inputs = steps.map((s) => s.tileset);
    const tool = this.cfg.tilesToolsCli;
    if (!tool) {
      return this.fail(job, 'MERGE_TOOL_MISSING',
        '3d-tiles-tools CLI not found — install dependencies or set MGO_3D_TILES_TOOLS');
    }
    await fsp.rm(merged, { force: true });
    const margs = buildMergeArgs(inputs, merged);
    job.mergeArgv = margs;
    job.progress = { ...job.progress, percent: Math.max(job.progress.percent, 99),
      phase: 'merge', source: 'service',
      message: `merging ${inputs.length} tileset(s) -> out/tileset.json` };
    this.emitEvent(job, { type: 'progress', data: job.progress });
    await this.serviceLog(job, `[Service] merging ${inputs.length} tileset(s) with 3d-tiles-tools mergeJson`);

    // the npm CLI ships an .mjs script; spawn it on the current node binary.
    // An explicit MGO_3D_TILES_TOOLS may point at any executable instead.
    const isScript = /\.(c|m)?js$/i.test(tool);
    const res = await this.spawn(job, isScript ? process.execPath : tool,
      isScript ? [tool, ...margs] : margs, parser);
    if (!res.ok) return this.failMerge(job, `cannot launch 3d-tiles-tools "${tool}": ${res.error}`);
    if (res.canceled || res.timedOut) return this.finish(job, parser, res);
    if (res.exitCode !== 0) {
      return this.failMerge(job, `3d-tiles-tools mergeJson exited with code ${res.exitCode}`);
    }
    // v0.5.4 logs errors yet exits 0 — the merged file itself is the truth
    let doc;
    try { doc = JSON.parse(await fsp.readFile(merged, 'utf8')); } catch {
      return this.failMerge(job, 'merge produced no readable out/tileset.json (see run.log)');
    }
    const kids = doc?.root?.children ?? [];
    if (!doc || !doc.root?.boundingVolume || kids.length !== inputs.length) {
      return this.failMerge(job,
        `merged tileset.json is invalid (root.boundingVolume missing or ${kids.length} children ≠ ${inputs.length} inputs)`);
    }
    await this.finish(job, parser, { ok: true, exitCode: 0 });
  }

  /** spawn + register the cancel handle; onLine overridable for scaling. */
  spawn(job, binary, args, parser, onLine) {
    const handle = runJob({
      binary,
      args,
      logPath: this.logPath(job.id),
      timeoutMs: this.cfg.jobTimeoutS * 1000,
      onLine: onLine ?? ((line, stream) => this.onLine(job, parser, line, stream)),
    });
    this.handles.set(job.id, handle);
    return handle.promise.then((res) => { this.handles.delete(job.id); return res; });
  }

  fail(job, code, message) {
    this.setStatus(job, 'failed', {
      exitCode: null,
      error: { code, message, logTail: job._tail.slice(-15) },
    });
    return this.persist(job);
  }

  failMerge(job, message) {
    return this.fail(job, 'MERGE', `${message} — inputs kept under out/<name>/`);
  }

  onLine(job, parser, line, stream, scale) {
    if (!line.trim()) return;
    job._tail.push(line);
    if (job._tail.length > TAIL_CAP) job._tail.shift();

    const ev = parser.parse(line);
    if (ev) {
      const prev = job.progress;
      // multi-file tiles: scale the per-file 0..100 into this job's slice
      let percent = ev.percent;
      if (scale && scale.files > 1) {
        percent = Math.min(98, Math.floor(((scale.index + ev.percent / 100) / scale.files) * 98));
      }
      job.progress = {
        done: ev.done, total: ev.total, percent,
        phase: ev.phase ?? prev.phase, source: 'cli-stdout', message: ev.detail ?? line,
      };
      if (ev.type === 'done' || percent !== prev.percent) {
        this.emitEvent(job, { type: 'progress', data: job.progress });
        if (ev.type === 'done' || percent - prev.percent >= 5) this.persist(job);
      }
      return;
    }
    // forward module diagnostics ([Mod] …) and anything on stderr, capped
    if ((stream === 'stderr' || isModuleLine(line)) && job.events.length < EVENT_CAP * 3) {
      this.emitEvent(job, { type: 'log', line, stream });
    }
  }

  async finish(job, parser, res, stage = null) {
    const where = stage ? ` (${stage})` : '';
    if (!res.ok) {
      this.setStatus(job, 'failed', {
        error: { code: 'SPAWN', message: `cannot launch mgo binary "${this.cfg.binary}": ${res.error}${where}`,
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
        error: { code: 'USAGE_ERROR', message: `mgo rejected the arguments (service mapping bug?)${where}`,
          logTail: job._tail.slice(-15) },
      });
      return this.persist(job);
    }
    this.setStatus(job, 'failed', {
      exitCode: res.exitCode,
      error: { code: 'CONVERSION', message: `mgo exited with code ${res.exitCode}${where}`,
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
    inputName: job.input?.names?.length > 1
      ? `${job.input.name} (+${job.input.names.length - 1})`
      : (job.input?.name ?? null),
    inputNames: job.input?.names ?? (job.input?.name ? [job.input.name] : null),
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
