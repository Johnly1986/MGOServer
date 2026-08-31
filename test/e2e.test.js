import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import yazl from 'yazl';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const IS_WIN = process.platform === 'win32';
const FAKE = path.join(import.meta.dirname, 'fixtures', 'fake-mgo.sh');

let app; let base; let tmp;

before(async () => {
  if (IS_WIN) return; // fake binary is bash
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mgo-e2e-'));
  app = await buildApp(loadConfig({
    binary: FAKE,
    workspaceRoot: path.join(tmp, 'ws'),
    maxConcurrentJobs: 1,
    queueMax: 5,
    minFreeGb: 0,
    ttlDays: 7,
    jobTimeoutS: 30,
    allowLocalPath: true,
    allowedRoots: [tmp],
    logLevel: 'silent',
  }));
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  if (IS_WIN) return;
  await app.close();
  await fsp.rm(tmp, { recursive: true, force: true });
});

const skip = IS_WIN && { skip: 'fake mgo binary is bash-only' };

async function api(method, p, body, headers = {}) {
  const r = await fetch(base + p, {
    method,
    headers: body ? { 'content-type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-json */ }
  return { status: r.status, json, headers: r.headers };
}

async function waitTerminal(id, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const { json } = await api('GET', `/api/v1/jobs/${id}`);
    if (['succeeded', 'failed', 'canceled', 'usage_error'].includes(json.status)) return json;
    assert.ok(Date.now() - t0 < ms, `job ${id} did not finish in ${ms}ms`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

test('health + capabilities', skip, async () => {
  const h = await api('GET', '/api/v1/health');
  assert.equal(h.status, 200);
  assert.equal(h.json.status, 'ok');
  const c = await api('GET', '/api/v1/capabilities');
  assert.ok(c.json.jobTypes.includes('tiles'));
  assert.equal(c.json.features.localPathInput, true);
  assert.equal(c.json.features.authMode, 'ip-whitelist');
  assert.equal(c.json.client.allowed, true, 'localhost always whitelisted');
});

test('metrics endpoint reports job counts and queue', skip, async () => {
  const m = await api('GET', '/api/v1/metrics');
  assert.equal(m.status, 200);
  assert.ok(Number.isFinite(m.json.jobs.total));
  assert.ok(typeof m.json.jobs.byStatus === 'object');
  assert.equal(typeof m.json.jobs.running, 'number');
  assert.equal(m.json.limits.maxConcurrentJobs, 1);
});

test('mesh config CSV upload feeds the CLI -c flag', skip, async () => {
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'mesh', outputFormat: 'glb' }));
  fd.append('file', new Blob(['FBXK'], { type: 'application/octet-stream' }), 'a.fbx');
  fd.append('cfg', new Blob(['name,error,nweight\n.*,0.02,0.1\n']), 'parts.csv');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  const txt = await r.text();
  assert.equal(r.status, 201, txt);
  const j = JSON.parse(txt);
  const done = await waitTerminal(j.id);
  assert.equal(done.status, 'succeeded');
  const { lines } = await (await fetch(base + `/api/v1/jobs/${j.id}/log?tail=50`)).json();
  const argvLine = lines.find((l) => l.startsWith('argv:'));
  assert.ok(argvLine, 'fake binary logged argv');
  assert.match(argvLine, /-c \S+\/input\/_config\.csv/);
  // config file landed in the job input dir
  const p = path.join(tmp, 'ws', 'jobs', j.id, 'input', '_config.csv');
  assert.ok((await fsp.stat(p)).isFile(), 'config csv not staged');
});

test('cfg field with wrong extension rejected', skip, async () => {
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'mesh' }));
  fd.append('file', new Blob(['FBXK']), 'a.fbx');
  fd.append('cfg', new Blob(['x']), 'evil.exe');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error.code, 'CFG_EXT');
});

test('IP whitelist: spoofed client IP rejected, localhost allowed', skip, async () => {
  const spoof = await fetch(base + '/api/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
    body: JSON.stringify({ type: 'geojson', inputPath: path.join(tmp, 'a.geojson') }),
  });
  assert.equal(spoof.status, 403);
  assert.equal((await spoof.json()).error.code, 'IP_NOT_ALLOWED');

  // non-whitelisted IP cannot open pages or artifacts either (global gate)
  for (const p of ['/console.html', '/viewer.html', '/whitelist.html',
    '/ws/anything/out/tileset.json', '/api/v1/jobs']) {
    const r = await fetch(base + p, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.equal(r.status, 403, `expected 403 for ${p}`);
  }

  const local = await fetch(base + '/api/v1/whitelist');
  assert.equal(local.status, 200);
  const wl = (await local.json()).whitelist;
  assert.ok(wl.includes('127.0.0.1'));

  // localhost management page + capability flag
  const caps = await api('GET', '/api/v1/capabilities');
  assert.equal(caps.json.client.canManageWhitelist, true);
  const page = await fetch(base + '/whitelist.html');
  assert.equal(page.status, 200);
});

test('whitelist management is localhost-only and persists additions', skip, async () => {
  // spoofed client cannot read or change the whitelist
  const blocked = await fetch(base + '/api/v1/whitelist',
    { headers: { 'x-forwarded-for': '203.0.113.9' } });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error.code, 'LOCAL_ONLY');

  // localhost adds an IP/CIDR → persisted to <workspace>/whitelist.json
  const add = await api('POST', '/api/v1/whitelist',
    { whitelist: ['203.0.113.10', '10.0.0.0/8'] });
  assert.equal(add.status, 200);
  const file = path.join(tmp, 'ws', 'whitelist.json');
  const persisted = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.ok(persisted.includes('203.0.113.10'));
  assert.ok(persisted.includes('10.0.0.0/8'));

  // the newly added exact IP can now create a job
  await fsp.writeFile(path.join(tmp, 'a.geojson'), '{}');
  const ok = await fetch(base + '/api/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
    body: JSON.stringify({ type: 'geojson', inputPath: path.join(tmp, 'a.geojson') }),
  });
  assert.equal(ok.status, 201, await ok.text());

  // CIDR-matched address is allowed too
  await fsp.writeFile(path.join(tmp, 'b.geojson'), '{}');
  const cidr = await fetch(base + '/api/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.1.2.3' },
    body: JSON.stringify({ type: 'geojson', inputPath: path.join(tmp, 'b.geojson') }),
  });
  assert.equal(cidr.status, 201, await cidr.text());
});

test('whitelist rejects malformed entries', skip, async () => {
  const bad = await api('POST', '/api/v1/whitelist', { whitelist: ['999.1.1.1'] });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, 'BAD_ENTRY');
});

test('terrain job via server-local inputPath → succeeded + artifacts + data plane', skip, async () => {
  const tif = path.join(tmp, 'dem.tif');
  await fsp.writeFile(tif, 'fake-tif');
  const r = await api('POST', '/api/v1/jobs', {
    type: 'terrain', inputPath: tif, maxLod: 2, samplesPerTile: 65,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const done = await waitTerminal(r.json.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.progress.percent, 100);
  const terrain = done.artifacts.find((a) => a.role === 'terrain');
  assert.ok(terrain, 'terrain artifact discovered');
  assert.ok(done.viewerUrl.includes('type=terrain'));

  // data plane: layer.json + .terrain served with correct headers
  const l = await fetch(base + terrain.url);
  assert.equal(l.status, 200);
  assert.match(l.headers.get('content-type'), /application\/json/);
  const t = await fetch(base + `/ws/${done.id}/out/0/0/0.terrain`);
  assert.equal(t.status, 200);
  assert.match(t.headers.get('cache-control'), /immutable/);
  assert.ok(t.headers.get('access-control-allow-origin'));
  assert.equal(await t.text(), 'TERRAINBIN');

  // 304 on matching ETag
  const t2 = await fetch(base + `/ws/${done.id}/out/0/0/0.terrain`,
    { headers: { 'if-none-match': t.headers.get('etag') } });
  assert.equal(t2.status, 304);
});

test('tiles job via multipart upload', skip, async () => {
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'tiles', zUp: true }));
  fd.append('file', new Blob(['FBXK'], { type: 'application/octet-stream' }), 'model.fbx');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  const txt = await r.text();
  assert.equal(r.status, 201, txt);
  const j = JSON.parse(txt);
  const done = await waitTerminal(j.id);
  assert.equal(done.status, 'succeeded');
  const tiles = done.artifacts.find((a) => a.role === '3dtiles');
  assert.ok(tiles);
  assert.equal(tiles.url, `/ws/${j.id}/out/tileset.json`);
});

test('multipart upload of .prj + .cps feeds the CLI argv', skip, async () => {
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'tiles', georef: { mode: 'multipos', fitOrder: 1 } }));
  fd.append('file', new Blob(['FBXK'], { type: 'application/octet-stream' }), 'site.fbx');
  fd.append('prj', new Blob(['PROJCS["CGCS2000 / 3-degree GK CM 120E"]']), 'cgcs2000_gk.prj');
  fd.append('cps', new Blob(['sx,sy,sz,tx,ty,tz\n1,2,3,4,5,6\n']), 'points.csv');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  const txt = await r.text();
  assert.equal(r.status, 201, txt);
  const j = JSON.parse(txt);
  const done = await waitTerminal(j.id);
  assert.equal(done.status, 'succeeded');
  const { lines } = await (await fetch(base + `/api/v1/jobs/${j.id}/log?tail=50`)).json();
  const argvLine = lines.find((l) => l.startsWith('argv:'));
  assert.ok(argvLine, 'fake binary logged argv');
  assert.match(argvLine, /--prj \S+\/input\/_projection\.prj/);
  assert.match(argvLine, /--cps \S+\/input\/_controlpoints\.csv/);
  assert.match(argvLine, /--georef multipos --cps \S+_controlpoints\.csv --fit-order 1/);
});

test('prj field with wrong extension rejected', skip, async () => {
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'tiles' }));
  fd.append('file', new Blob(['FBXK']), 'a.fbx');
  fd.append('prj', new Blob(['xx']), 'evil.exe');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error.code, 'PRJ_EXT');
});

test('osgb directory upload rebuilds the folder tree and feeds CLI -i <dir>', skip, async () => {
  const fd = new FormData();
  fd.append('options', JSON.stringify({
    type: 'osgb',
    dirName: 'Block_1',
    relPaths: [
      'Block_1/Data/Tile_1/Tile_1.osgb',
      'Block_1/Data/Tile_1/1_1.jpg',
      'Block_1/metadata.xml',
    ],
  }));
  fd.append('file', new Blob(['OSGBBIN']), 'f_000001');
  fd.append('file', new Blob(['JPGBIN']), 'f_000002');
  fd.append('file', new Blob(['<xml/>']), 'f_000003');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  const txt = await r.text();
  assert.equal(r.status, 201, txt);
  const j = JSON.parse(txt);
  assert.equal(j.type, 'osgb');
  assert.equal(j.inputName, 'Block_1');
  const done = await waitTerminal(j.id);
  assert.equal(done.status, 'succeeded');
  assert.ok(done.artifacts.find((a) => a.role === '3dtiles'), 'osgb tileset artifact');

  // folder tree rebuilt under the job's input dir
  const jobDir = path.join(tmp, 'ws', 'jobs', j.id, 'input');
  for (const rel of ['Block_1/Data/Tile_1/Tile_1.osgb', 'Block_1/Data/Tile_1/1_1.jpg', 'Block_1/metadata.xml']) {
    const p = path.join(jobDir, rel);
    assert.ok((await fsp.stat(p)).isFile(), `missing uploaded tree file: ${rel}`);
  }

  // CLI got the directory as -i (not a file path)
  const { lines } = await (await fetch(base + `/api/v1/jobs/${j.id}/log?tail=50`)).json();
  const argvLine = lines.find((l) => l.startsWith('argv:'));
  assert.ok(argvLine, 'fake binary logged argv');
  assert.match(argvLine, /osgb -i \S+\/input \S+/);
});

test('osgb relPaths mismatch rejected', skip, async () => {
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'osgb', relPaths: ['a/1.osgb', 'b/2.osgb'] }));
  fd.append('file', new Blob(['x']), 'f_000001');
  fd.append('file', new Blob(['y']), 'f_000002');
  fd.append('file', new Blob(['z']), 'f_000003'); // 3 files vs 2 relPaths
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error.code, 'REL_PATHS_MISMATCH');
});

test('osgb relPaths traversal rejected', skip, async () => {
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'osgb', relPaths: ['../evil/1.osgb'] }));
  fd.append('file', new Blob(['x']), 'f_000001');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error.code, 'BAD_REL_PATH');
});

/* ---- zip upload channel ---- */
function makeZip(entries) {
  // entries: [[path, content], ...]
  const z = new yazl.ZipFile();
  for (const [p, c] of entries) z.addBuffer(Buffer.from(c), p);
  const chunks = [];
  const collect = new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } });
  const done = pipeline(z.outputStream, collect);
  z.end();
  return done.then(() => Buffer.concat(chunks));
}

test('osgb zip upload extracts tree and feeds CLI -i <dir>', skip, async () => {
  const zip = await makeZip([
    ['Block_1/Data/Tile_1/Tile_1.osgb', 'OSGBBIN'],
    ['Block_1/Data/Tile_1/1_1.jpg', 'JPGBIN'],
    ['Block_1/metadata.xml', '<xml/>'],
  ]);
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'osgb', dirName: 'Block_1' }));
  fd.append('file', new Blob([zip], { type: 'application/zip' }), 'Block_1.zip');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  const txt = await r.text();
  assert.equal(r.status, 201, txt);
  const j = JSON.parse(txt);
  const done = await waitTerminal(j.id);
  assert.equal(done.status, 'succeeded');
  const jobDir = path.join(tmp, 'ws', 'jobs', j.id, 'input');
  for (const rel of ['Block_1/Data/Tile_1/Tile_1.osgb', 'Block_1/Data/Tile_1/1_1.jpg', 'Block_1/metadata.xml']) {
    assert.ok((await fsp.stat(path.join(jobDir, rel))).isFile(), `missing ${rel}`);
  }
  const { lines } = await (await fetch(base + `/api/v1/jobs/${j.id}/log?tail=50`)).json();
  const argvLine = lines.find((l) => l.startsWith('argv:'));
  assert.match(argvLine, /osgb -i \S+\/input \S+/);
});

test('osgb zip traversal entry rejected', skip, async () => {
  // yazl refuses "../" paths, so the malicious archive is a checked-in fixture
  const zip = await fsp.readFile(path.join(import.meta.dirname, 'fixtures', 'traversal.zip'));
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'osgb' }));
  fd.append('file', new Blob([zip], { type: 'application/zip' }), 'evil.zip');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error.code, 'ZIP_PATH');
});

test('osgb zip with no files rejected', skip, async () => {
  const zip = await makeZip([]);
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'osgb' }));
  fd.append('file', new Blob([zip], { type: 'application/zip' }), 'empty.zip');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, 'EMPTY_ZIP');
});

test('conversion failure (exit 1) → failed with log tail', skip, async () => {
  process.env.FAKE_EXIT = '1';
  try {
    const tif = path.join(tmp, 'bad.tif');
    await fsp.writeFile(tif, 'x');
    const r = await api('POST', '/api/v1/jobs', { type: 'terrain', inputPath: tif });
    const done = await waitTerminal(r.json.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.error.code, 'CONVERSION');
    assert.ok(done.error.logTail.some((l) => l.includes('Progress')));
  } finally { delete process.env.FAKE_EXIT; }
});

test('validation errors never spawn: even samples + unknown key + bad ext', skip, async () => {
  const a = await api('POST', '/api/v1/jobs', { type: 'terrain', inputPath: path.join(tmp, 'dem.tif'), samplesPerTile: 64 });
  assert.equal(a.status, 422);
  assert.equal(a.json.error.code, 'VALIDATION');
  const b = await api('POST', '/api/v1/jobs', { type: 'tiles', inputPath: path.join(tmp, 'dem.tif') });
  assert.equal(b.status, 422); // .tif not accepted for tiles
});

test('local path outside allowed roots → 403', skip, async () => {
  const r = await api('POST', '/api/v1/jobs', { type: 'terrain', inputPath: '/etc/hostname' });
  assert.equal(r.status, 403);
});

test('data plane traversal is denied', skip, async () => {
  const r = await api('GET', '/api/v1/jobs?limit=1');
  const id = r.json.items[0]?.id;
  assert.ok(id);
  const a = await fetch(base + `/ws/${id}/out/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
  assert.ok([400, 403].includes(a.status), `expected denial, got ${a.status}`);
  const b = await fetch(base + '/ws/00000000-0000-0000-0000-000000000000/out/layer.json');
  assert.equal(b.status, 404);
});

test('cancel a running job', skip, async () => {
  process.env.FAKE_SLEEP = '1.5';
  try {
    const r = await api('POST', '/api/v1/jobs', { type: 'terrain', inputPath: path.join(tmp, 'dem.tif') });
    const id = r.json.id;
    await new Promise((res) => setTimeout(res, 300));
    const c = await api('POST', `/api/v1/jobs/${id}/cancel`);
    assert.equal(c.status, 200);
    const done = await waitTerminal(id, 8000);
    assert.equal(done.status, 'canceled');
  } finally { delete process.env.FAKE_SLEEP; }
});

test('SSE replays progress and final status', skip, async () => {
  const r = await api('POST', '/api/v1/jobs', { type: 'terrain', inputPath: path.join(tmp, 'dem.tif') });
  const id = r.json.id;
  const ac = new AbortController();
  const resp = await fetch(base + `/api/v1/jobs/${id}/events`, { signal: ac.signal });
  assert.match(resp.headers.get('content-type'), /text\/event-stream/);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const t0 = Date.now();
  while (!buf.includes('"status":"succeeded"') && Date.now() - t0 < 8000) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  ac.abort();
  assert.ok(buf.includes('event: hello'));
  assert.ok(buf.includes('event: progress'), 'progress events streamed: ' + buf.slice(0, 200));
  assert.ok(buf.includes('event: status'));
});

test('DELETE removes job and workspace', skip, async () => {
  const r = await api('POST', '/api/v1/jobs', { type: 'geojson', inputPath: path.join(tmp, 'dem.tif') });
  // .tif extension: geojson whitelist is geojson/json → expect 422
  assert.equal(r.status, 422);
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'geojson' }));
  fd.append('file', new Blob(['{"type":"FeatureCollection"}']), 'sites.geojson');
  const up = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  const j = await up.json();
  await waitTerminal(j.id);
  const del = await fetch(base + `/api/v1/jobs/${j.id}`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  const gone = await api('GET', `/api/v1/jobs/${j.id}`);
  assert.equal(gone.status, 404);
  await assert.rejects(fsp.stat(path.join(tmp, 'ws', 'jobs', j.id)));
});
