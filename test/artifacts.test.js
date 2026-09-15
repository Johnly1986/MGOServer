import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverArtifacts, primaryArtifact } from '../src/jobs/artifacts.js';

async function mk(files) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mgo-art-'));
  for (const [relp, content] of Object.entries(files)) {
    const abs = path.join(dir, relp);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
  return dir;
}

test('terrain discovery: layer.json + .terrain → terrain role', async () => {
  const d = await mk({ 'layer.json': '{}', '2/6/2.terrain': 'x' });
  const arts = await discoverArtifacts('J1', d);
  assert.deepEqual(arts.map((a) => a.role), ['terrain']);
  assert.equal(arts[0].viewer.type, 'terrain');
  assert.ok(arts[0].viewer.url.startsWith('/ws/J1/out'));
});

test('tiles discovery: tileset.json is primary', async () => {
  const d = await mk({ 'tileset.json': '{}', 'L0/t.b3dm': 'x' });
  const arts = await discoverArtifacts('J2', d);
  assert.equal(primaryArtifact(arts).role, '3dtiles');
  assert.equal(arts[0].url, '/ws/J2/out/tileset.json');
});

test('image discovery: png + tilemapresource.xml → imagery', async () => {
  const d = await mk({ 'tilemapresource.xml': '<x/>', '0/0/0.png': 'p', 'layer.json': '{}' });
  const arts = await discoverArtifacts('J3', d);
  assert.ok(arts.some((a) => a.role === 'imagery'));
});

test('geojson + glb roles', async () => {
  const d = await mk({ 'out.geojson': '{}', 'model.glb': 'g' });
  const arts = await discoverArtifacts('J4', d);
  assert.deepEqual(arts.map((a) => a.role).sort(), ['geojson', 'model']);
  const model = arts.find((a) => a.role === 'model');
  assert.equal(model.mediaType, 'model/gltf-binary');
  assert.equal(model.viewer.type, 'model');
});

test('empty out dir yields nothing', async () => {
  const d = await mk({});
  assert.equal((await discoverArtifacts('J5', d)).length, 0);
});

test('glb model: glTF 2.0 gets a preview link, legacy glTF 1.0 is flagged instead', async () => {
  const glb2 = Buffer.alloc(28);
  glb2.write('glTF', 0, 'ascii'); glb2.writeUInt32LE(2, 4); glb2.writeUInt32LE(28, 8);
  glb2.writeUInt32LE(8, 12); glb2.writeUInt32LE(0x4E4F534A, 16); glb2.write('{"a":1}', 20, 'ascii');
  const glb1 = Buffer.alloc(28);
  glb1.write('glTF', 0, 'ascii'); glb1.writeUInt32LE(1, 4); glb1.writeUInt32LE(28, 8);
  glb1.writeUInt32LE(8, 12); glb1.writeUInt32LE(0, 16); glb1.write('{"a":1}', 20, 'ascii');

  const d2 = await mk({ 'model.glb': glb2 });
  const m2 = (await discoverArtifacts('J6', d2)).find((a) => a.role === 'model');
  assert.equal(m2.viewer.type, 'model', 'glTF 2.0 应可直接预览');
  assert.equal(m2.gltfVersion, 2);
  assert.equal(m2.warning, undefined);

  const d1 = await mk({ 'model.glb': glb1 });
  const m1 = (await discoverArtifacts('J7', d1)).find((a) => a.role === 'model');
  assert.equal(m1.viewer, undefined, 'glTF 1.0 不得给出无法工作的预览链接');
  assert.equal(m1.gltfVersion, 1);
  assert.match(m1.warning, /glTF 1\.x/);
  // 下载链接仍在（产物本身要能取回，只是不能预览）
  assert.equal(m1.url, '/ws/J7/out/model.glb');

  const dt = await mk({ 'model.gltf': '{"asset":{"version":"1.0"}}' });
  const mt = (await discoverArtifacts('J8', dt)).find((a) => a.role === 'model');
  assert.equal(mt.gltfVersion, 1);
  assert.match(mt.warning, /仅支持 2\.0/);
});

/** Minimal b3dm whose Batch Table has one binary column descriptor.  `componentType`
 *  is either the spec string enum ("FLOAT") or the legacy glTF number (5126). */
function b3dm(componentType) {
  const bt = Buffer.from(JSON.stringify({
    objectId: ['a'],
    ScalingMax: { byteOffset: 0, componentType, type: 'VEC3' },
  }), 'utf8');
  const ft = Buffer.from('{"BATCH_LENGTH":1}', 'utf8');
  const head = Buffer.alloc(28);
  head.write('b3dm', 0, 'ascii');
  head.writeUInt32LE(1, 4);
  head.writeUInt32LE(28 + ft.length + bt.length, 8);
  head.writeUInt32LE(ft.length, 12);
  head.writeUInt32LE(0, 16);
  head.writeUInt32LE(bt.length, 20);
  head.writeUInt32LE(0, 24);
  return Buffer.concat([head, ft, bt]);
}

async function mkTiles(jobId, componentType) {
  const d = await mk({ 'tileset.json': '{}' });
  await fsp.mkdir(path.join(d, 'L0'), { recursive: true });
  await fsp.writeFile(path.join(d, 'L0/t.b3dm'), b3dm(componentType));
  return (await discoverArtifacts(jobId, d)).find((a) => a.role === '3dtiles');
}

test('legacy BIM b3dm (numeric Batch Table componentType) loses its viewer link', async () => {
  // 旧引擎把 componentType 写成 glTF 数字枚举 → Cesium parseBatchTable 抛
  // "Cannot read properties of undefined (reading 'buffer')"，不能给 查看 链接
  const tiles = await mkTiles('J9', 5126);
  assert.equal(tiles.viewer, undefined);
  assert.equal(tiles.batchTableComponentType, 'numeric');
  assert.match(tiles.warning, /componentType/);
  assert.equal(tiles.url, '/ws/J9/out/tileset.json');   // 产物仍可下载
});

test('spec-compliant b3dm (string Batch Table componentType) keeps its viewer link', async () => {
  const tiles = await mkTiles('J10', 'FLOAT');
  assert.equal(tiles.viewer.type, '3dtiles');
  assert.equal(tiles.warning, undefined);
});
