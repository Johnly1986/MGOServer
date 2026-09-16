import { execFile } from 'node:child_process';
import { withEngineEnv } from './engine-env.js';

/**
 * Startup probe of the mgo binary: version + compiled-in capabilities.
 * `mgo help` only lists `osgb` when the binary was built with OSG
 * (HAS_OSGB_CONVERTER) — see design F9.
 */
export async function probeMgo(binary) {
  const info = { path: binary, found: false, version: null, hasOsgb: false, hasBim: false };
  const run = (args) => new Promise((res) => {
    const timer = setTimeout(() => res({ err: new Error('probe timeout'), out: '' }), 8000);
    // withEngineEnv: a self-contained engine bundle (build/bin/<plat>/share/…)
    // brings its own proj.db/gdal-data; see src/engine-env.js
    execFile(binary, args, { timeout: 8000, env: withEngineEnv(binary) }, (err, stdout) => {
      clearTimeout(timer);
      res({ err, out: String(stdout ?? '') });
    });
  });

  const v = await run(['version']);
  if (!v.err && v.out) {
    info.found = true;
    const m = /MGO v([\w.+-]+)/.exec(v.out);
    info.version = m ? m[1] : 'unknown';
  }
  const h = await run(['help']);
  if (/\bosgb\b/.test(h.out || '')) info.hasOsgb = true;
  // TilesConverter property binding: only binaries from the --bim-* era list
  // the flags in `tiles --help`.  An older engine would reject them (exit 2),
  // so the console must not offer what the service cannot honour.
  const t = await run(['tiles', '--help']);
  if (/--bim-bind/.test(t.out || '')) info.hasBim = true;
  return info;
}
