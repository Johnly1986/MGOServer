#!/usr/bin/env node
/**
 * Engine installer — the npm-lifecycle entry that makes `npm ci` the single
 * install command on every platform (docs/INSTALLER_DESIGN.md §4).
 *
 * Client machines NEVER build anything here: the installer only fetches a
 * prebuilt, self-contained engine bundle from pre-configured addresses
 * (package.json "mgoEngine.downloads" + env overrides), verifies it, unpacks
 * it into build/bin/<platform>/ and probes the result.
 *
 * Resolution order (first hit wins, fully idempotent):
 *   0. MGO_ENGINE_SKIP=1            → skip everything
 *   1. MGO_BINARY set               → user manages their own engine
 *   2. engine already in dest       → keep it (this is the git-bundled path)
 *                                      unless --force
 *   3. MGO_ENGINE_BUNDLE=<file>     → offline install from a local bundle
 *   4. MGO_ENGINE_URL=<url>         → explicit pre-configured download address
 *   5. package.json mgoEngine.downloads["<platform>-<arch>"] → url + mirrors,
 *      each optionally rewritten by MGO_ENGINE_MIRROR (a '{url}' template or
 *      a plain base prefix — for regions where the default host is slow)
 *
 * Bundle layout (produced by scripts/pack-engine.mjs, flat at archive root):
 *   MGOConsole[.exe] + side-car libs + share/proj (proj.db) + share/gdal
 *   + manifest.json {version, platform, arch, glibc, files{sha256}}
 *
 * Supported archives: .tgz (system tar, preserves +x) and .zip (yauzl).
 * Integrity: sha256 from the manifest entry, else from "<url>.sha256" sidecar;
 * without either the install proceeds but says so loudly.
 *
 * Exit codes: 0 = installed or deliberately skipped; 1 = a supported platform
 * is left without a working engine (fail fast — the service would be useless).
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yauzl from 'yauzl';
import { probeMgo } from '../src/mgo.js';
import { engineEnv } from '../src/engine-env.js';

const execFileP = promisify(execFile);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── tiny log helpers (postinstall output must stay readable) ────────────────
const say = (...a) => console.log(...a);
const warn = (...a) => console.error('⚠ ', ...a);

// ── platform identity ────────────────────────────────────────────────────────
export const platformKey = `${process.platform}-${process.arch}`;
export const platformDir = process.platform === 'win32' ? 'windows' : 'linux';
export const binaryName = process.platform === 'win32' ? 'MGOConsole.exe' : 'MGOConsole';

export function compareVersions(a, b) {
  const pa = String(a ?? '').split(/[.+-]/).map((x) => parseInt(x, 10));
  const pb = String(b ?? '').split(/[.+-]/).map((x) => parseInt(x, 10));
  for (let i = 0; i < 4; i += 1) {
    const d = (Number.isFinite(pa[i]) ? pa[i] : 0) - (Number.isFinite(pb[i]) ? pb[i] : 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

// ── configuration ────────────────────────────────────────────────────────────
export function loadEngineManifest(pkgRoot = PKG_ROOT) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
    return pkg.mgoEngine ?? null;
  } catch { return null; }
}

/** sha256 of a file, streamed (bundles are ~60 MB). */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** MGO_ENGINE_MIRROR rewriting: '{url}' template (raw URL), else plain base prefix. */
export function applyMirror(mirror, url) {
  if (!mirror) return url;
  return mirror.includes('{url}')
    ? mirror.replace('{url}', url)
    : `${mirror.replace(/\/+$/, '')}/${url}`;
}

/** Candidate download URLs for a manifest entry, in attempt order. */
export function candidateUrls(entry, { urlEnv, mirrorEnv } = {}) {
  const base = urlEnv || entry?.url;
  if (!base) return [];
  const list = [base, ...(entry?.mirrors ?? [])];
  return mirrorEnv ? [...list, ...list.map((u) => applyMirror(mirrorEnv, u))] : list;
}

// ── download ─────────────────────────────────────────────────────────────────
async function downloadTo(url, destFile, timeoutMs) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destFile));
  return destFile;
}

/** sha256 expected for a candidate: manifest value first, else URL sidecar.
 *  Exported for tests. */
export async function expectedSha256(entry, url) {
  if (entry?.sha256) return { sha256: entry.sha256, source: 'manifest' };
  try {
    const res = await fetch(`${url}.sha256`, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
    if (res.ok) {
      const txt = (await res.text()).trim().split(/\s+/)[0];
      if (/^[0-9a-f]{64}$/i.test(txt)) return { sha256: txt, source: 'sidecar' };
    }
  } catch { /* no sidecar — fall through */ }
  return { sha256: null, source: 'none' };
}

// ── extraction ───────────────────────────────────────────────────────────────
async function extractTar(file, dest) {
  // GNU tar (Linux) and Windows 10+' bsdtar both auto-detect gzip on -xf and
  // preserve the exec bits the bundle was packed with.
  const { stderr } = await execFileP('tar', ['-xf', file, '-C', dest], { windowsHide: true });
  if (stderr && /error|cannot/i.test(stderr)) throw new Error(stderr.trim());
}

async function extractZip(file, dest) {
  await new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        // zip-slip guard: every entry must stay inside dest
        const target = path.resolve(dest, entry.fileName);
        if (!target.startsWith(path.resolve(dest) + path.sep) && target !== path.resolve(dest)) {
          return reject(new Error(`zip entry escapes destination: ${entry.fileName}`));
        }
        if (entry.fileName.endsWith('/')) {
          return fsp.mkdir(target, { recursive: true })
            .then(() => zip.readEntry()).catch(reject);
        }
        zip.openReadStream(entry, (e2, rs) => {
          if (e2) return reject(e2);
          fsp.mkdir(path.dirname(target), { recursive: true })
            .then(() => pipeline(rs, fs.createWriteStream(target)))
            .then(() => zip.readEntry()).catch(reject);
        });
      });
      zip.on('end', resolve);
      zip.readEntry();
    });
  });
}

/** Bundles may carry one wrapping directory; flatten it if so. */
async function flattenSingleRoot(dir) {
  const entries = (await fsp.readdir(dir)).filter((n) => !n.startsWith('.'));
  if (entries.length !== 1) return;
  const inner = path.join(dir, entries[0]);
  if (!(await fsp.stat(inner)).isDirectory()) return;
  for (const name of await fsp.readdir(inner)) {
    await fsp.rename(path.join(inner, name), path.join(dir, name));
  }
  await fsp.rmdir(inner);
}

// ── probe + report ───────────────────────────────────────────────────────────
async function report(binary, dest) {
  const info = await probeMgo(binary);
  // data-dir detection MUST agree with the runtime (src/engine-env.js) by
  // construction: same helper, both layouts (share/… bundle, vcpkg-flat release)
  const envAdd = engineEnv(binary);
  const manifestPath = path.join(dest, 'manifest.json');
  let bundleVersion = '(no manifest)';
  try { bundleVersion = JSON.parse(await fsp.readFile(manifestPath, 'utf8')).version ?? bundleVersion; } catch { /* ok */ }
  say('  engine      ', info.found
    ? `${binary} → MGO ${info.version}  osgb=${info.hasOsgb ? '✓' : '✗'} bim=${info.hasBim ? '✓' : '✗'}`
    : `${binary} → probe FAILED (see doctor)`);
  say('  bundle      ', `version ${bundleVersion}`);
  say('  proj data   ', envAdd.PROJ_DATA ? `${envAdd.PROJ_DATA} ✓ (PROJ_DATA injected)` : 'not bundled (system proj-data expected)');
  say('  gdal data   ', envAdd.GDAL_DATA ? `${envAdd.GDAL_DATA} ✓ (GDAL_DATA injected)` : 'not bundled (system gdal-data expected)');
  return info;
}

// ── main ─────────────────────────────────────────────────────────────────────
export async function setup(argv = process.argv.slice(2), env = process.env, pkgRoot = PKG_ROOT) {
  const force = argv.includes('--force');
  const destIdx = argv.indexOf('--dest');
  if (destIdx >= 0 && !argv[destIdx + 1]) {
    warn('--dest needs a directory argument');
    return process.exitCode = 1;
  }
  const dest = path.resolve(destIdx >= 0 ? argv[destIdx + 1] : (env.MGO_ENGINE_DEST
    || path.join(pkgRoot, 'build', 'bin', platformDir)));

  const manifest = loadEngineManifest(pkgRoot);
  // the release tag and the version string the binary prints CAN diverge
  // (they did before upstream v0.8.0 synced them) — compare against what
  // the binary is EXPECTED to report, not the tag
  const expectReports = manifest?.reportsVersion ?? manifest?.version ?? null;
  const binary = path.join(dest, binaryName);

  say('== mgo engine setup ==');
  say('  platform    ', `${platformKey} → ${path.relative(pkgRoot, dest) || dest}`);

  if (env.MGO_ENGINE_SKIP === '1') { say('  skipped     MGO_ENGINE_SKIP=1'); return { skipped: 'env' }; }
  if (env.MGO_BINARY) { say('  skipped     MGO_BINARY is set (self-managed engine):', env.MGO_BINARY); return { skipped: 'MGO_BINARY' }; }
  if (!force && fs.existsSync(binary)) {
    say('  skipped     engine already present (', binary, ') — npm run engine:update to refresh');
    await report(binary, dest);
    return { skipped: 'present' };
  }
  if (force && fs.existsSync(dest)) {
    // replacing the engine: wipe the directory so an old engine's side-car
    // libs can never mix with the new binary (version skew = subtle breakage).
    // Guard against a misconfigured --dest/MGO_ENGINE_DEST pointing at "/" or
    // $HOME or the repo root, or at any non-empty directory that does not look
    // like an engine dir (no MGOConsole inside) — refuse, never wipe blind.
    const guarded = [path.resolve('/'), path.resolve(os.homedir() || '/'), path.resolve(pkgRoot)];
    const looksLikeEngineDir = fs.existsSync(binary)
      || (await fsp.readdir(dest).then((n) => n.length === 0).catch(() => false));
    if (guarded.includes(path.resolve(dest)) || !looksLikeEngineDir) {
      warn(`--force refuses to wipe ${dest}: not recognizably an engine directory`
        + ' (no MGOConsole inside, or a guarded path)');
      return process.exitCode = 1;
    }
    say('  replacing   clearing', dest);
    await fsp.rm(dest, { recursive: true, force: true });
  }
  // 3. offline bundle wins over everything remote — and works even without a
  //    pre-configured manifest entry (e.g. a hand-carry bundle for arm64)
  let bundleFile = null;
  let sourceDesc = null;
  let downloadedFrom = null;
  let tmpDir = null;
  const entry = manifest?.downloads?.[platformKey];
  if (env.MGO_ENGINE_BUNDLE) {
    bundleFile = path.resolve(env.MGO_ENGINE_BUNDLE);
    if (!fs.existsSync(bundleFile)) {
      warn(`MGO_ENGINE_BUNDLE does not exist: ${bundleFile}`); return process.exitCode = 1;
    }
    sourceDesc = `offline bundle ${bundleFile}`;
  } else {
    if (!entry) {
      warn(`no pre-configured engine download for ${platformKey} (package.json mgoEngine.downloads).`);
      warn('The service will boot, but every conversion job fails until an engine is provided:');
      warn('  • drop a bundle into build/bin/' + platformDir + '/ (scripts/pack-engine.mjs), or');
      warn('  • set MGO_ENGINE_URL to a prebuilt bundle address, or');
      warn('  • run under Docker on unsupported platforms.');
      return { skipped: 'unsupported-platform' }; // npm ci must survive on e.g. macOS dev boxes
    }
    const candidates = candidateUrls(entry, {
      urlEnv: env.MGO_ENGINE_URL, mirrorEnv: env.MGO_ENGINE_MIRROR,
    });
    const timeoutMs = Number(env.MGO_ENGINE_TIMEOUT_MS || 1_800_000);
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mgo-engine-'));
    const errors = [];
    for (const url of candidates) {
      const file = path.join(tmpDir, path.basename(new URL(url).pathname) || 'engine.bundle');
      try {
        say(`  downloading ${url}`);
        await downloadTo(url, file, timeoutMs);
        bundleFile = file;
        sourceDesc = `download ${url}`;
        downloadedFrom = url;
        break;
      } catch (e) { errors.push(`${url}: ${e.message}`); }
    }
    if (!bundleFile) {
      warn('engine download failed from every pre-configured address:');
      for (const e of errors) warn(`  • ${e}`);
      warn('fix: MGO_ENGINE_BUNDLE=<local bundle> · MGO_ENGINE_URL=<address> · MGO_ENGINE_MIRROR=<mirror>');
      return process.exitCode = 1;
    }
  }

  // integrity
  if (bundleFile && !env.MGO_ENGINE_BUNDLE) {
    const { sha256: expected, source } = await expectedSha256(entry, downloadedFrom);
    if (expected) {
      const got = await sha256File(bundleFile);
      if (got.toLowerCase() !== expected.toLowerCase()) {
        warn(`sha256 MISMATCH (${source}): expected ${expected}, got ${got}`); return process.exitCode = 1;
      }
      say(`  sha256 ok   (${source}) ${got.slice(0, 16)}…`);
    } else {
      warn('no sha256 available for this bundle (manifest + sidecar) — skipping integrity check');
    }
  }

  // unpack
  await fsp.mkdir(dest, { recursive: true });
  say(`  extracting  ${path.basename(bundleFile)} → ${dest}`);
  try {
    if (/\.t(ar\.)?gz$|\.tgz$/i.test(bundleFile)) await extractTar(bundleFile, dest);
    else if (/\.zip$/i.test(bundleFile)) await extractZip(bundleFile, dest);
    else { warn(`unsupported bundle format: ${bundleFile} (use .tgz or .zip)`); return process.exitCode = 1; }
  } catch (e) {
    // corrupt/traversal archives must fail the install cleanly, not crash npm
    warn(`extraction failed: ${e?.message ?? e}`);
    return process.exitCode = 1;
  }
  await flattenSingleRoot(dest);
  if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  if (!fs.existsSync(binary)) {
    warn(`bundle did not contain ${binaryName} — check the bundle layout (docs/INSTALLER_DESIGN.md §3)`);
    return process.exitCode = 1;
  }
  if (process.platform !== 'win32') await fsp.chmod(binary, 0o755);

  say(`  installed   (${sourceDesc})`);
  const info = await report(binary, dest);
  if (!info.found) {
    warn('engine installed but not runnable — see `npm run doctor`');
    warn('(usual cause: glibc older than the bundle baseline, or a Windows CRT mismatch)');
    return process.exitCode = 1;
  }
  if (expectReports && info.version && compareVersions(info.version, expectReports) < 0) {
    warn(`engine reports ${info.version}, older than the manifest expects (${expectReports}) — npm run engine:update`);
  }
  return { installed: true, version: info.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setup().catch((e) => { warn(e?.stack ?? e); process.exitCode = 1; });
}
