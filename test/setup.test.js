import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { setup, compareVersions, applyMirror, candidateUrls, loadEngineManifest, sha256File, expectedSha256 } from '../scripts/setup.mjs';
import { parseLdd } from '../scripts/pack-engine.mjs';
import { runJob } from '../src/jobs/runner.js';
import { engineEnv, withEngineEnv } from '../src/engine-env.js';

const execFileP = promisify(execFile);
// the fake engine is a bash script → POSIX-only, like the e2e suite's fake-mgo.sh
const posix = process.platform !== 'win32';
const t = posix ? test : test.skip;

// ── pure helpers ─────────────────────────────────────────────────────────────
test('compareVersions: dotted numeric, missing segments read as 0', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(compareVersions('1.0', '1.0.1'), -1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0-rc1', '1.0.0'), 0); // suffix ignored
});

test('applyMirror: base prefix and {url} template keep the raw URL', () => {
  assert.equal(applyMirror('https://m.example.com/', 'https://g/x.tgz'), 'https://m.example.com/https://g/x.tgz');
  assert.equal(applyMirror('https://p/{url}', 'https://g/x.tgz'), 'https://p/https://g/x.tgz');
  assert.equal(applyMirror(undefined, 'https://g/x.tgz'), 'https://g/x.tgz');
});

test('candidateUrls: manifest url + mirrors, env override wins, mirror appends attempts', () => {
  const entry = { url: 'https://a/x.tgz', mirrors: ['https://b/x.tgz'] };
  assert.deepEqual(candidateUrls(entry), ['https://a/x.tgz', 'https://b/x.tgz']);
  assert.deepEqual(candidateUrls(entry, { urlEnv: 'https://c/x.tgz' }), ['https://c/x.tgz', 'https://b/x.tgz']);
  assert.deepEqual(
    candidateUrls({ url: 'https://a/x.tgz' }, { mirrorEnv: 'https://m' }),
    ['https://a/x.tgz', 'https://m/https://a/x.tgz'],
  );
  assert.deepEqual(candidateUrls({}), []);
});

test('loadEngineManifest reads mgoEngine from package.json', () => {
  const m = loadEngineManifest();
  assert.ok(m && m.version && m.downloads['linux-x64'] && m.downloads['win-x64']);
});

// ── fixtures: a probe-able fake engine + bundle builders ─────────────────────
let root;
async function makeFakeEngine(dir, version = '9.9.9-test') {
  await fsp.mkdir(path.join(dir, 'share', 'proj'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'share', 'gdal'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'MGOConsole'),
    '#!/usr/bin/env bash\n'
    + 'if [ "$1" = "version" ]; then echo "MGO v' + version + '"; exit 0; fi\n'
    + 'if [ "$1" = "tiles" ]; then echo "  --bim-bind   Enable BIM"; exit 0; fi\nexit 0\n',
    { mode: 0o755 });
  await fsp.writeFile(path.join(dir, 'share', 'proj', 'proj.db'), 'SQLite format 3 (fake)');
  await fsp.writeFile(path.join(dir, 'share', 'gdal', 'epsg.wkt'), 'fake');
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ version, platform: 'linux', arch: 'x64', glibc: '2.39' }));
}

async function tarBundle(dir, file) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await execFileP('tar', ['-czf', file, '.'], { cwd: dir });
  return file;
}

async function zipBundle(dir, file) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await execFileP('zip', ['-rq', file, '.'], { cwd: dir });
  return file;
}

function fakePkgRoot(dir, manifest) {
  return { pkgRoot: dir, manifestFile: path.join(dir, 'package.json'), manifest };
}

before(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mgo-setup-')); });
after(async () => { await fsp.rm(root, { recursive: true, force: true }); });

t('engineEnv: vcpkg-flat release layout (proj.db beside exe, gdaldata/ subdir)', async () => {
  const dir = path.join(root, 'vcpkg-layout');
  await fsp.mkdir(path.join(dir, 'gdaldata'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'MGOConsole.exe'), 'pe-stub');
  await fsp.writeFile(path.join(dir, 'proj.db'), 'SQLite format 3 (fake)');
  await fsp.writeFile(path.join(dir, 'gdaldata', 'epsg.wkt'), 'fake');
  const envAdd = engineEnv(path.join(dir, 'MGOConsole.exe'));
  assert.equal(envAdd.PROJ_DATA, dir, 'proj.db at binary-dir root → inject the dir itself');
  assert.equal(envAdd.GDAL_DATA, path.join(dir, 'gdaldata'));
  assert.equal(envAdd.PROJ_LIB, envAdd.PROJ_DATA);
  // bundle layout (share/) still wins when both exist
  await fsp.mkdir(path.join(dir, 'share', 'proj'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'share', 'proj', 'proj.db'), 'SQLite format 3 (fake)');
  assert.equal(engineEnv(path.join(dir, 'MGOConsole.exe')).PROJ_DATA, path.join(dir, 'share', 'proj'));
});

t('engineEnv: only existing bundle data dirs are injected; user env stays authoritative', async () => {
  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'mgo-env-'));
  assert.deepEqual(engineEnv(path.join(empty, 'MGOConsole')), {});
  const dir = path.join(root, 'fakeeng');
  await makeFakeEngine(dir);
  const envAdd = engineEnv(path.join(dir, 'MGOConsole'));
  assert.equal(envAdd.PROJ_DATA, path.join(dir, 'share', 'proj'));
  assert.equal(envAdd.PROJ_LIB, envAdd.PROJ_DATA);
  assert.equal(envAdd.GDAL_DATA, path.join(dir, 'share', 'gdal'));
  // user-set PROJ_DATA must never be overridden by the bundle
  const merged = withEngineEnv(path.join(dir, 'MGOConsole'), { PROJ_DATA: '/custom' });
  assert.equal(merged.PROJ_DATA, '/custom');
  assert.equal(merged.GDAL_DATA, path.join(dir, 'share', 'gdal'));
});

t('setup: skip flags — MGO_ENGINE_SKIP and MGO_BINARY short-circuit before anything else', async () => {
  assert.deepEqual(await setup([], { MGO_ENGINE_SKIP: '1' }, root), { skipped: 'env' });
  assert.deepEqual(await setup([], { MGO_BINARY: '/somewhere/MGOConsole' }, root), { skipped: 'MGO_BINARY' });
});

t('setup: offline bundle → unpacked, probed, data dirs in place (idempotent)', async () => {
  const engineDir = path.join(root, 'fakeeng');
  const bundle = await tarBundle(engineDir, path.join(root, 'dist', 'fake-linux-x64.tgz'));
  const dest = path.join(root, 'bin1');
  const pkgRoot = path.join(root, 'pkg1');
  await fsp.mkdir(pkgRoot, { recursive: true });
  await fsp.writeFile(path.join(pkgRoot, 'package.json'),
    JSON.stringify({ mgoEngine: { version: '9.9.9-test', downloads: {} } }));

  const res = await setup(['--dest', dest], { MGO_ENGINE_BUNDLE: bundle }, pkgRoot);
  assert.equal(res.installed, true);
  assert.equal(res.version, '9.9.9-test');
  assert.equal(fs.existsSync(path.join(dest, 'MGOConsole')), true);
  const st = await fsp.stat(path.join(dest, 'MGOConsole'));
  assert.equal(Boolean(st.mode & 0o111), true, 'binary must stay executable after unpack');
  assert.equal(fs.existsSync(path.join(dest, 'share', 'proj', 'proj.db')), true);

  // second run: engine present → skip, no re-download
  const again = await setup(['--dest', dest], { MGO_ENGINE_BUNDLE: bundle }, pkgRoot);
  assert.equal(again.skipped, 'present');
});

t('setup: zip bundles unpack through the yauzl path', async () => {
  const engineDir = path.join(root, 'fakeeng2');
  await makeFakeEngine(engineDir, '9.9.9-z');
  const bundle = await zipBundle(engineDir, path.join(root, 'dist', 'fake-win-x64.zip'));
  const dest = path.join(root, 'bin2');
  const res = await setup(['--dest', dest], { MGO_ENGINE_BUNDLE: bundle }, root);
  assert.equal(res.installed, true);
  assert.equal(res.version, '9.9.9-z');
  assert.equal(fs.existsSync(path.join(dest, 'share', 'proj', 'proj.db')), true);
});

t('setup: --force wipes the destination (no old-engine/new-binary mixing)', async () => {
  const engineDir = path.join(root, 'fakeeng4');
  await makeFakeEngine(engineDir, '8.0.0');
  const bundle = await tarBundle(engineDir, path.join(root, 'dist', 'fake-v8.tgz'));
  const dest = path.join(root, 'bin6');
  await fsp.mkdir(dest, { recursive: true });
  // stale v1 engine + a stale side-car lib the new bundle does not carry
  await fsp.writeFile(path.join(dest, 'MGOConsole'), '#!/bin/sh\necho stale\n');
  await fsp.writeFile(path.join(dest, 'libstale.so.1'), 'old lib');

  const res = await setup(['--dest', dest, '--force'], { MGO_ENGINE_BUNDLE: bundle }, root);
  assert.equal(res.installed, true);
  assert.equal(res.version, '8.0.0');
  assert.equal(fs.existsSync(path.join(dest, 'libstale.so.1')), false, 'stale side-car must not survive');
  const st = await fsp.stat(path.join(dest, 'MGOConsole'));
  assert.ok(st.size > 20, 'binary must be the new one, not the stale stub');
});

t('setup: missing bundle file fails loudly', async () => {
  const prev = process.exitCode;
  const res = await setup(['--dest', path.join(root, 'bin3')],
    { MGO_ENGINE_BUNDLE: path.join(root, 'nope.tgz') }, root);
  assert.equal(process.exitCode, 1);
  assert.equal(res.installed, undefined);
  process.exitCode = prev;
});

t('setup: no manifest entry and no bundle → deliberate skip (npm ci survives)', async () => {
  const pkg = await fsp.mkdtemp(path.join(os.tmpdir(), 'mgo-pkg-'));
  await fsp.writeFile(path.join(pkg, 'package.json'), '{}');
  assert.deepEqual(await setup(['--dest', path.join(root, 'bin4')], {}, pkg), { skipped: 'unsupported-platform' });
});

// ── download path against a throwaway HTTP server ────────────────────────────
t('setup: pre-configured URL download with sha256 verify, mismatch fails closed', async () => {
  const engineDir = path.join(root, 'fakeeng3');
  await makeFakeEngine(engineDir, '9.9.9-http');
  const bundle = await tarBundle(engineDir, path.join(root, 'srv', 'mgo-engine-linux-x64.tgz'));
  const hash = await sha256File(bundle);
  const pkg = path.join(root, 'pkg2');
  await fsp.mkdir(pkg, { recursive: true });
  await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
    mgoEngine: {
      version: '9.9.9-http',
      downloads: { [`${process.platform}-${process.arch}`]: { url: 'PLACEHOLDER', sha256: hash } },
    },
  }));

  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url.endsWith('.sha256')) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/gzip' });
    fs.createReadStream(bundle).pipe(res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  // tampered expectation → refuse to install
  await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
    mgoEngine: {
      version: '9.9.9-http',
      downloads: { [`${process.platform}-${process.arch}`]: { url: `${base}/mgo-engine-linux-x64.tgz`, sha256: '0'.repeat(64) } },
    },
  }));
  const prev = process.exitCode;
  const bad = await setup(['--dest', path.join(root, 'bin5')], {}, pkg);
  assert.equal(process.exitCode, 1);
  assert.equal(bad.installed, undefined);
  assert.equal(fs.existsSync(path.join(root, 'bin5', 'MGOConsole')), false, 'mismatched bundle must not land');
  process.exitCode = prev;

  // correct pin → installs and reports the download as source
  await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
    mgoEngine: {
      version: '9.9.9-http',
      downloads: { [`${process.platform}-${process.arch}`]: { url: `${base}/mgo-engine-linux-x64.tgz`, sha256: hash } },
    },
  }));
  const ok = await setup(['--dest', path.join(root, 'bin5')], {}, pkg);
  assert.equal(ok.installed, true);
  assert.equal(ok.version, '9.9.9-http');
  assert.deepEqual(hits, ['/mgo-engine-linux-x64.tgz', '/mgo-engine-linux-x64.tgz']); // two runs, no sidecar hit (manifest pin)
  await new Promise((r) => srv.close(r));
});

// ── review round 2: installer hardening + uncovered failure paths ────────────
test('parseLdd: DST tokens ($LIB/…) reduce to the basename, not-found captured, noise ignored', () => {
  const out = [
    '\tlinux-vdso.so.1 (0x00007ffd) ------------------',              // no arrow → ignored
    '\tlibgdal.so.34 => /lib/x86_64-linux-gnu/libgdal.so.34 (0x…)',
    '\t$LIB/libonion.so => /lib/x86_64-linux-gnu/libonion.so (0x…)',  // DST bug regression guard
    '\tlibproj.so.25 => not found',
    'static binary',                                                  // no match → ignored
  ].join('\n');
  assert.deepEqual(parseLdd(out), [
    { name: 'libgdal.so.34', resolved: '/lib/x86_64-linux-gnu/libgdal.so.34' },
    { name: 'libonion.so', resolved: '/lib/x86_64-linux-gnu/libonion.so' },
    { name: 'libproj.so.25', resolved: null },
  ]);
});

test('sha256File: missing file rejects (stream error path)', async () => {
  await assert.rejects(() => sha256File(path.join(root, 'definitely-missing.bin')));
});

test('expectedSha256: manifest pin wins, sidecar parsed, garbage sidecar ignored', async () => {
  assert.deepEqual(await expectedSha256({ sha256: 'a'.repeat(64) }, 'http://ignored/x.tgz'),
    { sha256: 'a'.repeat(64), source: 'manifest' });
  const srv = http.createServer((req, res) => {
    if (req.url === '/bad.tgz.sha256') { res.writeHead(200); return res.end('not-a-hash'); }
    if (req.url === '/ok.tgz.sha256') { res.writeHead(200); return res.end(`${'b'.repeat(64)}  x.tgz\n`); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  assert.deepEqual(await expectedSha256({}, `${base}/ok.tgz`), { sha256: 'b'.repeat(64), source: 'sidecar' });
  assert.deepEqual(await expectedSha256({}, `${base}/bad.tgz`), { sha256: null, source: 'none' });
  assert.deepEqual(await expectedSha256({}, `${base}/none.tgz`), { sha256: null, source: 'none' });
  await new Promise((r) => srv.close(r));
});

t('setup: --dest without a value fails cleanly instead of crashing', async () => {
  const prev = process.exitCode;
  const res = await setup(['--dest'], {}, root);
  assert.equal(process.exitCode, 1);
  assert.equal(res.installed, undefined);
  process.exitCode = prev;
});

t('setup: --force refuses to wipe a non-engine directory (misconfigured dest)', async () => {
  const victim = path.join(root, 'not-an-engine');
  await fsp.mkdir(victim, { recursive: true });
  await fsp.writeFile(path.join(victim, 'precious.txt'), 'user data');
  const prev = process.exitCode;
  const res = await setup(['--dest', victim, '--force'],
    { MGO_ENGINE_BUNDLE: path.join(root, 'nope.tgz') }, root);
  assert.equal(process.exitCode, 1, 'must refuse before touching anything');
  assert.equal(fs.existsSync(path.join(victim, 'precious.txt')), true, 'unrelated directory must survive');
  assert.equal(res.installed, undefined);
  process.exitCode = prev;
});

t('setup: download failure from the manifest URL fails closed, dest untouched', async () => {
  // a server that is closed again → deterministic connection-refused address
  const dead = http.createServer(() => {});
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));
  const pkg = path.join(root, 'pkg-fail');
  await fsp.mkdir(pkg, { recursive: true });
  await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
    mgoEngine: {
      version: '9.9.9',
      downloads: { [`${process.platform}-${process.arch}`]: { url: `http://127.0.0.1:${deadPort}/mgo.tgz`, sha256: '' } },
    },
  }));
  const prev = process.exitCode;
  const res = await setup(['--dest', path.join(root, 'bin-fail')], {}, pkg);
  assert.equal(process.exitCode, 1);
  assert.equal(res.installed, undefined);
  assert.equal(fs.existsSync(path.join(root, 'bin-fail')), false, 'dest must not be created on failed download');
  process.exitCode = prev;
});

t('setup: sha256 sidecar (<url>.sha256) is used when the manifest pin is empty', async () => {
  const engineDir = path.join(root, 'fakeeng5');
  await makeFakeEngine(engineDir, '9.9.9-side');
  const bundle = await tarBundle(engineDir, path.join(root, 'srv', 'side.tgz'));
  const hash = await sha256File(bundle);
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url.endsWith('.sha256')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(`${hash}  side.tgz\n`);
    }
    res.writeHead(200);
    fs.createReadStream(bundle).pipe(res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const pkg = path.join(root, 'pkg-side');
  await fsp.mkdir(pkg, { recursive: true });
  await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
    mgoEngine: {
      version: '9.9.9-side',
      downloads: { [`${process.platform}-${process.arch}`]: { url: `${base}/side.tgz`, sha256: '' } },
    },
  }));
  const res = await setup(['--dest', path.join(root, 'bin-side')], {}, pkg);
  assert.equal(res.installed, true);
  assert.deepEqual(hits, ['/side.tgz', '/side.tgz.sha256']);
  await new Promise((r) => srv.close(r));
});

t('setup: zip-slip entries are rejected, nothing written outside the destination', async () => {
  // yazl refuses traversal names, so hand-build a minimal stored-entry zip
  // whose name escapes the destination (the extractor must reject it)
  const { crc32 } = await import('node:zlib');
  const makeEvilZip = async (file, entryName, content) => {
    const name = Buffer.from(entryName);
    const data = Buffer.from(content);
    const crc = crc32(data) >>> 0;
    const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
    const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
    const local = Buffer.concat([Buffer.from('PK\x03\x04'), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data]);
    const cd = Buffer.concat([Buffer.from('PK\x01\x02'), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(0), name]);
    const eocd = Buffer.concat([Buffer.from('PK\x05\x06'), u16(0), u16(0), u16(1), u16(1),
      u32(cd.length), u32(local.length), u16(0)]);
    await fsp.writeFile(file, Buffer.concat([local, cd, eocd]));
  };
  const evilZip = path.join(root, 'evil.zip');
  await makeEvilZip(evilZip, path.join('..', 'escaped.txt'), 'evil');
  const prev = process.exitCode;
  await setup(['--dest', path.join(root, 'bin-evil')], { MGO_ENGINE_BUNDLE: evilZip }, root);
  assert.equal(process.exitCode, 1, 'zip-slip must fail the install');
  assert.equal(fs.existsSync(path.join(root, 'escaped.txt')), false);
  assert.equal(fs.existsSync(path.join(root, 'bin-evil', 'escaped.txt')), false);
  process.exitCode = prev;
});

t('runner: spawns the engine with bundled PROJ_DATA/GDAL_DATA in the environment', async () => {
  const dir = path.join(root, 'runner-eng');
  await fsp.mkdir(path.join(dir, 'share', 'proj'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'share', 'gdal'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'MGOConsole'), '#!/usr/bin/env bash\n'
    + 'echo "PROJ=$PROJ_DATA"; echo "PROJLIB=$PROJ_LIB"; echo "GDAL=$GDAL_DATA"\n', { mode: 0o755 });
  await fsp.writeFile(path.join(dir, 'share', 'proj', 'proj.db'), 'x');
  await fsp.writeFile(path.join(dir, 'share', 'gdal', 'epsg.wkt'), 'x');
  const lines = [];
  const { promise } = runJob({
    binary: path.join(dir, 'MGOConsole'),
    args: [],
    logPath: path.join(root, 'runner.log'),
    onLine: (l) => lines.push(l),
  });
  const res = await promise;
  assert.equal(res.ok, true);
  const proj = path.join(dir, 'share', 'proj');
  const gdal = path.join(dir, 'share', 'gdal');
  assert.ok(lines.some((l) => l === `PROJ=${proj}`), `PROJ_DATA must reach the engine: ${lines}`);
  assert.ok(lines.some((l) => l === `PROJLIB=${proj}`), 'PROJ_LIB must reach the engine');
  assert.ok(lines.some((l) => l === `GDAL=${gdal}`), 'GDAL_DATA must reach the engine');
});

t('doctor: runs to a structured verdict without crashing (child-process smoke)', async () => {
  // exit code is data (0 healthy host / 1 diagnosed problems) — the contract
  // under test is the report shape, not this machine's health
  const { stdout } = await execFileP(process.execPath, ['scripts/doctor.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    timeout: 60000,
  }).catch((e) => ({ stdout: e.stdout ?? '' }));
  assert.match(stdout, /== mgo doctor ==/);
  assert.match(stdout, /== \d+ pass \/ \d+ fail \/ \d+ warn ==/);
});
