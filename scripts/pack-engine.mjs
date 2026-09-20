#!/usr/bin/env node
/**
 * Engine bundle packer — the producer side of the download-based install
 * (docs/INSTALLER_DESIGN.md §3 + §6).  Runs on the BUILD machine (CI or dev
 * box) only; clients never execute this.
 *
 *   node scripts/pack-engine.mjs --version 1.0.0 \
 *        [--engine-dir build/bin/linux] [--out dist/mgo-engine-linux-x64.tgz] \
 *        [--proj-data /usr/share/proj] [--gdal-data /usr/share/gdal]
 *
 * Linux: walks the FULL ldd dependency closure of MGOConsole + its side-car
 * .so, copies every non-glibc library next to the binary (the engine already
 * carries RUNPATH $ORIGIN), patchelf's each copied lib to '$ORIGIN' so
 * second-level deps resolve, and adds share/proj + share/gdal.  The result is
 * a flat, self-contained archive: proj.db included, no client-side apt.
 * Windows: DLLs are expected beside the exe already; data dirs are collected
 * the same way and the archive becomes a .zip.
 *
 * Output layout (flat at archive root — matches build/bin/<platform>/):
 *   MGOConsole[.exe] *.so|*.dll share/{proj,gdal}/ manifest.json
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PKG_ROOT, PLATFORM_BIN_DIR } from '../src/config.js';

const execFileP = promisify(execFile);
const p = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };

// glibc itself stays out of the bundle (not relocatable) — but the GCC runtime
// (libstdc++/libgcc_s) IS bundled: it removes the whole "GLIBCXX_x.y.z not
// found" failure class on older distros, and a $ORIGIN copy only affects this
// engine's processes.
const SYSTEM_RUNTIME = new Set(['linux-vdso.so.1', 'ld-linux-x86-64.so.2', 'libc.so.6', 'libm.so.6',
  'libdl.so.2', 'libpthread.so.0', 'librt.so.1', 'libresolv.so.2', 'libnsl.so.2', 'libutil.so.1',
  'libcrypt.so.1']);

/** Parse `ldd` output into {name, resolved} deps.  Exported for tests.
 *  ldd can echo dynamic-string-token search paths ($LIB/…, ${LIB}/…) in the
 *  dependency column — the loadable NAME is only the basename (a real bug this
 *  once caused: copyFile into staging/$LIB/… → ENOENT). */
export function parseLdd(stdout) {
  const deps = [];
  for (const m of stdout.matchAll(/^\s*(\S+)\s+=>\s+(not found|\/\S+).*$/gm)) {
    deps.push({ name: path.basename(m[1]), resolved: m[2].startsWith('/') ? m[2] : null });
  }
  return deps;
}

async function ldd(file) {
  const { stdout } = await execFileP('ldd', [file], { timeout: 20000 });
  return parseLdd(stdout);
}

async function sha256(file) {
  const h = createHash('sha256');
  return new Promise((res, rej) => fs.createReadStream(file)
    .on('data', (d) => h.update(d)).on('error', rej).on('end', () => res(h.digest('hex'))));
}

async function main() {
  const version = p('--version') ?? '0.0.0-local';
  const engineDir = path.resolve(p('--engine-dir') ?? path.join(PKG_ROOT, 'build', 'bin', PLATFORM_BIN_DIR));
  const outExt = process.platform === 'win32' ? '.zip' : '.tgz';
  const out = path.resolve(p('--out') ?? path.join(PKG_ROOT, 'dist', `mgo-engine-${process.platform}-${process.arch}${outExt}`));
  const projData = p('--proj-data') ?? '/usr/share/proj';
  const gdalData = p('--gdal-data') ?? '/usr/share/gdal';
  const binName = process.platform === 'win32' ? 'MGOConsole.exe' : 'MGOConsole';
  const binary = path.join(engineDir, binName);

  if (!fs.existsSync(binary)) { console.error(`engine binary not found: ${binary}`); process.exit(1); }

  // 1 ── staging = copy of the engine dir (source is never mutated)
  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'mgo-pack-'));
  for (const n of await fsp.readdir(engineDir)) {
    await fsp.cp(path.join(engineDir, n), path.join(staging, n), { recursive: true, dereference: true });
  }
  const say = (...a) => console.log('[pack]', ...a);
  say(`staging ${engineDir} → ${staging}`);

  // 2 ── ldd closure: copy every missing non-glibc lib next to the binary
  if (process.platform === 'linux') {
    const copied = new Set();
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of (await fsp.readdir(staging)).filter((n) => n === binName || /\.so(\.\d+)*$/.test(n))) {
        const file = path.join(staging, f);
        let deps;
        try { deps = await ldd(file); } catch { continue; } // not ELF / script
        for (const d of deps) {
          if (!d.resolved || SYSTEM_RUNTIME.has(d.name) || copied.has(d.name)) continue;
          const target = path.join(staging, d.name);
          if (fs.existsSync(target)) continue;
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.copyFile(d.resolved, target);
          copied.add(d.name);
          grew = true;
          say(`  + lib ${d.name}  ←  ${d.resolved}`);
        }
      }
    }
    if (copied.size === 0) say('no additional system libraries needed');
    // Normalize RUNPATH on EVERY staged ELF (engine binary + side-car .so +
    // copied system libs).  Two reasons: (a) each copied lib must resolve its
    // own deps through $ORIGIN; (b) engine side-car .so built with absolute
    // build-machine RPATHs (/…/MGO/build) would bypass the bundle entirely —
    // patchelf-ing them to $ORIGIN is what makes the directory truly movable.
    for (const f of await fsp.readdir(staging)) {
      if (!/\.so(\.\d+)*$/.test(f) && f !== binName) continue;
      try {
        await execFileP('patchelf', ['--set-rpath', '$ORIGIN', path.join(staging, f)]);
      } catch (e) { say(`  ! patchelf skipped for ${f}: ${e.message.split('\n')[0]}`); }
    }
    say(`runpath normalized to $ORIGIN on all staged ELFs`);
  } else {
    say('windows mode: assuming all DLLs already sit beside the exe');
  }

  // 3 ── projection / GDAL data (the proj.db the user asked about)
  for (const [src, rel] of [[projData, 'share/proj'], [gdalData, 'share/gdal']]) {
    if (src && fs.existsSync(src)) {
      await fsp.cp(src, path.join(staging, rel), { recursive: true });
      say(`  + data ${rel}  ←  ${src}`);
    } else {
      console.warn(`[pack] WARN data source missing: ${src} (${rel} will be absent)`);
    }
  }

  // 4 ── fixpoint check: nothing unresolved anywhere
  if (process.platform === 'linux') {
    const stillMissing = [];
    for (const f of (await fsp.readdir(staging)).filter((n) => n === binName || /\.so(\.\d+)*$/.test(n))) {
      try { for (const d of await ldd(path.join(staging, f))) if (!d.resolved) stillMissing.push(`${f}: ${d.name}`); } catch { /* skip */ }
    }
    if (stillMissing.length) {
      console.error('[pack] FAIL unresolved after closure:\n  ' + stillMissing.join('\n  '));
      process.exit(1);
    }
    say(`closure complete: ${await fsp.readdir(staging).then((a) => a.length)} files, zero unresolved`);
  }

  // 5 ── manifest (client setup.mjs + doctor.mjs read version/glibc from it)
  let glibc = null;
  try {
    const { stdout } = await execFileP('ldd', ['--version']);
    glibc = /(\d+\.\d+)/.exec(stdout.split('\n')[0])?.[1] ?? null;
  } catch { /* windows */ }
  const files = {};
  for (const n of await fsp.readdir(staging)) {
    const st = await fsp.stat(path.join(staging, n));
    if (st.isFile()) files[n] = await sha256(path.join(staging, n));
  }
  await fsp.writeFile(path.join(staging, 'manifest.json'), JSON.stringify({
    version, platform: process.platform, arch: process.arch, glibc, files,
    packedAt: new Date().toISOString(),
  }, null, 2));

  // 6 ── archive (flat root: tar -C staging .)
  await fsp.mkdir(path.dirname(out), { recursive: true });
  if (out.endsWith('.zip')) {
    try { await execFileP('zip', ['-rq', out, '.'], { cwd: staging }); }
    catch { await execFileP('tar', ['-a', '-cf', out, '.'], { cwd: staging }); } // bsdtar (Windows)
  } else {
    await execFileP('tar', ['-czf', out, '.'], { cwd: staging });
  }

  const sizeMb = ((await fsp.stat(out)).size / 1024 ** 2).toFixed(1);
  const hash = await sha256(out);
  say(`bundle  ${out}  (${sizeMb} MB)`);
  say(`sha256  ${hash}`);
  say('next: upload to the GitHub release `engine-v' + version + '` and pin the hash in');
  say('package.json mgoEngine.downloads["' + process.platform + '-' + process.arch + '"].sha256');
  await fsp.rm(staging, { recursive: true, force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[pack] crashed:', e?.stack ?? e); process.exit(1); });
}
