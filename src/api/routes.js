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

/** Pick a collision-free upload name: model.fbx + model.fbx → model.fbx, model_2.fbx */
function uniqueName(taken, orig) {
  if (!taken.includes(orig)) return orig;
  const ext = path.extname(orig);
  const stem = orig.slice(0, orig.length - ext.length) || 'file';
  let i = 2; let cand;
  do { cand = `${stem}_${i++}${ext}`; } while (taken.includes(cand));
  return cand;
}

/** Sorted relative file list of a directory tree (zip / local-tree inventory). */
async function listTree(dir, cap, label = 'uploaded tree') {
  const out = [];
  const walk = async (d, prefix) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      if (out.length >= cap) {
        throw err(400, 'TOO_MANY_FILES',
          `more than ${cap} files in the ${label} — point at the model's own folder, or pass the model file(s) directly`);
      }
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  await walk(dir, '');
  return out.sort();
}

/* Job types that may arrive as a FILE TREE (model + side-car textures).  The
 * engine resolves external textures relative to the model's own directory,
 * so uploads must keep the original layout — moving only root.fbx into the
 * job input dir silently drops every side-car image (assimp then embeds a
 * 70-byte 1×1 placeholder PNG). */
const TREE_TYPES = new Set(['tiles', 'mesh']);

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
      maxInputFiles: cfg.maxInputFiles,
      jobTimeoutS: cfg.jobTimeoutS,
      ttlDays: cfg.ttlDays,
    },
    features: {
      osgb: mgo.hasOsgb,
      localPathInput: cfg.allowLocalPath,
      fsBrowse: cfg.allowLocalPath,
      multiFileTiles: Boolean(cfg.tilesToolsCli),
      authMode: 'ip-whitelist',
    },
    client: {
      ip: normalizeIp(req.ip),
      allowed: cfg.isAllowedIp(req.ip),
      canManageWhitelist: BUILTIN_LOCAL.includes(normalizeIp(req.ip)),
    },
    cesium: { version: '1.111', selfHosted: cesiumLocal },
  }));

  /* ---- server file browser (console "服务器路径" mode) ----
   * POST on purpose: the preHandler write-gate (IP whitelist) applies, so
   * directory enumeration is only reachable by clients allowed to submit jobs
   * anyway.  Listing stays strictly inside MGO_ALLOWED_ROOTS (realpath-based,
   * same containment rules as checkLocalPath); dotfiles hidden. */
  app.post('/api/v1/fs/browse', async (req) => {
    if (!cfg.allowLocalPath) {
      throw err(403, 'LOCAL_PATH_DISABLED',
        'server-local paths are disabled — set MGO_ALLOW_LOCAL_PATH=1 to browse/submit local inputs');
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const raw = typeof body.path === 'string' ? body.path.trim() : '';
    const rootReals = [];
    const roots = cfg.allowedRoots.map((r) => {
      try {
        const rp = fs.realpathSync(r);
        rootReals.push(rp);
        return { path: rp, name: path.basename(rp) || rp, ok: true };
      } catch { return { path: r, name: path.basename(r) || r, ok: false }; }
    });
    if (!raw) return { roots, cwd: null, dirs: [], files: [], parent: null };
    const dir = checkLocalPath(raw, cfg, { kind: 'dir', label: 'path' });
    const CAP = 1000;
    const dirs = []; const files = [];
    let truncated = false;
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') && body.showHidden !== true) continue;
      if (e.isDirectory()) {
        if (dirs.length < CAP) dirs.push(e.name); else truncated = true;
      } else if (e.isFile()) {
        if (files.length >= CAP) { truncated = true; continue; }
        let size = null;
        try { size = fs.statSync(path.join(dir, e.name)).size; } catch { /* raced away */ }
        files.push({ name: e.name, size });
      }
    }
    dirs.sort((a, b) => a.localeCompare(b, 'zh'));
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    // offer "up" only while the parent still sits inside an allowed root
    const parent = path.dirname(dir);
    const insideRoot = rootReals.some((rr) => parent === rr || (parent + path.sep).startsWith(rr + path.sep));
    return { roots, cwd: dir, parent: insideRoot && parent !== dir ? parent : null, dirs, files, truncated };
  });

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

  /**
   * Which model(s) inside an uploaded file tree (relPaths or ZIP) feed the
   * converter.  options.modelPath (one, or comma-separated) / modelPaths
   * (array) narrow the choice explicitly; otherwise tiles auto-takes EVERY
   * model in the tree (converted with uniform params, then merged), while
   * mesh — single-model by nature — requires exactly one candidate or an
   * explicit modelPath (textures and other side-cars are expected around it).
   */
  function resolveTreeModels(type, rels, options) {
    const explicit = options.modelPaths ?? options.modelPath;
    delete options.modelPaths; delete options.modelPath;
    const exts = INPUT_EXT[type];
    const isModel = (r) => exts.includes(extOf(r));
    let picked;
    if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
      const want = (Array.isArray(explicit) ? explicit : String(explicit).split(','))
        .map((w) => String(w).trim().replace(/\\/g, '/')).filter(Boolean);
      for (const w of want) {
        if (!rels.includes(w)) {
          throw err(422, 'MODEL_NOT_IN_TREE', `modelPath "${w}" is not part of the uploaded tree`,
            { hint: 'path is relative to the uploaded folder / zip root' });
        }
        if (!isModel(w)) {
          throw err(422, 'INPUT_EXT', `modelPath "${w}" is not a ${type} model file`, { expected: exts });
        }
      }
      picked = [...new Set(want)];
    } else {
      const cands = rels.filter(isModel);
      if (!cands.length) {
        throw err(422, 'NO_MODEL_IN_TREE',
          `the uploaded files contain no ${type} model (${exts.join('/')}) — the model must be part of the tree`,
          { files: rels.slice(0, 30) });
      }
      if (cands.length > 1 && type !== 'tiles') {
        throw err(422, 'MODEL_AMBIGUOUS',
          `${cands.length} candidate models in the upload — pick with modelPath/modelPaths`,
          { candidates: cands.slice(0, 20) });
      }
      // tiles: several candidates → convert them ALL with uniform params, then merge
      picked = cands;
    }
    if (type === 'mesh' && picked.length > 1) {
      throw err(422, 'MODEL_AMBIGUOUS', 'mesh converts one model at a time — set a single modelPath');
    }
    if (picked.length > cfg.maxInputFiles) {
      throw err(400, 'TOO_MANY_INPUT_FILES', `more than ${cfg.maxInputFiles} models (MGO_MAX_INPUT_FILES)`);
    }
    return picked;
  }

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

        // ---- tree channels: relPaths folder upload, or one ZIP that extracts
        // to a directory tree (keeps FBX/OBJ side-car textures resolvable) ----
        let rels = null;
        if (Array.isArray(options.relPaths)) {
          if (options.type !== 'osgb' && !TREE_TYPES.has(options.type)) {
            throw err(400, 'INPUT_TYPE',
              'relPaths folder uploads are supported for osgb (whole folder) and tiles/mesh (model + textures)');
          }
          // relPaths[i] ↔ i-th `file` part (browser folder picker)
          const relParts = options.relPaths.map((r) => String(r).replace(/\\/g, '/')).filter(Boolean);
          delete options.relPaths;
          if (relParts.length !== dirFiles.length) {
            throw err(422, 'REL_PATHS_MISMATCH',
              `relPaths(${relParts.length}) must match number of uploaded files(${dirFiles.length})`);
          }
          for (const rel of relParts) {
            const segs = rel.split('/');
            if (segs.some((s) => !s || s === '.' || s === '..' || /[:\x00]/.test(s))) {
              throw err(422, 'BAD_REL_PATH', `unsafe relative path "${rel}"`);
            }
          }
          // rebuild the folder tree inside the staged dir
          for (let i = 0; i < dirFiles.length; i++) {
            const dest = path.join(stagedDir, relParts[i]);
            await fsp.mkdir(path.dirname(dest), { recursive: true });
            await fsp.rename(path.join(stagedDir, dirFiles[i].seq), dest);
          }
          rels = relParts;
        } else if (dirFiles.length === 1 && TREE_TYPES.has(options.type)
          && extOf(dirFiles[0].orig) === 'zip') {
          const zipBuf = await fsp.readFile(path.join(stagedDir, dirFiles[0].seq));
          await fsp.rm(path.join(stagedDir, dirFiles[0].seq), { force: true });
          try {
            const extracted = await extractZip(zipBuf, stagedDir, {
              maxEntries: cfg.uploadMaxFiles,
              maxTotalBytes: Math.max(cfg.uploadMaxBytes, 1) * 4,
            });
            if (!extracted.files) throw err(400, 'EMPTY_ZIP', 'zip archive contains no files');
          } catch (ze) {
            if (ze.code === 'ZIP_BOMB') throw err(400, 'ZIP_BOMB', ze.message);
            if (ze.statusCode) throw ze;
            throw err(422, 'ZIP_PATH', ze.message);
          }
          rels = await listTree(stagedDir, cfg.uploadMaxFiles);
        }

        if (rels) {
          if (options.type === 'osgb') {
            const dirName = sanitizeFileName(String(options.dirName ?? rels[0].split('/')[0] ?? 'osgb'));
            delete options.dirName;
            validateInput(options.type, { name: dirName, kind: 'dir' });
            input = { kind: 'upload-dir', name: dirName, prjName, cpsName, cfgName, stagedDir };
          } else {
            if (options.dirName) throw err(422, 'BAD_OPTIONS', 'dirName is only valid for osgb uploads');
            const models = resolveTreeModels(options.type, rels, options);
            input = {
              kind: 'upload-tree', models,
              name: models[0], ...(models.length > 1 ? { names: models } : {}),
              prjName, cpsName, cfgName, stagedDir,
            };
          }
        } else {
          // ---- flat file upload(s): one file for every type; `tiles` also
          // accepts several `file` parts — all converted with the SAME options
          // params, then merged into one unified tileset.json (3d-tiles-tools) ----
          if (dirFiles.length > 1 && options.type !== 'tiles') {
            throw err(400, 'TOO_MANY_FILES',
              'expected exactly one file field "file" (multi-file upload is tiles-only; for a folder use options.relPaths)');
          }
          if (dirFiles.length > cfg.maxInputFiles) {
            throw err(400, 'TOO_MANY_INPUT_FILES',
              `more than ${cfg.maxInputFiles} input files (MGO_MAX_INPUT_FILES)`);
          }
          if (dirFiles.length > 1 && options.dirName) {
            throw err(422, 'BAD_OPTIONS', 'dirName is only valid for directory/zip uploads');
          }
          const names = [];
          for (const df of dirFiles) {
            const nm = uniqueName(names, df.orig);
            if (dirFiles.length === 1 && options.type === 'osgb' && extOf(nm) === 'zip') {
              // osgb zip upload → stream-extract (bomb-safe) into the staged
              // dir, then treat exactly like a folder upload
              const zipBuf = await fsp.readFile(path.join(stagedDir, df.seq));
              await fsp.rm(path.join(stagedDir, df.seq), { force: true });
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
              break;
            }
            await fsp.rename(path.join(stagedDir, df.seq), path.join(stagedDir, nm));
            validateInput(options.type, { name: nm, kind: 'file' });
            names.push(nm);
          }
          if (!input) {
            if (names.length > 1) {
              input = { kind: 'upload', name: names[0], names, prjName, cpsName, cfgName, stagedDir };
            } else {
              fileName = names[0];
              input = { kind: 'upload', name: fileName, prjName, cpsName, cfgName, stagedDir };
            }
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
      const ps = options.inputPaths;
      delete options.inputPaths;
      const kind = options.type === 'osgb' ? 'dir' : 'file';
      let paths;
      if (Array.isArray(ps)) {
        if (options.type !== 'tiles') {
          throw err(400, 'INPUT_TYPE', 'inputPaths (multi-file) is only supported for type "tiles"');
        }
        if (!ps.length) throw err(422, 'INPUT_REQUIRED', 'inputPaths must list at least one file');
        if (ps.length > cfg.maxInputFiles) {
          throw err(400, 'TOO_MANY_INPUT_FILES',
            `more than ${cfg.maxInputFiles} input files (MGO_MAX_INPUT_FILES)`);
        }
        paths = ps;
      } else if (p) {
        // single inputPath — a file (any type) or, for tiles/mesh, a local
        // model+textures DIRECTORY.  Local inputs are ALWAYS processed in
        // place: nothing is moved or copied (package+extract is the remote
        // upload channel's job, not the local one's).
        const isLocalDir = TREE_TYPES.has(options.type)
          && fs.existsSync(path.resolve(p)) && fs.statSync(path.resolve(p)).isDirectory();
        if (isLocalDir) {
          const root = checkLocalPath(p, cfg, { kind: 'dir', label: 'inputPath' });
          const rels = await listTree(root, cfg.uploadMaxFiles, 'local model folder');
          const models = resolveTreeModels(options.type, rels, options); // consumes modelPath(s)
          input = {
            kind: 'path',
            paths: models.map((m) => path.join(root, m)),
            path: path.join(root, models[0]),
            names: models,
            name: models[0],
            root,
          };
          paths = null;
        } else {
          paths = [p];
        }
      } else {
        throw err(422, 'INPUT_REQUIRED', 'provide a multipart "file" or JSON "inputPath"/"inputPaths"');
      }
      if (paths) {
        const abs = paths.map((x) => checkLocalPath(x, cfg, { kind, label: 'inputPath' }));
        for (const a of abs) validateInput(options.type, { name: path.basename(a), kind });
        if (abs.length > 1) {
          input = {
            kind: 'path',
            paths: abs,
            path: abs[0],
            names: abs.map((a) => path.basename(a)),
            name: path.basename(abs[0]),
          };
        } else {
          input = { kind: 'path', path: abs[0], name: path.basename(abs[0]) };
        }
      }
    } else {
      throw err(415, 'UNSUPPORTED_MEDIA', 'use multipart/form-data or application/json');
    }

    if ('modelPath' in options || 'modelPaths' in options) {
      throw err(422, 'BAD_OPTIONS',
        'modelPath/modelPaths is only valid for model trees (options.relPaths upload, model+textures ZIP, or a local inputPath folder)');
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
