import { execFile } from 'node:child_process';

/**
 * Startup probe of the mgo binary: version + compiled-in capabilities.
 * `mgo help` only lists `osgb` when the binary was built with OSG
 * (HAS_OSGB_CONVERTER) — see design F9.
 */
export async function probeMgo(binary) {
  const info = { path: binary, found: false, version: null, hasOsgb: false };
  const run = (args) => new Promise((res) => {
    const timer = setTimeout(() => res({ err: new Error('probe timeout'), out: '' }), 8000);
    execFile(binary, args, { timeout: 8000 }, (err, stdout) => {
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
  return info;
}
