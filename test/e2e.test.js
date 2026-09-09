import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import yazl from 'yazl';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const IS_WIN = process.platform === 'win32';
const FAKE = path.join(import.meta.dirname, 'fixtures', 'fake-mgo.sh');
const FAKE_TOOL = path.join(import.meta.dirname, 'fixtures', 'fake-3d-tiles-tools.sh');

let app; let base; let tmp;
let app2; let base2;   // merge-failure sandbox: fake 3d-tiles-tools + tiny input cap

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

  app2 = await buildApp(loadConfig({
    binary: FAKE,
    tilesToolsCli: FAKE_TOOL,
    maxInputFiles: 2,
    workspaceRoot: path.join(tmp, 'ws2'),
    maxConcurrentJobs: 1,
    queueMax: 5,
    minFreeGb: 0,
    ttlDays: 7,
    jobTimeoutS: 30,
    allowLocalPath: true,
    allowedRoots: [tmp],
    logLevel: 'silent',
  }));
  await app2.listen({ host: '127.0.0.1', port: 0 });
  base2 = `http://127.0.0.1:${app2.server.address().port}`;
});

after(async () => {
  if (IS_WIN) return;
  await app.close();
  await app2.close();
  await fsp.rm(tmp, { recursive: true, force: true });
});

const skip = IS_WIN && { skip: 'fake mgo binary is bash-only' };

async function api(method, p, body, headers = {}, b = base) {
  const r = await fetch(b + p, {
    method,
    headers: body ? { 'content-type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-json */ }
  return { status: r.status, json, headers: r.headers };
}

async function waitTerminal(id, ms = 8000, b = base) {
  const t0 = Date.now();
  for (;;) {
    const { json } = await api('GET', `/api/v1/jobs/${id}`, null, {}, b);
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
  // unified directory logic: single file also lands in out/<stem>/ and is
  // referenced through the merged tileset.json
  const merged = await (await fetch(base + `/ws/${j.id}/out/tileset.json`)).json();
  assert.equal(merged.root.children.length, 1);
  assert.equal(merged.root.children[0].content.uri, 'model/tileset.json');
  const sub = await fetch(base + `/ws/${j.id}/out/model/tileset.json`);
  assert.equal(sub.status, 200);
});

/* ---------------- tiles multi-file conversion + merge ---------------- */

test('tiles multi-file via multipart: unified params, per-file dirs, merged tileset', skip, async () => {
  const fd = new FormData();
  fd.append('options', JSON.stringify({
    type: 'tiles', zUp: true, maxLod: 4, refine: 'REPLACE',
    simplify: { error: 0.02 }, origin: [1, 2, 3],
  }));
  fd.append('file', new Blob(['FBXK'], { type: 'application/octet-stream' }), 'tower.fbx');
  fd.append('file', new Blob(['OBJDATA'], { type: 'application/octet-stream' }), 'podium.obj');
  fd.append('file', new Blob(['GLB'], { type: 'application/octet-stream' }), 'statue.glb');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  const txt = await r.text();
  assert.equal(r.status, 201, txt);
  const j = JSON.parse(txt);
  assert.equal(j.inputName, 'tower.fbx (+2)');
  assert.deepEqual(j.inputNames, ['tower.fbx', 'podium.obj', 'statue.glb']);
  const done = await waitTerminal(j.id, 12000);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  assert.equal(done.progress.percent, 100);

  // every input converted into its own out/<stem>/ with the SAME argv params
  const { lines } = await (await fetch(base + `/api/v1/jobs/${j.id}/log?tail=200`)).json();
  const argvLines = lines.filter((l) => l.startsWith('argv:'));
  assert.equal(argvLines.length, 3, 'one mgo invocation per input file');
  const pairs = [['tower.fbx', 'tower'], ['podium.obj', 'podium'], ['statue.glb', 'statue']];
  for (const [i, [file, stem]] of pairs.entries()) {
    assert.match(argvLines[i], new RegExp(`^argv: tiles -i \\S+/input/${file.replace('.', '\\.')} -o \\S+/out/${stem}( |$)`));
    // unified conversion params repeated on every invocation
    assert.ok(argvLines[i].includes(' -Z'), 'zUp on every file');
    assert.ok(argvLines[i].includes('-r REPLACE'), 'refine on every file');
    assert.ok(argvLines[i].includes('--max-lod 4'), 'maxLod on every file');
    assert.ok(argvLines[i].includes('--error 0.02'), 'simplify on every file');
    assert.ok(argvLines[i].includes('--origin 1,2,3'), 'origin on every file');
  }
  assert.ok(lines.some((l) => l.includes('merging 3 tileset(s) with 3d-tiles-tools mergeJson')));
  // service-side argv audit line per invocation (independent of what the engine echoes)
  assert.equal(lines.filter((l) => l.startsWith('[Service] argv: tiles')).length, 3);

  // merged tileset at /out/tileset.json referencing the 3 external tilesets
  const merged = await (await fetch(base + `/ws/${j.id}/out/tileset.json`)).json();
  assert.ok(merged.root.boundingVolume, 'merged root has a boundingVolume');
  const uris = merged.root.children.map((c) => c.content.uri).sort();
  assert.deepEqual(uris, ['podium/tileset.json', 'statue/tileset.json', 'tower/tileset.json']);
  for (const u of uris) {
    const sub = await fetch(base + `/ws/${j.id}/out/${u}`);
    assert.equal(sub.status, 200, `external tileset ${u} served by data plane`);
  }
  const b3 = await fetch(base + `/ws/${j.id}/out/tower/L0/tile.b3dm`);
  assert.equal(b3.status, 200);
  assert.match(b3.headers.get('content-type'), /octet-stream/);
  const tiles = done.artifacts.find((a) => a.role === '3dtiles');
  assert.equal(tiles.url, `/ws/${j.id}/out/tileset.json`);
  assert.ok(done.viewerUrl.includes('type=3dtiles'));
});

test('tiles multi-file dedupes identical names (a.fbx + a.fbx → a, a_2)', skip, async () => {
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'tiles' }));
  fd.append('file', new Blob(['ONE'], { type: 'application/octet-stream' }), 'same.fbx');
  fd.append('file', new Blob(['TWO'], { type: 'application/octet-stream' }), 'same.fbx');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  const txt = await r.text();
  assert.equal(r.status, 201, txt);
  const j = JSON.parse(txt);
  assert.deepEqual(j.inputNames, ['same.fbx', 'same_2.fbx']);
  const done = await waitTerminal(j.id, 12000);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  const merged = await (await fetch(base + `/ws/${j.id}/out/tileset.json`)).json();
  assert.deepEqual(merged.root.children.map((c) => c.content.uri).sort(),
    ['same/tileset.json', 'same_2/tileset.json']);
});

test('tiles multi-file via local inputPaths', skip, async () => {
  const a = path.join(tmp, 'm1.fbx'); const b = path.join(tmp, 'm2.obj');
  await fsp.writeFile(a, 'FBXK'); await fsp.writeFile(b, 'OBJ');
  const r = await api('POST', '/api/v1/jobs', {
    type: 'tiles', inputPaths: [a, b], maxLod: 3,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const done = await waitTerminal(r.json.id, 12000);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  const merged = await (await fetch(base + `/ws/${done.id}/out/tileset.json`)).json();
  assert.deepEqual(merged.root.children.map((c) => c.content.uri).sort(),
    ['m1/tileset.json', 'm2/tileset.json']);
});

test('multi-file upload rejected for non-tiles types', skip, async () => {
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'terrain' }));
  fd.append('file', new Blob(['A']), 'a.tif');
  fd.append('file', new Blob(['B']), 'b.tif');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, 'TOO_MANY_FILES');
});

test('tiles multi-file with a bad extension rejects the whole job', skip, async () => {
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'tiles' }));
  fd.append('file', new Blob(['FBXK']), 'good.fbx');
  fd.append('file', new Blob(['EVIL']), 'bad.exe');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error.code, 'INPUT_EXT');
});

test('inputPaths rejected for non-tiles types', skip, async () => {
  const a = path.join(tmp, 'd1.tif');
  await fsp.writeFile(a, 'x');
  const r = await api('POST', '/api/v1/jobs', { type: 'terrain', inputPaths: [a, a] });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'INPUT_TYPE');
});

test('tiles multi-file beyond maxInputFiles → 400 (and merge works with fake tool)', skip, async () => {
  const mk = (name) => {
    const fd = new FormData();
    fd.append('options', JSON.stringify({ type: 'tiles' }));
    fd.append('file', new Blob(['A'], { type: 'application/octet-stream' }), `${name}1.fbx`);
    fd.append('file', new Blob(['B'], { type: 'application/octet-stream' }), `${name}2.fbx`);
    fd.append('file', new Blob(['C'], { type: 'application/octet-stream' }), `${name}3.fbx`);
    return fd;
  };
  const over = await fetch(base2 + '/api/v1/jobs', { method: 'POST', body: mk('cap') });
  assert.equal(over.status, 400);
  assert.equal((await over.json()).error.code, 'TOO_MANY_INPUT_FILES');

  // cap-2 success path runs through the fake merge tool and records its argv
  process.env.FAKE_MERGE_EXIT = '0';
  try {
    const fd = new FormData();
    fd.append('options', JSON.stringify({ type: 'tiles' }));
    fd.append('file', new Blob(['A'], { type: 'application/octet-stream' }), 'p.fbx');
    fd.append('file', new Blob(['B'], { type: 'application/octet-stream' }), 'q.fbx');
    const ok = await fetch(base2 + '/api/v1/jobs', { method: 'POST', body: fd });
    const okTxt = await ok.text();
    assert.equal(ok.status, 201, okTxt);
    const j = JSON.parse(okTxt);
    const done = await waitTerminal(j.id, 12000, base2);
    assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    const merged = await (await fetch(base2 + `/ws/${j.id}/out/tileset.json`)).json();
    assert.equal(merged.root.children.length, 2);
    const { lines } = await (await fetch(base2 + `/api/v1/jobs/${j.id}/log?tail=200`)).json();
    const mergeLine = lines.find((l) => l.startsWith('merge argv:'));
    assert.ok(mergeLine, 'fake 3d-tiles-tools was invoked');
    assert.match(mergeLine, /^merge argv: mergeJson/);
    assert.match(mergeLine, /-i \S+\/out\/p\/tileset\.json -i \S+\/out\/q\/tileset\.json -o \S+\/out\/tileset\.json$/);
  } finally { delete process.env.FAKE_MERGE_EXIT; }
});

test('merge failure → failed job with MERGE code, per-file results kept', skip, async () => {
  // FAKE_MERGE_EXIT defaults to 1 in the fake tool used by app2
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'tiles' }));
  fd.append('file', new Blob(['A'], { type: 'application/octet-stream' }), 'x1.fbx');
  fd.append('file', new Blob(['B'], { type: 'application/octet-stream' }), 'x2.fbx');
  const r = await fetch(base2 + '/api/v1/jobs', { method: 'POST', body: fd });
  const txt = await r.text();
  assert.equal(r.status, 201, txt);
  const j = JSON.parse(txt);
  const done = await waitTerminal(j.id, 12000, base2);
  assert.equal(done.status, 'failed');
  assert.equal(done.error.code, 'MERGE');
  assert.match(done.error.message, /3d-tiles-tools mergeJson exited with code 1/);
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

/* ---- model + side-car texture tree uploads (tiles / mesh) ----
 * The engine resolves external textures relative to the MODEL's directory,
 * so a folder/ZIP upload must land in input/ with its layout intact. */

test('tiles relPaths tree auto-detects the single model, textures stay beside it', skip, async () => {
  const fd = new FormData();
  fd.append('options', JSON.stringify({
    type: 'tiles',
    relPaths: ['site/root.fbx', 'site/tex01.png', 'site/lua/worn.jpg'],
  }));
  fd.append('file', new Blob(['FBXBIN']), 'f_000001');
  fd.append('file', new Blob(['PNG1']), 'f_000002');
  fd.append('file', new Blob(['JPG1']), 'f_000003');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  const txt = await r.text();
  assert.equal(r.status, 201, txt);
  const j = JSON.parse(txt);
  assert.equal(j.inputName, 'site/root.fbx');
  const done = await waitTerminal(j.id, 15000);
  assert.equal(done.status, 'succeeded');

  const inputDir = path.join(tmp, 'ws', 'jobs', j.id, 'input');
  for (const rel of ['site/root.fbx', 'site/tex01.png', 'site/lua/worn.jpg']) {
    assert.ok((await fsp.stat(path.join(inputDir, rel))).isFile(), `missing ${rel}`);
  }
  const { lines } = await (await fetch(base + `/api/v1/jobs/${j.id}/log?tail=300`)).json();
  const svc = lines.filter((l) => l.startsWith('[Service] argv: tiles'));
  assert.equal(svc.length, 1);
  assert.match(svc[0], /-i \S+\/input\/site\/root\.fbx -o \S+\/out\/site_root( |$)/);
  const merged = await (await fetch(base + `/ws/${j.id}/out/tileset.json`)).json();
  assert.equal(merged.root.children.length, 1);
  assert.equal(merged.root.children[0].content.uri, 'site_root/tileset.json');
});

test('multi-model tree auto-takes all models; stems fold the folder name; unified params', skip, async () => {
  const mk = (extra) => {
    const fd = new FormData();
    fd.append('options', JSON.stringify({
      type: 'tiles',
      relPaths: ['bridge/root.fbx', 'bridge/zhuipo.png', 'roadbed/root.fbx', 'roadbed/concret.png'],
      ...(extra ?? {}),
    }));
    for (let i = 1; i <= 4; i++) fd.append('file', new Blob([`B${i}`]), `f_00000${i}`);
    return fd;
  };
  // 无 modelPaths：tiles 自动把树内全部模型逐一转换再合并（控制台已去掉模型路径框）
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: mk({ origin: [498700, 2929900, 0] }) });
  const txt = await r.text();
  assert.equal(r.status, 201, txt);
  const j = JSON.parse(txt);
  assert.deepEqual(j.inputNames, ['bridge/root.fbx', 'roadbed/root.fbx']);
  assert.equal(j.inputName, 'bridge/root.fbx (+1)');
  const done = await waitTerminal(j.id, 20000);
  assert.equal(done.status, 'succeeded');

  const inputDir = path.join(tmp, 'ws', 'jobs', j.id, 'input');
  for (const rel of ['bridge/root.fbx', 'bridge/zhuipo.png', 'roadbed/root.fbx', 'roadbed/concret.png']) {
    assert.ok((await fsp.stat(path.join(inputDir, rel))).isFile(), `missing ${rel}`);
  }
  const { lines } = await (await fetch(base + `/api/v1/jobs/${j.id}/log?tail=300`)).json();
  const svc = lines.filter((l) => l.startsWith('[Service] argv: tiles'));
  assert.equal(svc.length, 2);
  assert.match(svc[0], /-i \S+\/input\/bridge\/root\.fbx -o \S+\/out\/bridge_root( |$)/);
  assert.match(svc[1], /-i \S+\/input\/roadbed\/root\.fbx -o \S+\/out\/roadbed_root( |$)/);
  const norm = (a) => a.replace(/-i \S+ -o \S+/, '-i <I> -o <O>');
  assert.equal(norm(svc[0]), norm(svc[1]), '两个模型必须使用完全一致的转换参数');
  const merged = await (await fetch(base + `/ws/${j.id}/out/tileset.json`)).json();
  assert.deepEqual(merged.root.children.map((c) => c.content.uri).sort(),
    ['bridge_root/tileset.json', 'roadbed_root/tileset.json']);

  // 显式 modelPaths（API 仍支持）可收窄到一个模型
  const r2 = await fetch(base + '/api/v1/jobs', { method: 'POST',
    body: mk({ modelPaths: ['bridge/root.fbx'] }) });
  assert.equal(r2.status, 201);
  const j2 = JSON.parse(await r2.text());
  assert.equal(j2.inputName, 'bridge/root.fbx');
  assert.deepEqual(j2.inputNames, ['bridge/root.fbx']);
  const done2 = await waitTerminal(j2.id, 20000);
  assert.equal(done2.status, 'succeeded');
  const merged2 = await (await fetch(base + `/ws/${j2.id}/out/tileset.json`)).json();
  assert.deepEqual(merged2.root.children.map((c) => c.content.uri), ['bridge_root/tileset.json']);
});

test('tiles zip upload extracts the tree and keeps textures resolvable', skip, async () => {
  const zip = await makeZip([['site/root.fbx', 'FBXBIN'], ['site/tex01.png', 'PNG1']]);
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'tiles' }));
  fd.append('file', new Blob([zip], { type: 'application/zip' }), 'site.zip');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  const txt = await r.text();
  assert.equal(r.status, 201, txt);
  const j = JSON.parse(txt);
  assert.equal(j.inputName, 'site/root.fbx');
  const done = await waitTerminal(j.id, 15000);
  assert.equal(done.status, 'succeeded');
  assert.ok((await fsp.stat(path.join(tmp, 'ws', 'jobs', j.id, 'input', 'site', 'tex01.png'))).isFile());
  const merged = await (await fetch(base + `/ws/${j.id}/out/tileset.json`)).json();
  assert.equal(merged.root.children[0].content.uri, 'site_root/tileset.json');
});

test('mesh zip tree upload feeds -i with the in-tree model path', skip, async () => {
  const zip = await makeZip([['m/a.fbx', 'FBX'], ['m/tex.png', 'P']]);
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'mesh' }));
  fd.append('file', new Blob([zip], { type: 'application/zip' }), 'm.zip');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  const txt = await r.text();
  assert.equal(r.status, 201, txt);
  const j = JSON.parse(txt);
  assert.equal(j.inputName, 'm/a.fbx');
  const done = await waitTerminal(j.id);
  assert.equal(done.status, 'succeeded');
  const { lines } = await (await fetch(base + `/api/v1/jobs/${j.id}/log?tail=300`)).json();
  const argvLine = lines.find((l) => l.startsWith('argv: mesh'));
  assert.ok(argvLine, 'fake binary logged mesh argv');
  assert.match(argvLine, /-i \S+\/input\/m\/a\.fbx/);
});

/* ---- projection sidecar on the tree channel + proj.prjPath on the path channel ---- */

test('zip tree upload + prj field → --prj lands on the staged _projection.prj', skip, async () => {
  const zip = await makeZip([['site/root.fbx', 'FBXBIN'], ['site/tex01.png', 'PNG1']]);
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'tiles' }));
  fd.append('file', new Blob([zip], { type: 'application/zip' }), 'site.zip');
  fd.append('prj', new Blob(['PROJCS["CGCS2000 / 3-degree GK CM 120E"]']), 'cgcs2000.prj');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  const txt = await r.text();
  assert.equal(r.status, 201, txt);
  const j = JSON.parse(txt);
  const done = await waitTerminal(j.id, 15000);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  const { lines } = await (await fetch(base + `/api/v1/jobs/${j.id}/log?tail=300`)).json();
  const argvLine = lines.find((l) => l.startsWith('[Service] argv: tiles'));
  assert.ok(argvLine, 'service argv audit line present');
  assert.match(argvLine, /--prj \S+\/input\/_projection\.prj/);
  assert.ok((await fsp.stat(path.join(tmp, 'ws', 'jobs', j.id, 'input', '_projection.prj'))).isFile(),
    'side-car projection file kept in the job input dir');
});

test('server-path mode: proj.prjPath feeds --prj, local input processed in place', skip, async () => {
  const dir = path.join(tmp, 'prjroot');
  await fsp.mkdir(dir, { recursive: true });
  const prj = path.join(dir, 'site.prj');
  await fsp.writeFile(prj, 'PROJCS["CGCS2000 / 3-degree GK CM 120E"]');
  const model = path.join(tmp, 'pm.fbx');
  await fsp.writeFile(model, 'FBXK');
  const r = await api('POST', '/api/v1/jobs', {
    type: 'tiles', inputPath: model, proj: { prjPath: prj },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const done = await waitTerminal(r.json.id, 15000);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  const full = await (await fetch(base + `/api/v1/jobs/${r.json.id}`)).json();
  const used = full.params.proj.prjPath;          // realpath-canonicalised by checkParamPaths
  assert.match(used, /site\.prj$/);
  const { lines } = await (await fetch(base + `/api/v1/jobs/${r.json.id}/log?tail=300`)).json();
  const argvLine = lines.find((l) => l.startsWith('[Service] argv: tiles'));
  assert.ok(argvLine, 'service argv audit line present');
  assert.ok(argvLine.includes(`--prj ${used}`), argvLine);
  // local inputs are NEVER moved/copied: model and .prj stay at their origin
  assert.deepEqual(await fsp.readdir(path.join(tmp, 'ws', 'jobs', r.json.id, 'input')), []);
});

test('proj validation: crs | prjPath exactly one, prjPath stays inside allowed roots', skip, async () => {
  const model = path.join(tmp, 'pv.fbx');
  await fsp.writeFile(model, 'FBXK');
  const both = await api('POST', '/api/v1/jobs', {
    type: 'tiles', inputPath: model,
    proj: { crs: 'EPSG:4547', prjPath: path.join(tmp, 'prjroot', 'site.prj') },
  });
  assert.equal(both.status, 422);
  assert.equal(both.json.error.code, 'VALIDATION');
  assert.ok(JSON.stringify(both.json.error.details).includes('exactly one'));
  // an existing file OUTSIDE the roots must be refused by the localpath gate (403)
  const outside = await api('POST', '/api/v1/jobs', {
    type: 'tiles', inputPath: model, proj: { prjPath: '/etc/hostname' },
  });
  assert.equal(outside.status, 403);
});

test('tree channel validation: not-in-tree / no model / wrong types', skip, async () => {
  const fd1 = new FormData();
  fd1.append('options', JSON.stringify({
    type: 'tiles', relPaths: ['a/root.fbx', 'a/t.png'], modelPaths: ['b/root.fbx'] }));
  fd1.append('file', new Blob(['x']), 'f1');
  fd1.append('file', new Blob(['y']), 'f2');
  const r1 = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd1 });
  assert.equal(r1.status, 422);
  assert.equal((await r1.json()).error.code, 'MODEL_NOT_IN_TREE');

  const fd2 = new FormData();
  fd2.append('options', JSON.stringify({ type: 'tiles', relPaths: ['a/tex.png', 'a/tex2.png'] }));
  fd2.append('file', new Blob(['x']), 'f1');
  fd2.append('file', new Blob(['y']), 'f2');
  const r2 = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd2 });
  assert.equal(r2.status, 422);
  assert.equal((await r2.json()).error.code, 'NO_MODEL_IN_TREE');

  const fd3 = new FormData();
  fd3.append('options', JSON.stringify({ type: 'terrain', relPaths: ['t/dem.tif'] }));
  fd3.append('file', new Blob(['x']), 'f1');
  const r3 = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd3 });
  assert.equal(r3.status, 400);
  assert.equal((await r3.json()).error.code, 'INPUT_TYPE');

  // modelPath on a FLAT upload → BAD_OPTIONS
  const fd4 = new FormData();
  fd4.append('options', JSON.stringify({ type: 'tiles', modelPath: 'a.fbx' }));
  fd4.append('file', new Blob(['x']), 'a.fbx');
  const r4 = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd4 });
  assert.equal(r4.status, 422);
  assert.equal((await r4.json()).error.code, 'BAD_OPTIONS');

  // mesh (single-model semantics) still demands disambiguation for multi-candidate trees
  const fd5 = new FormData();
  fd5.append('options', JSON.stringify({ type: 'mesh', relPaths: ['a/x.fbx', 'b/y.fbx'] }));
  fd5.append('file', new Blob(['x']), 'f1');
  fd5.append('file', new Blob(['y']), 'f2');
  const r5 = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd5 });
  assert.equal(r5.status, 422);
  assert.equal((await r5.json()).error.code, 'MODEL_AMBIGUOUS');
});

/* ---- local path inputs are processed IN PLACE (never moved/copied);
 *      tiles/mesh may point inputPath at a model+textures FOLDER ---- */

async function mkTree(files) {
  const root = await fsp.mkdtemp(path.join(tmp, 'lt-'));
  for (const [rel, content] of files) {
    const p = path.join(root, rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, content);
  }
  return root;
}

test('tiles inputPath on a local folder converts IN PLACE (nothing copied)', skip, async () => {
  const root = await mkTree([['site/root.fbx', 'FBXBIN'], ['site/tex01.png', 'PNG']]);
  const dir = path.join(root, 'site');
  const r = await fetch(base + '/api/v1/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'tiles', inputPath: dir }),
  });
  const txt = await r.text();
  assert.equal(r.status, 201, txt);
  const j = JSON.parse(txt);
  assert.equal(j.inputName, 'root.fbx'); // auto-detected single model
  const done = await waitTerminal(j.id, 15000);
  assert.equal(done.status, 'succeeded');

  // in place: sources untouched, job input/ stays EMPTY (no move, no copy)
  assert.ok(fs.existsSync(path.join(dir, 'tex01.png')), 'textures must stay where they are');
  assert.deepEqual(await fsp.readdir(path.join(tmp, 'ws', 'jobs', j.id, 'input')), []);
  const { lines } = await (await fetch(base + `/api/v1/jobs/${j.id}/log?tail=300`)).json();
  const svc = lines.find((l) => l.startsWith('[Service] argv: tiles'));
  assert.ok(svc);
  assert.match(svc, new RegExp(`-i ${dir.replace(/[\\/^$.+*?()[]{}|]/g, '\\\\$&')}\\/root\\.fbx`));
  assert.ok(!svc.includes(`${tmp}/ws/jobs/${j.id}/input`), 'converted path leaked into workspace copy');
  const merged = await (await fetch(base + `/ws/${j.id}/out/tileset.json`)).json();
  assert.equal(merged.root.children[0].content.uri, 'root/tileset.json');
});

test('multi-model local folder: tiles auto-takes every model, in place', skip, async () => {
  const root = await mkTree([
    ['a/root.fbx', 'A'], ['a/tex.png', 'A'], ['b/root.fbx', 'B'], ['b/tex.png', 'B'],
  ]);
  const body = (extra) => JSON.stringify({ type: 'tiles', inputPath: root, ...(extra ?? {}) });
  const r = await fetch(base + '/api/v1/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: body(),
  });
  const txt = await r.text();
  assert.equal(r.status, 201, txt);
  const j = JSON.parse(txt);
  assert.deepEqual(j.inputNames, ['a/root.fbx', 'b/root.fbx']);
  const done = await waitTerminal(j.id, 20000);
  assert.equal(done.status, 'succeeded');
  assert.ok(fs.existsSync(path.join(root, 'a', 'tex.png')), 'source tree must remain intact');
  const merged = await (await fetch(base + `/ws/${j.id}/out/tileset.json`)).json();
  assert.deepEqual(merged.root.children.map((c) => c.content.uri).sort(),
    ['a_root/tileset.json', 'b_root/tileset.json']);
});

test('mesh inputPath on a local folder converts the single model in place', skip, async () => {
  const root = await mkTree([['m/a.fbx', 'FBX'], ['m/tex.png', 'P']]);
  const r = await fetch(base + '/api/v1/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'mesh', inputPath: path.join(root, 'm') }),
  });
  const txt = await r.text();
  assert.equal(r.status, 201, txt);
  const j = JSON.parse(txt);
  assert.equal(j.inputName, 'a.fbx');
  const done = await waitTerminal(j.id);
  assert.equal(done.status, 'succeeded');
  const { lines } = await (await fetch(base + `/api/v1/jobs/${j.id}/log?tail=300`)).json();
  const argv = lines.find((l) => l.startsWith('argv: mesh'));
  assert.match(argv, new RegExp(`-i ${path.join(root, 'm', 'a.fbx').replace(/[\\/^$.+*?()[]{}|]/g, '\\\\$&')}( |$)`));
});

test('local-folder channel guards: inputPaths entries stay files, other types reject dirs', skip, async () => {
  const root = await mkTree([['x/root.fbx', 'F'], ['y/dem.tif', 'T']]);
  // inputPaths (multi, files) must not smuggle a directory entry
  const r1 = await fetch(base + '/api/v1/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'tiles', inputPaths: [path.join(root, 'x'), path.join(root, 'x', 'root.fbx')] }),
  });
  assert.equal(r1.status, 400);
  assert.match((await r1.json()).error.message, /not a file/);
  // terrain inputPath cannot be a folder (only tiles/mesh tree mode)
  const r2 = await fetch(base + '/api/v1/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'terrain', inputPath: path.join(root, 'x') }),
  });
  assert.equal(r2.status, 400);
  assert.match((await r2.json()).error.message, /not a file/);
  // modelPaths on a plain FILE inputPath → BAD_OPTIONS
  const r3 = await fetch(base + '/api/v1/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'tiles', inputPath: path.join(root, 'x', 'root.fbx'), modelPaths: ['x/root.fbx'] }),
  });
  assert.equal(r3.status, 422);
  assert.equal((await r3.json()).error.code, 'BAD_OPTIONS');
});

/* ---------- server file browse (console "服务器路径" picker) ---------- */
async function browse (payload) {
  const r = await fetch(base + '/api/v1/fs/browse', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  return { status: r.status, body: await r.json() };
}

test('fs browse: roots, sorted entries with sizes, dotfiles hidden, parent within root', skip, async () => {
  const dir = await fsp.mkdtemp(path.join(tmp, 'browse-'));
  await fsp.mkdir(path.join(dir, 'zz-sub'));
  await fsp.mkdir(path.join(dir, 'aa-sub'));
  await fsp.writeFile(path.join(dir, 'b.fbx'), 'xxx');
  await fsp.writeFile(path.join(dir, 'a.obj'), 'y');
  await fsp.writeFile(path.join(dir, '.secret'), 'no');

  const roots = (await browse({ path: '' })).body;
  assert.equal(roots.cwd, null);
  const realTmp = await fsp.realpath(tmp);
  assert.ok(roots.roots.some((r) => r.ok && r.path === realTmp));

  const d = (await browse({ path: dir })).body;
  assert.equal(d.cwd, await fsp.realpath(dir));
  assert.deepEqual(d.dirs, ['aa-sub', 'zz-sub']);
  assert.deepEqual(d.files.map((f) => f.name), ['a.obj', 'b.fbx']);
  assert.equal(d.files[1].size, 3);
  assert.equal(d.parent, realTmp); // parent stays inside the root → "up" offered

  const at = (await browse({ path: realTmp })).body;
  assert.equal(at.parent, null); // browsing the root itself must not offer a climb-out
});

test('fs browse: outside roots / missing path / file-as-dir all rejected', skip, async () => {
  assert.equal((await browse({ path: '/etc' })).status, 403);
  const link = path.join(tmp, 'escape-link-' + Date.now());
  await fsp.symlink('/etc', link);
  const esc = await browse({ path: link }); // realpath containment kills symlink escapes
  assert.equal(esc.status, 403);
  await fsp.unlink(link);
  const miss = await browse({ path: path.join(tmp, 'nope-' + Date.now()) });
  assert.equal(miss.status, 400);
  assert.match(miss.body.error.message, /does not exist/);
  const f = path.join(tmp, 'browse-afile.txt');
  await fsp.writeFile(f, 'z');
  const bad = await browse({ path: f });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /not a directory/);
});

test('fs browse: 403 + capability off when allowLocalPath disabled', skip, async () => {
  const app3 = await buildApp(loadConfig({
    binary: FAKE, workspaceRoot: path.join(tmp, 'ws3'), maxConcurrentJobs: 1,
    queueMax: 5, minFreeGb: 0, ttlDays: 7, jobTimeoutS: 30,
    allowLocalPath: false, allowedRoots: [tmp], logLevel: 'silent',
  }));
  await app3.listen({ host: '127.0.0.1', port: 0 });
  try {
    const b3 = `http://127.0.0.1:${app3.server.address().port}`;
    const caps = await (await fetch(b3 + '/api/v1/capabilities')).json();
    assert.equal(caps.features.fsBrowse, false);
    const r = await fetch(b3 + '/api/v1/fs/browse', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: tmp }),
    });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error.code, 'LOCAL_PATH_DISABLED');
  } finally {
    await app3.close();
  }
});

test('maxConcurrentJobs is honored for a burst of queued jobs', skip, async () => {
  // Regression: pump() used to gate on handles.size, but a slot only appears
  // in `handles` once spawn() runs — after start() has already awaited.
  // A synchronous burst therefore drained the entire queue and launched N mgo
  // processes against maxConcurrentJobs=1.  Instrument the binary to record
  // how many runs overlap in time.
  const marker = path.join(tmp, 'burst-' + Date.now() + '.log');
  const wrapper = path.join(tmp, 'burst-mgo.sh');
  await fsp.writeFile(wrapper,
    '#!/usr/bin/env bash\n'
    + 'echo "S $(date +%s%N)" >> "' + marker + '"\n'
    + 'sleep 0.35\n'
    + 'echo "E $(date +%s%N)" >> "' + marker + '"\n'
    + 'exit 0\n');
  await fsp.chmod(wrapper, 0o755);
  const origBinary = app.cfg.binary;
  app.cfg.binary = wrapper;
  const tif = path.join(tmp, 'burst.tif');
  await fsp.writeFile(tif, 'x');
  try {
    const ids = [];
    for (let i = 0; i < 4; i++) {   // fire them back-to-back, no waiting
      const r = await api('POST', '/api/v1/jobs', { type: 'terrain', inputPath: tif });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      ids.push(r.json.id);
    }
    for (const id of ids) await waitTerminal(id, 15000);
    const text = await fsp.readFile(marker, 'utf8');
    const evs = text.trim().split('\n').filter(Boolean);
    assert.equal(evs.length, 8, 'expected 4 start + 4 end markers');
    let active = 0; let peak = 0;
    for (const e of evs) {
      active += e[0] === 'S' ? 1 : -1;
      assert.ok(active >= 0, 'marker imbalance: ' + text);
      peak = Math.max(peak, active);
    }
    assert.equal(peak, 1, `maxConcurrentJobs=1 violated: ${peak} overlapping mgo runs`);
  } finally {
    app.cfg.binary = origBinary;
    delete process.env.FAKE_SLEEP;
  }
});

test('log?tail is clamped: junk/negative/zero values cannot dump the whole log', skip, async () => {
  // Regression: Number("abc")=NaN / tail=0 / tail=-3 slipped past the slice
  // cap (slice(NaN)→slice(0), slice(+3) after -min()) and returned the whole
  // run.log.  A long run can be many MB, so the cap must hold for any input.
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'terrain' }));
  fd.append('file', new Blob(['T']), 'cap.tif');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  const j = await r.json();
  await waitTerminal(j.id);
  const logPath = path.join(tmp, 'ws', 'jobs', j.id, 'run.log');
  // pad the real log with well over 2000 lines so the 2000-line cap is testable
  const pad = Array.from({ length: 2500 }, (_, i) => `pad-line-${i}`).join('\n') + '\n';
  await fsp.appendFile(logPath, pad);

  const tail = async (v) => {
    const q = v === undefined ? '' : `?tail=${encodeURIComponent(v)}`;
    const { json } = await api('GET', `/api/v1/jobs/${j.id}/log${q}`);
    return json.lines;
  };
  const big = await tail(2000);
  assert.equal(big.length, 2000, 'cap should be 2000 lines');
  assert.ok(big.at(-1).startsWith('pad-line-2499'));
  assert.ok((await tail('abc')).length <= 2000, 'NaN tail must not dump whole log');
  assert.ok((await tail('0')).length <= 2000 && (await tail('-3')).length <= 2000
    && (await tail('1e9')).length <= 2000, 'degenerate tail values must stay capped');
  const n3 = await tail(3);
  assert.deepEqual(n3, ['pad-line-2497', 'pad-line-2498', 'pad-line-2499'], 'tail=3 must be last 3 lines');
  // default (no param) is 200
  assert.equal((await tail()).length, 200);
});

test('QUEUE_FULL after a multipart upload leaves no orphan under workspace/tmp', skip, async () => {
  // Regression: staged uploads lived in workspaceRoot/tmp/<uuid>; QUEUE_FULL /
  // DISK_FULL were thrown by manager.create() AFTER the payload had already
  // been streamed there, and nothing ever swept tmp/ — a full queue leaked
  // gigabytes of uploads forever.
  const tmpRoot = path.join(tmp, 'ws', 'tmp');
  await fsp.writeFile(path.join(tmp, 'dem.tif'), 'fake-tif');   // standalone-safe
  const stall = process.env.FAKE_STALL;
  process.env.FAKE_STALL = '5';
  const ids = [];
  try {
    // hold the single run slot + fill the 5-deep queue (6 creates OK)
    for (let i = 0; i < 6; i++) {
      const r = await api('POST', '/api/v1/jobs', { type: 'terrain', inputPath: path.join(tmp, 'dem.tif') });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      ids.push(r.json.id);
    }
    // wait until the queue is actually full (5 pending + 1 running)
    let depth = 0;
    for (let i = 0; i < 100 && depth < 5; i++) {
      const m = await api('GET', '/api/v1/metrics');
      depth = m.json.jobs.queueDepth;
      if (depth < 5) await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(depth, 5, `queue depth ${depth}`);
    const before = await fsp.readdir(tmpRoot);
    // 7th upload streams into tmp/, then create() must 429 and clean it up
    const fd = new FormData();
    fd.append('options', JSON.stringify({ type: 'terrain' }));
    fd.append('file', new Blob(['x'.repeat(1024 * 64)]), 'big.tif');
    const resp = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
    const body = await resp.json().catch(() => null);
    assert.equal(resp.status, 429, JSON.stringify(body));
    assert.equal(body?.error?.code, 'QUEUE_FULL', JSON.stringify(body));
    const after = await fsp.readdir(tmpRoot);
    assert.deepEqual(after, before, 'staged upload must be removed on QUEUE_FULL');
  } finally {
    if (stall === undefined) delete process.env.FAKE_STALL; else process.env.FAKE_STALL = stall;
    // release the queue: cancel whatever is still running/pending
    for (const id of ids) await fetch(base + `/api/v1/jobs/${id}/cancel`, { method: 'POST' }).catch(() => {});
  }
});

test('reserved side-car names are rejected for user content (no silent overwrite)', skip, async () => {
  // Regression: all three upload channels write user content into the staged
  // dir AFTER the side-cars (_projection.prj / _controlpoints.csv / _config.csv)
  // are staged there — a user file with such a name silently overwrote the
  // side-car and the converter consumed the wrong data.
  // 1) flat upload: model named _projection.prj + a real prj side-car
  let fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'tiles' }));
  fd.append('file', new Blob(['FBX']), '_projection.prj');
  fd.append('prj', new Blob(['PROJDATA'], { type: 'text/plain' }), 'real.prj');
  let r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  let b = await r.json();
  assert.equal(r.status, 422, JSON.stringify(b));
  assert.equal(b.error.code, 'RESERVED_NAME', JSON.stringify(b));
  // 2) relPaths tree with a root-level reserved entry
  fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'tiles', relPaths: ['_projection.prj', 'site/tex.png'] }));
  fd.append('file', new Blob(['P']), 'f_000001');
  fd.append('file', new Blob(['T']), 'f_000002');
  r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  b = await r.json();
  assert.equal(r.status, 422, JSON.stringify(b));
  assert.equal(b.error.code, 'RESERVED_NAME');
  // 3) zip with a root-level reserved entry
  const zip = await makeZip([['_projection.prj', 'EVIL'], ['site/root.fbx', 'FBX']]);
  fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'tiles' }));
  fd.append('file', new Blob([zip], { type: 'application/zip' }), 'tree.zip');
  r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  b = await r.json();
  assert.equal(r.status, 422, JSON.stringify(b));
  assert.equal(b.error.code, 'RESERVED_NAME');
  // 4) nested paths are fine — only the staged-dir root level is shared
  fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'tiles', relPaths: ['site/_projection.prj', 'site/root.fbx'] }));
  fd.append('file', new Blob(['P']), 'f_000001');
  fd.append('file', new Blob(['F']), 'f_000002');
  r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  b = await r.json();
  assert.equal(r.status, 201, JSON.stringify(b));
  const done = await waitTerminal(b.id, 15000);
  assert.ok(['succeeded', 'failed'].includes(done.status), 'job ran (no reserved-name rejection)');
});

/* ---- manager outcome branches with no prior coverage ---- */

test('exit code 2 → usage_error (service argv mapping surfaced loudly)', skip, async () => {
  process.env.FAKE_EXIT = '2';
  try {
    const r = await api('POST', '/api/v1/jobs', { type: 'terrain', inputPath: path.join(tmp, 'dem.tif') });
    const done = await waitTerminal(r.json.id);
    assert.equal(done.status, 'usage_error');
    assert.equal(done.error.code, 'USAGE_ERROR');
    assert.match(done.error.message, /rejected the arguments/);
  } finally { delete process.env.FAKE_EXIT; }
});

test('job timeout → canceled with TIMEOUT error', skip, async () => {
  const appT = await buildApp(loadConfig({
    binary: FAKE, workspaceRoot: path.join(tmp, 'wsTimeout'), maxConcurrentJobs: 1,
    queueMax: 5, minFreeGb: 0, ttlDays: 7, jobTimeoutS: 2,
    allowLocalPath: true, allowedRoots: [tmp], logLevel: 'silent',
  }));
  await appT.listen({ host: '127.0.0.1', port: 0 });
  const bT = `http://127.0.0.1:${appT.server.address().port}`;
  process.env.FAKE_STALL = '10';
  try {
    const fd = new FormData();
    fd.append('options', JSON.stringify({ type: 'terrain' }));
    fd.append('file', new Blob(['T']), 't.tif');
    const r = await fetch(bT + '/api/v1/jobs', { method: 'POST', body: fd });
    const j = await r.json();
    const done = await waitTerminal(j.id, 15000, bT);
    assert.equal(done.status, 'canceled');
    assert.equal(done.error?.code, 'TIMEOUT');
  } finally {
    delete process.env.FAKE_STALL;
    await appT.close();
  }
});

test('exit 0 without output → NO_ARTIFACTS; missing binary → SPAWN failure', skip, async () => {
  const silent = path.join(tmp, 'silent-mgo.sh');
  await fsp.writeFile(silent, '#!/usr/bin/env bash\nexit 0\n');
  await fsp.chmod(silent, 0o755);
  const mk = (binary, ws) => buildApp(loadConfig({
    binary, workspaceRoot: path.join(tmp, ws), maxConcurrentJobs: 1, queueMax: 5,
    minFreeGb: 0, ttlDays: 7, jobTimeoutS: 30, allowLocalPath: false,
    allowedRoots: [tmp], logLevel: 'silent',
  }));
  const aNo = await mk(silent, 'wsNoArt');
  const aSp = await mk(path.join(tmp, 'no-such-binary'), 'wsSpawn');
  await aNo.listen({ host: '127.0.0.1', port: 0 });
  await aSp.listen({ host: '127.0.0.1', port: 0 });
  try {
    const post = (bT) => {
      const fd = new FormData();
      fd.append('options', JSON.stringify({ type: 'terrain' }));
      fd.append('file', new Blob(['T']), 't.tif');
      return fetch(bT + '/api/v1/jobs', { method: 'POST', body: fd });
    };
    const bNo = `http://127.0.0.1:${aNo.server.address().port}`;
    const bSp = `http://127.0.0.1:${aSp.server.address().port}`;
    const d1 = await waitTerminal((await (await post(bNo)).json()).id, 15000, bNo);
    assert.equal(d1.status, 'failed');
    assert.equal(d1.error.code, 'NO_ARTIFACTS');
    const d2 = await waitTerminal((await (await post(bSp)).json()).id, 15000, bSp);
    assert.equal(d2.status, 'failed');
    assert.equal(d2.error.code, 'SPAWN');
    assert.match(d2.error.message, /cannot launch mgo binary/);
  } finally {
    await aNo.close();
    await aSp.close();
  }
});

test('side-car attachments are type-gated (prj/cps/cfg)', skip, async () => {
  // The CLI never reads these flags for the excluded types; accepting the
  // upload used to silently drop it while the job reported success.
  const expectReject = async (type, field, filename, content) => {
    const fd = new FormData();
    fd.append('options', JSON.stringify({ type }));
    fd.append('file', new Blob(['X']), type === 'geojson' ? 'a.geojson' : 'a.tif');
    fd.append(field, new Blob([content]), filename);
    const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
    const b = await r.json().catch(() => null);
    assert.equal(r.status, 422, `${type}+${field}: ${JSON.stringify(b)}`);
    assert.equal(b?.error?.code, 'SIDE_CAR_UNSUPPORTED', JSON.stringify(b));
  };
  await expectReject('geojson', 'prj', 'a.prj', 'PROJ');
  await expectReject('image', 'cps', 'p.csv', 'sx,sy');
  await expectReject('tiles', 'cfg', 'c.csv', 'name,err');
  // supported combos still pass validation (and run to completion with the fake)
  const fd = new FormData();
  fd.append('options', JSON.stringify({ type: 'terrain' }));
  fd.append('file', new Blob(['T']), 't.tif');
  fd.append('prj', new Blob(['PROJDATA']), 'a.prj');
  fd.append('cps', new Blob(['sx,sy,sz,tx,ty,tz\n1,2,3,4,5,6']), 'p.csv');
  const r = await fetch(base + '/api/v1/jobs', { method: 'POST', body: fd });
  const b = await r.json().catch(() => null);
  assert.equal(r.status, 201, JSON.stringify(b));
  const done = await waitTerminal(b.id, 15000);
  assert.ok(['succeeded', 'failed'].includes(done.status));
});
