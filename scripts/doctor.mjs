#!/usr/bin/env node
/**
 * `npm run doctor` — one command that answers "why can't this machine convert?"
 * (docs/INSTALLER_DESIGN.md §5).  Strictly read-only: no downloads, no sudo,
 * no system changes.  Exit 1 when any FAIL is present.
 *
 * Checks: Node version, platform support, engine discovery + probe, dynamic
 * library closure (ldd) for the engine and its side-car libs, bundled vs system
 * proj.db / gdal-data, glibc baseline, workspace disk, Cesium self-host.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, PKG_ROOT, PLATFORM_BIN_DIR } from '../src/config.js';
import { probeMgo } from '../src/mgo.js';
import { engineEnv } from '../src/engine-env.js';
import { loadEngineManifest, platformKey, binaryName, compareVersions } from './setup.mjs';

const execFileP = promisify(execFile);

const ROWS = [];
const pass = (label, detail) => ROWS.push(['PASS', label, detail]);
const fail = (label, detail) => ROWS.push(['FAIL', label, detail]);
const warnRow = (label, detail) => ROWS.push(['WARN', label, detail]);
const info = (label, detail) => ROWS.push(['INFO', label, detail]);

/** All "not found" entries of `ldd file`, or null when ldd cannot run it. */
async function lddMissing(file) {
  try {
    const { stdout } = await execFileP('ldd', [file], { timeout: 15000 });
    return [...stdout.matchAll(/^(.*?)\s*=>\s*not found.*$/gm)].map((m) => m[1].trim());
  } catch { return null; } // non-ELF, musl, windows…
}

async function main() {
  const cfg = loadConfig();
  const manifest = loadEngineManifest();

  // 1 ── runtime + platform support
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= 20) pass('node', `${process.version} (>= 20)`);
  else fail('node', `${process.version} — MGOServer needs >= 20`);

  if (manifest?.downloads?.[platformKey]) info('platform', `${platformKey} — pre-configured engine download available`);
  else if (process.platform === 'darwin') warnRow('platform', `${platformKey} — no engine; run the service under Docker`);
  else warnRow('platform', `${platformKey} — no pre-configured engine (see docs/INSTALLER_DESIGN.md)`);

  // 2 ── engine discovery + probe (probe already carries bundled PROJ_DATA env)
  const binary = cfg.binary;
  const exists = binary !== 'mgo' && fs.existsSync(binary);
  if (exists) pass('engine binary', binary);
  else fail('engine binary', `${binary} not found — run 'npm run engine:update' or set MGO_BINARY`);

  const dir = path.dirname(exists ? binary : path.join(PKG_ROOT, 'build', 'bin', PLATFORM_BIN_DIR));
  const probed = exists ? await probeMgo(binary) : null;
  if (probed?.found) {
    const caps = `osgb=${probed.hasOsgb ? '✓' : '✗'} bim=${probed.hasBim ? '✓' : '✗'}`;
    const expectReports = manifest?.reportsVersion ?? manifest?.version;
    const age = expectReports && probed.version && compareVersions(probed.version, expectReports) < 0
      ? ` — reports older than manifest ${expectReports}, consider engine:update` : '';
    pass('engine probe', `MGO ${probed.version} (${caps})${age}`);
  } else if (exists) {
    fail('engine probe', `${binary} is present but cannot run — 'ldd ${binary}' usually names the missing library`);
  }

  // 3 ── dynamic library closure (Linux only; the self-contained bundle ships
  // every non-glibc lib, so anything "not found" means an incomplete bundle)
  if (process.platform === 'linux' && exists) {
    const musl = await execFileP('ldd', ['--version'], { timeout: 10000 })
      .then(({ stdout }) => /musl/i.test(stdout)).catch(() => false);
    if (musl) fail('libc', 'musl (Alpine) detected — prebuilt engine is glibc; use the Docker image');
    const files = [binary, ...fs.readdirSync(dir).filter((n) => n.endsWith('.so') || /\.so\.\d/.test(n)).map((n) => path.join(dir, n))];
    const missing = new Map();
    for (const f of files) {
      const miss = await lddMissing(f);
      if (miss) for (const m of miss) if (!missing.has(m)) missing.set(m, f);
    }
    if (missing.size === 0) pass('lib closure', `${files.length} ELF files, no unresolved dependencies`);
    else fail('lib closure', `missing: ${[...missing.keys()].join(', ')} — reinstall the engine bundle (npm run engine:update) or run under Docker`);
  }

  // 4 ── projection data: bundle/release layouts first, system fallback, else break
  // (detection must agree with the runtime — same engineEnv helper as spawn)
  const envAdd = engineEnv(binary);
  if (envAdd.PROJ_DATA) pass('proj.db', `bundled at ${envAdd.PROJ_DATA} (PROJ_DATA injected at spawn)`);
  else if ([path.join(dir, 'share', 'proj', 'proj.db'), '/usr/share/proj/proj.db', '/usr/local/share/proj/proj.db'].some((p) => fs.existsSync(p))) warnRow('proj.db', 'system proj-data found — works, but a self-contained engine would make this host portable (npm run engine:update)');
  else fail('proj.db', 'neither bundled nor system — EPSG/WKT conversion will fail (proj_create: cannot find proj.db)');

  if (envAdd.GDAL_DATA) pass('gdal-data', `GDAL_DATA=${envAdd.GDAL_DATA}`);
  else warnRow('gdal-data', 'not bundled — relying on system GDAL data (fine when libgdal came from a distro package)');

  // 5 ── glibc baseline vs runtime
  const bundleManifest = path.join(dir, 'manifest.json');
  if (fs.existsSync(bundleManifest)) {
    try {
      const m = JSON.parse(fs.readFileSync(bundleManifest, 'utf8'));
      info('bundle', `version ${m.version}, built against glibc ${m.glibc ?? '?'}`);
      const runtime = process.report?.getReport?.().header?.glibcVersionRuntime;
      if (m.glibc && runtime && compareVersions(String(runtime), String(m.glibc).replace(/^([0-9.]+).*$/, '$1')) < 0) {
        fail('glibc', `runtime ${runtime} < bundle baseline ${m.glibc} — engine cannot run here; use Docker`);
      } else if (runtime) info('glibc', `runtime ${runtime} ≥ baseline ${m.glibc}`);
    } catch { /* manifest unreadable — non-fatal */ }
  }

  // 6 ── runtime prerequisites the README promises
  try {
    const { bavail, bsize } = fs.statfsSync(cfg.workspaceRoot);
    const freeGb = (bavail * bsize) / 1024 ** 3;
    if (freeGb >= cfg.minFreeGb) pass('disk', `${freeGb.toFixed(1)} GB free under ${cfg.workspaceRoot}`);
    else fail('disk', `${freeGb.toFixed(1)} GB free < MGO_MIN_FREE_GB=${cfg.minFreeGb}`);
  } catch { warnRow('disk', `workspace root ${cfg.workspaceRoot} not statable (created on first job)`); }

  info('cesium', fs.existsSync(cfg.cesiumLocalEntry)
    ? 'self-hosted (public/cesium) — fully offline viewer'
    : 'CDN fallback — run `npm run sync:cesium` for offline use');

  // ── report
  console.log('== mgo doctor ==');
  for (const [status, label, detail] of ROWS) console.log(`  ${status.padEnd(4)} ${label.padEnd(14)} ${detail}`);
  const fails = ROWS.filter(([s]) => s === 'FAIL').length;
  console.log(`== ${ROWS.filter(([s]) => s === 'PASS').length} pass / ${fails} fail / ${ROWS.filter(([s]) => s === 'WARN').length} warn ==`);
  if (fails > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('doctor crashed:', e?.stack ?? e); process.exitCode = 1; });
