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
