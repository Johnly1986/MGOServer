import fs from 'node:fs';
import path from 'node:path';

/**
 * Engine data directories, two supported layouts:
 *   • pack-engine.mjs self-contained bundle: <dir>/share/proj, <dir>/share/gdal
 *   • MGO Release vcpkg export (win-x64 zip): proj.db beside the exe,
 *     GDAL data in <dir>/gdaldata
 * Whatever matches is injected at spawn; nothing found → no injection, so a
 * host with system proj-data/gdal-data (or user-set PROJ_DATA) keeps its
 * current behaviour — the engine data can only be ADDED, never shadowed.
 */
const PROJ_ALTERNATIVES = [
  { kind: 'dir', rel: path.join('share', 'proj') },          // needs proj.db inside
  { kind: 'rootprojdb', rel: '' },                            // proj.db sits beside the exe
];
const GDAL_ALTERNATIVES = [
  { kind: 'dir', rel: path.join('share', 'gdal') },
  { kind: 'dir', rel: 'gdaldata' },                           // vcpkg export layout
];

function firstMatch(dir, alternatives) {
  for (const a of alternatives) {
    const p = a.kind === 'rootprojdb' ? dir : path.join(dir, a.rel);
    try {
      if (a.kind === 'rootprojdb') {
        if (fs.existsSync(path.join(dir, 'proj.db'))) return p;
      } else if (fs.statSync(p).isDirectory()) {
        return p;
      }
    } catch { /* absent → try next */ }
  }
  return null;
}

/** Env additions for the dir containing `binaryPath`, or {} when none ship data. */
export function engineEnv(binaryPath) {
  if (!binaryPath) return {};
  const dir = path.dirname(path.resolve(String(binaryPath)));
  const extra = {};
  const proj = firstMatch(dir, PROJ_ALTERNATIVES);
  if (proj) { extra.PROJ_DATA = proj; extra.PROJ_LIB = proj; }
  const gdal = firstMatch(dir, GDAL_ALTERNATIVES);
  if (gdal) extra.GDAL_DATA = gdal;
  return extra;
}

/** `process.env` merged with the engine's bundled data dirs (bundle wins only
 *  for vars the user did not already set — keep user env authoritative). */
export function withEngineEnv(binaryPath, base = process.env) {
  const extra = engineEnv(binaryPath);
  const merged = { ...base };
  for (const n of Object.keys(extra)) {
    if (merged[n] === undefined || merged[n] === '') merged[n] = extra[n];
  }
  return merged;
}
