import path from 'node:path';
import fs from 'node:fs';

/**
 * Server-side absolute-path access control for inputPath / prjPath /
 * controlPointsPath / configCsvPath.  Allowed ONLY when the feature is
 * enabled and the resolved path sits inside MGO_ALLOWED_ROOTS.
 */
export function checkLocalPath(raw, cfg, { kind = 'file', label = 'path' } = {}) {
  if (!cfg.allowLocalPath) {
    throw Object.assign(new Error('server-local paths are disabled (set MGO_ALLOW_LOCAL_PATH=1)'),
      { statusCode: 403 });
  }
  if (!cfg.allowedRoots.length) {
    throw Object.assign(new Error('MGO_ALLOWED_ROOTS is not configured'), { statusCode: 403 });
  }
  let abs;
  try { abs = path.resolve(raw); } catch {
    throw Object.assign(new Error(`invalid ${label}`), { statusCode: 400 });
  }
  const roots = cfg.allowedRoots.map((r) => {
    const real = fs.realpathSync(r);
    return real.endsWith(path.sep) ? real : real + path.sep;
  });
  let real;
  try { real = fs.realpathSync(abs); } catch {
    throw Object.assign(new Error(`${label} does not exist: ${abs}`), { statusCode: 400 });
  }
  if (!roots.some((r) => (real + path.sep).startsWith(r) || real === r.slice(0, -1))) {
    throw Object.assign(new Error(`${label} outside allowed roots`), { statusCode: 403 });
  }
  const st = fs.statSync(real);
  if (kind === 'file' && !st.isFile()) {
    throw Object.assign(new Error(`${label} is not a file`), { statusCode: 400 });
  }
  if (kind === 'dir' && !st.isDirectory()) {
    throw Object.assign(new Error(`${label} is not a directory`), { statusCode: 400 });
  }
  return real;
}

/** Recursively validate every *Path string inside job params. */
export function checkParamPaths(params, cfg) {
  const out = { ...params };
  const visit = (obj) => {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && /Path$/.test(k)) {
        obj[k] = checkLocalPath(v, cfg, { kind: 'file', label: k });
      } else if (v && typeof v === 'object') visit(v);
    }
  };
  visit(out);
  return out;
}

/** Safe basename only: strips directories, null bytes and control chars. */
export function sanitizeFileName(name) {
  const base = path.basename(String(name ?? '').replace(/\0/g, ''));
  const cleaned = [...base].filter((c) => c.codePointAt(0) >= 0x20 && c.codePointAt(0) !== 0x7f).join('');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw Object.assign(new Error('invalid file name'), { statusCode: 400 });
  }
  return cleaned.slice(-240); // keep extension readable for very long names
}

export function extOf(name) {
  return path.extname(String(name ?? '')).replace(/^\./, '').toLowerCase();
}
