import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { jobSchema, JOB_TYPES, INPUT_EXT, INPUT_KIND } from '../jobs/schemas.js';
import { jobDto } from '../jobs/manager.js';
import { checkLocalPath, checkParamPaths, sanitizeFileName, extOf } from '../localpath.js';
import { normalizeIp, parseCidr, BUILTIN_LOCAL } from '../ipmatch.js';
import { PKG } from '../config.js';
import { extractZip } from '../zipextract.js';

function err(status, code, message, details) {
  return Object.assign(new Error(message), { statusCode: status, errCode: code, details });
}

function validateInput(type, { name, kind }) {
  if (!JOB_TYPES.includes(type)) {
    throw err(422, 'BAD_TYPE', `unknown job type "${type}"`, { expected: JOB_TYPES });
  }
  const whitelist = INPUT_EXT[type];
  if (INPUT_KIND[type] === 'dir') {
    if (kind !== 'dir') {
      throw err(400, 'INPUT_TYPE', 'osgb input must be a folder — upload the whole directory, or use a server-local path',
        { hint: 'multipart with options.relPaths (folder picker), or POST JSON {type:"osgb", inputPath:…} with MGO_ALLOW_LOCAL_PATH=1' });
    }
    return;
  }
  if (kind !== 'file') throw err(400, 'INPUT_TYPE', `${type} input must be a single file`);
  const ext = extOf(name);
  if (whitelist.length && !whitelist.includes(ext)) {
    throw err(422, 'INPUT_EXT', `input extension .${ext} not accepted for type "${type}"`,
      { expected: whitelist });
  }
}

export function registerApi(app, { manager, cfg, mgo, cesiumLocal }) {
  /* ---- write-protection: IP whitelist (localhost always allowed) ----
   * Mutations (POST/DELETE) require a whitelisted client IP.  Reads stay
   * open.  The whitelist itself is only manageable from localhost. */
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.method === 'GET' || req.method === 'HEAD') return;
    if (req.url.startsWith('/api/v1/whitelist')) return; // localhost-only, checked in-route
    const ip = normalizeIp(req.ip);
    if (!cfg.isAllowedIp(ip)) {
      throw err(403, 'IP_NOT_ALLOWED',
        `client IP ${ip} is not in the whitelist — run from this machine, or add it via localhost GET/POST /api/v1/whitelist`);
    }
  });

  /** whitelist management is strictly localhost (independent of the whitelist
   *  itself, so a misconfiguration can never lock the admin out). */
  function assertLocal(req) {
    if (!BUILTIN_LOCAL.includes(normalizeIp(req.ip))) {
      throw err(403, 'LOCAL_ONLY',
        `the whitelist can only be configured from this machine (localhost); got ${normalizeIp(req.ip)}`);
    }
  }

  /* ---- meta ---- */
  app.get('/api/v1/health', async () => ({
    status: 'ok',
    uptimeS: Math.round(process.uptime()),
    server: { name: PKG.name, version: process.env.MGO_PKG_VERSION ?? PKG.version },
    mgo,
  }));

  /* ---- operational metrics (M3: metrics) ---- */
  app.get('/api/v1/metrics', async () => {
    const all = [...manager.jobs.values()];
    const byStatus = {};
    for (const j of all) byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
    return {
      uptimeS: Math.round(process.uptime()),
      jobs: {
        total: all.length,
        byStatus,
        queueDepth: manager.pending.length,
        running: manager.handles.size,
      },
      limits: {
        maxConcurrentJobs: cfg.maxConcurrentJobs,
        queueMax: cfg.queueMax,
      },
      whitelist: { entries: cfg.whitelist.length },
      process: {
        rssMb: Math.round(process.memoryUsage().rss / 1048576),
        heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
      },
    };
  });

  app.get('/api/v1/capabilities', async (req) => ({
    jobTypes: mgo.hasOsgb ? JOB_TYPES : JOB_TYPES.filter((t) => t !== 'osgb'),
    limits: {
      uploadMaxBytes: cfg.uploadMaxBytes,
      queueMax: cfg.queueMax,
      maxConcurrentJobs: cfg.maxConcurrentJobs,
      jobTimeoutS: cfg.jobTimeoutS,
      ttlDays: cfg.ttlDays,
    },
    features: {
      osgb: mgo.hasOsgb,
      localPathInput: cfg.allowLocalPath,
      authMode: 'ip-whitelist',
    },
    client: {
      ip: normalizeIp(req.ip),
      allowed: cfg.isAllowedIp(req.ip),
      canManageWhitelist: BUILTIN_LOCAL.includes(normalizeIp(req.ip)),
    },
    cesium: { version: '1.111', selfHosted: cesiumLocal },
  }));

  /* ---- IP whitelist management (localhost only) ---- */
  app.get('/api/v1/whitelist', async (req) => {
    assertLocal(req);
    return {
      whitelist: cfg.whitelist,
      note: 'localhost is always allowed and not removable; entries are IP or CIDR',
    };
  });

  app.post('/api/v1/whitelist', async (req, reply) => {
    assertLocal(req);
    const body = req.body ?? {};
    if (!Array.isArray(body.whitelist)) {
      throw err(422, 'BAD_WHITELIST', 'body must be { "whitelist": ["1.2.3.4", "10.0.0.0/8", …] }');
    }
    const parsed = [];
    for (const raw of body.whitelist) {
      const e = String(raw).trim();
      if (!e) continue;
      if (!parseCidr(e)) throw err(422, 'BAD_ENTRY', `invalid IP/CIDR entry "${e}"`);
      parsed.push(e);
    }
    const all = [...new Set([...BUILTIN_LOCAL, ...parsed])];
    await fsp.mkdir(path.dirname(cfg.whitelistFile), { recursive: true });
    await fsp.writeFile(cfg.whitelistFile, JSON.stringify(all, null, 2) + '\n');
    cfg.whitelist.length = 0;
    cfg.whitelist.push(...all);   // live update (config.isAllowedIp closes over this array)
    return reply.code(200).send({ whitelist: cfg.whitelist });
  });

  /* ---- create job ---- */
  app.post('/api/v1/jobs', async (req, reply) => {
    const ct = String(req.headers['content-type'] ?? '');
    let options; let input;

    if (ct.includes('multipart/form-data')) {
      const id = randomUUID();
      const stagedDir = path.join(cfg.workspaceRoot, 'tmp', id);
      await fsp.mkdir(stagedDir, { recursive: true });
      try {
        let optionsRaw = null;
        let fileName = null; let prjName = null; let cpsName = null; let cfgName = null;
        const dirFiles = [];   // {seq, orig} for directory uploads
        let fileSeq = 0;
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            let destName;
            if (part.fieldname === 'file') {
              fileSeq++;
              if (fileSeq > cfg.uploadMaxFiles) {
                throw err(400, 'TOO_MANY_FILES', `more than ${cfg.uploadMaxFiles} files (directory uploads have a per-job cap)`);
              }
              const orig = sanitizeFileName(part.filename);
              // directory uploads send many `file` parts with seq names
              // (f_000001…) plus options.relPaths mapping seq → relative path
              destName = `f_${String(fileSeq).padStart(6, '0')}`;
              dirFiles.push({ seq: destName, orig });
            } else if (part.fieldname === 'prj') {
              if (prjName) throw err(400, 'TOO_MANY_FILES', 'duplicate file field "prj"');
              const ext = extOf(sanitizeFileName(part.filename));
              if (!['prj', 'wkt', 'proj'].includes(ext)) {
                throw err(422, 'PRJ_EXT', 'prj file must be .prj/.wkt/.proj', { expected: ['prj', 'wkt', 'proj'] });
              }
              destName = `_projection.${ext}`;
              prjName = destName;
            } else if (part.fieldname === 'cps') {
              if (cpsName) throw err(400, 'TOO_MANY_FILES', 'duplicate file field "cps"');
              const ext = extOf(sanitizeFileName(part.filename));
              if (!['csv', 'txt'].includes(ext)) {
                throw err(422, 'CPS_EXT', 'control points must be .csv/.txt', { expected: ['csv', 'txt'] });
              }
              destName = '_controlpoints.csv';
              cpsName = destName;
            } else if (part.fieldname === 'cfg') {
              // mesh-only: per-mesh simplification config CSV (OptimizerItemLoader)
              if (cfgName) throw err(400, 'TOO_MANY_FILES', 'duplicate file field "cfg"');
              const ext = extOf(sanitizeFileName(part.filename));
              if (!['csv', 'txt'].includes(ext)) {
                throw err(422, 'CFG_EXT', 'config CSV must be .csv/.txt', { expected: ['csv', 'txt'] });
              }
              destName = '_config.csv';
              cfgName = destName;
            } else {
              throw err(400, 'UNKNOWN_FILE_FIELD', `unexpected file field "${part.fieldname}"`,
                { expected: ['file', 'prj', 'cps', 'cfg'] });
            }
            const dest = path.join(stagedDir, destName);
            await pipelineP(part.file, fs.createWriteStream(dest));
            if (fs.statSync(dest).size === 0) throw err(400, 'EMPTY_FILE', `uploaded file is empty: ${destName}`);
          } else if (part.fieldname === 'options') {
            optionsRaw = typeof part.value === 'string'
              ? part.value
              : (await part.toBuffer()).toString('utf8');
          }
        }
        if (!optionsRaw) throw err(400, 'MISSING_OPTIONS', 'multipart field "options" (JSON) is required');
        if (!dirFiles.length) throw err(400, 'MISSING_FILE', 'multipart file field "file" is required');
        options = parseJson(optionsRaw);
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
          throw err(422, 'BAD_OPTIONS', 'options must be a JSON object');
        }

        if (Array.isArray(options.relPaths)) {
          // ---- directory upload (osgb folders): relPaths[i] ↔ i-th `file` part ----
          const rels = options.relPaths.map((r) => String(r).replace(/\\/g, '/')).filter(Boolean);
          if (rels.length !== dirFiles.length) {
            throw err(422, 'REL_PATHS_MISMATCH',
              `relPaths(${rels.length}) must match number of uploaded files(${dirFiles.length})`);
          }
          for (const rel of rels) {
            const segs = rel.split('/');
            if (segs.some((s) => !s || s === '.' || s === '..' || /[:\x00]/.test(s))) {
              throw err(422, 'BAD_REL_PATH', `unsafe relative path "${rel}"`);
            }
          }
          // rebuild the folder tree inside the staged dir
          for (let i = 0; i < dirFiles.length; i++) {
            const dest = path.join(stagedDir, rels[i]);
            await fsp.mkdir(path.dirname(dest), { recursive: true });
            await fsp.rename(path.join(stagedDir, dirFiles[i].seq), dest);
          }
          const dirName = sanitizeFileName(String(options.dirName ?? rels[0].split('/')[0] ?? 'osgb'));
          validateInput(options.type, { name: dirName, kind: 'dir' });
          input = { kind: 'upload-dir', name: dirName, prjName, cpsName, cfgName, stagedDir };
          delete options.relPaths; delete options.dirName;
        } else {
          // ---- single-file upload (osgb also accepts a .zip of the folder) ----
          if (dirFiles.length !== 1) {
            throw err(400, 'TOO_MANY_FILES',
              'expected exactly one file field "file" (or options.relPaths for a directory upload)');
          }
          fileName = dirFiles[0].orig;
          const ext = extOf(fileName);
          if (options.type === 'osgb' && ext === 'zip') {
            // zip upload → stream-extract (bomb-safe) into the staged dir,
            // then treat exactly like a folder upload
            const zipBuf = await fsp.readFile(path.join(stagedDir, dirFiles[0].seq));
            await fsp.rm(path.join(stagedDir, dirFiles[0].seq), { force: true });
            let extracted;
            try {
              extracted = await extractZip(zipBuf, stagedDir, {
                maxEntries: cfg.uploadMaxFiles,
                maxTotalBytes: Math.max(cfg.uploadMaxBytes, 1) * 4,
              });
            } catch (ze) {
              if (ze.code === 'ZIP_BOMB') throw err(400, 'ZIP_BOMB', ze.message);
              throw err(422, 'ZIP_PATH', ze.message);
            }
            if (!extracted.files) throw err(400, 'EMPTY_ZIP', 'zip archive contains no files');
            const dirName = sanitizeFileName(String(options.dirName ?? 'osgb'));
            validateInput(options.type, { name: dirName, kind: 'dir' });
            input = { kind: 'upload-dir', name: dirName, prjName, cpsName, cfgName, stagedDir };
            delete options.dirName;
          } else {
            await fsp.rename(path.join(stagedDir, dirFiles[0].seq), path.join(stagedDir, fileName));
            validateInput(options.type, { name: fileName, kind: 'file' });
            input = { kind: 'upload', name: fileName, prjName, cpsName, cfgName, stagedDir };
          }
        }
      } catch (e) {
        await fsp.rm(stagedDir, { recursive: true, force: true });
        throw e;
      }
    } else if (ct.includes('application/json')) {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw err(422, 'BAD_BODY', 'JSON object required');
      }
      options = { ...req.body };
      const p = options.inputPath;
      delete options.inputPath;
      if (!p) throw err(422, 'INPUT_REQUIRED', 'provide a multipart "file" or JSON "inputPath"');
      const kind = options.type === 'osgb' ? 'dir' : 'file';
      const abs = checkLocalPath(p, cfg, { kind, label: 'inputPath' });
      validateInput(options.type, { name: path.basename(abs), kind });
      input = { kind: 'path', path: abs, name: path.basename(abs) };
    } else {
      throw err(415, 'UNSUPPORTED_MEDIA', 'use multipart/form-data or application/json');
    }

    const parsed = jobSchema.safeParse(options);
    if (!parsed.success) {
      throw err(422, 'VALIDATION', 'invalid job options',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    const params = checkParamPaths(parsed.data, cfg);
    const job = await manager.create({ type: parsed.data.type, params, input });
    return reply.code(201).send(jobDto(job));
  });

  /* ---- list / read ---- */
  app.get('/api/v1/jobs', async (req) => manager.list({
    type: req.query.type, status: req.query.status,
    limit: Number.isFinite(+req.query.limit) && +req.query.limit > 0
      ? Math.min(+req.query.limit, 200) : 50,
    offset: Number.isFinite(+req.query.offset) && +req.query.offset > 0 ? +req.query.offset : 0,
  }));

  app.get('/api/v1/jobs/:id', async (req) => {
    const job = manager.get(req.params.id);
    if (!job) throw err(404, 'NOT_FOUND', 'job not found');
    return jobDto(job, { withParams: true });
  });

  app.get('/api/v1/jobs/:id/artifacts', async (req) => {
    const job = manager.get(req.params.id);
    if (!job) throw err(404, 'NOT_FOUND', 'job not found');
    if (job.status !== 'succeeded') throw err(409, 'NOT_READY', `job is ${job.status}`);
    return { artifacts: job.artifacts, viewerUrl: job.viewerUrl };
  });

  app.get('/api/v1/jobs/:id/log', async (req) => {
    const n = req.query.tail ? Number(req.query.tail) : 200;
    return manager.logTail(req.params.id, n);
  });

  app.post('/api/v1/jobs/:id/cancel', async (req) => {
    await manager.cancel(req.params.id);
    const job = manager.get(req.params.id);
    return jobDto(job);
  });

  app.delete('/api/v1/jobs/:id', async (req, reply) => {
    await manager.remove(req.params.id);
    return reply.code(204).send();
  });

  /* ---- SSE event stream ---- */
  app.get('/api/v1/jobs/:id/events', (req, reply) => {
    const job = manager.get(req.params.id);
    if (!job) throw err(404, 'NOT_FOUND', 'job not found');
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': cfg.corsOrigin,
    });
    const lastSeen = Number(req.headers['last-event-id'] ?? req.query.lastEventId ?? 0) || 0;
    const send = (e) => res.write(
      `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    send({ seq: 0, ts: new Date().toISOString(), type: 'hello',
      status: job.status, progress: job.progress });
    for (const e of job.events) if (e.seq > lastSeen) send(e);
    const onEvent = ({ jobId, evt }) => { if (jobId === job.id && evt.seq > lastSeen) send(evt); };
    manager.on('event', onEvent);
    const hb = setInterval(() => { res.write(': hb\n\n'); }, 15000);
    req.raw.on('close', () => { clearInterval(hb); manager.off('event', onEvent); });
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch {
    throw err(400, 'BAD_JSON', 'options field is not valid JSON');
  }
}

function pipelineP(src, dst) {
  return new Promise((resolve, reject) => {
    src.on('error', reject);
    dst.on('error', reject);
    dst.on('finish', resolve);
    src.pipe(dst);
  });
}
