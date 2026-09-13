#!/usr/bin/env node
/**
 * Deterministic minimal 3D Tiles fixture: ONE b3dm whose glTF carries a legacy
 * `_batchid` vertex attribute + a non-empty Batch Table, plus the tileset.json
 * that places it via a local ENU transform.
 *
 * Purpose: the fake-mgo stub writes this instead of `printf 'b3d0'` so the
 * viewer's click-to-inspect pipeline (scene.pick → Cesium3DTileFeature →
 * getPropertyIds/getProperty) is testable end-to-end without the C++ engine.
 *
 * Two quads side by side (50m tall, 200m deep):
 *   batchId 0 "立方体甲" — local x ∈ [-300,-100] m
 *   batchId 1 "立方体乙" — local x ∈ [+100,+300] m
 * The 200m centre gap lets a test click either half unambiguously.
 *
 * Usage: node make-b3dm.mjs <outDir>   (writes <outDir>/tileset.json + L0/tile.b3dm)
 */
import fs from 'node:fs';
import path from 'node:path';

const LON = 57.5828;  // deg — Gulf of Guinea-ish, matches the suite's toy region
const LAT = 28.9334;
const D2R = Math.PI / 180;

/* ---------- column-major ENU→ECEF 4x4 (WGS84) ---------- */
function enuTransform(lonDeg, latDeg, h = 0) {
  const a = 6378137.0; const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const lon = lonDeg * D2R; const lat = latDeg * D2R;
  const sLat = Math.sin(lat); const cLat = Math.cos(lat);
  const N = a / Math.sqrt(1 - e2 * sLat * sLat);
  const px = (N + h) * cLat * Math.cos(lon);
  const py = (N + h) * cLat * Math.sin(lon);
  const pz = (N * (1 - e2) + h) * sLat;
  const sLon = Math.sin(lon); const cLon = Math.cos(lon);
  // east, north, up basis (WGS84 east = [-sinLon, cosLon, 0]; north/up as usual)
  return [
    -sLon, cLon, 0, 0,
    -sLat * cLon, -sLat * sLon, cLat, 0,
    cLat * cLon, cLat * sLon, sLat, 0,
    px, py, pz, 1,
  ];
}

/* ---------- glTF (positions + _batchid) ---------- */
function quad(x0, x1, batchId, verts) {
  const y = 100; const z0 = 0; const z1 = 50;
  const q = [
    [x0, -y, z0], [x1, -y, z0], [x1, y, z0],   // bottom tri A
    [x0, -y, z0], [x1, y, z0], [x0, y, z0],    // bottom tri B
    [x0, -y, z1], [x1, -y, z1], [x1, y, z1],   // top tri A
    [x0, -y, z1], [x1, y, z1], [x0, y, z1],    // top tri B
    // 4 side walls, 2 tris each (ccw outward-ish; pick only needs coverage)
    [x0, -y, z0], [x0, -y, z1], [x1, -y, z1],
    [x0, -y, z0], [x1, -y, z1], [x1, -y, z0],
    [x1, y, z0], [x1, y, z1], [x0, y, z1],
    [x1, y, z0], [x0, y, z1], [x0, y, z0],
    [x0, y, z0], [x0, y, z1], [x0, -y, z1],
    [x0, y, z0], [x0, -y, z1], [x0, -y, z0],
    [x1, -y, z0], [x1, y, z0], [x1, y, z1],
    [x1, -y, z0], [x1, y, z1], [x1, -y, z1],
  ];
  for (const v of q) { verts.pos.push(...v); verts.id.push(batchId); }
}

function buildGlb() {
  const verts = { pos: [], id: [] };
  quad(-300, -100, 0, verts);
  quad(100, 300, 1, verts);
  const n = verts.pos.length / 3;

  const posArr = Float32Array.from(verts.pos);
  const idArr = Uint8Array.from(verts.id);
  let min = [Infinity, Infinity, Infinity]; let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], posArr[i * 3 + k]);
      max[k] = Math.max(max[k], posArr[i * 3 + k]);
    }
  }
  const posBytes = Buffer.from(posArr.buffer);
  const idBytes = Buffer.from(idArr.buffer);
  const pad4 = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  const posB = pad4(posBytes); const idB = pad4(idBytes);
  const bin = Buffer.concat([posB, idB]);

  const gltf = {
    asset: { version: '2.0', generator: 'mgo-fake-b3dm' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      name: 'twins',
      // Cesium binds the batch table to geometry through the _BATCHID vertex
      // attribute (uppercase — the 3D Tiles b3dm semantic the real engine
      // emits too; lowercase _batchid is ignored → picks return no feature).
      primitives: [{ attributes: { POSITION: 0, _BATCHID: 1 }, mode: 4 }],
    }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.length, target: 34962 },
      { buffer: 0, byteOffset: posB.length, byteLength: idBytes.length, target: 34962 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: n, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5121, count: n, type: 'SCALAR' },
    ],
  };
  const jsonB = Buffer.from(JSON.stringify(gltf), 'utf8');
  const padSpaces = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, 0x20)]);
  const jsonP = padSpaces(jsonB);
  const total = 12 + 8 + jsonP.length + 8 + bin.length;
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii'); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
  const cj = Buffer.alloc(8); cj.writeUInt32LE(jsonP.length, 0); cj.write('JSON', 4, 'ascii');
  const cb = Buffer.alloc(8); cb.writeUInt32LE(bin.length, 0); cb.write('BIN\u0000', 4, 'ascii');
  return Buffer.concat([header, cj, jsonP, cb, bin]);
}

/* ---------- b3dm: 28-byte header + FT JSON + BT JSON (legacy maps) + GLB ---------- */
// 3D Tiles requires the binary glTF body to start on an 8-byte boundary
// (28-byte header + feature table + batch table must be a multiple of 8).
// Cesium silently yields an un-ready content otherwise (no pick, no render).
const padJson = (obj) => {
  let s = JSON.stringify(obj);
  s += ' '.repeat((4 - (Buffer.byteLength(s) % 4)) % 4);
  return Buffer.from(s, 'utf8');
};

const glb = buildGlb();
const ft = padJson({ BATCH_LENGTH: 2 });
let bt = padJson({
  objectId: { 0: 'FakeBoxA', 1: 'FakeBoxB' },
  Name: { 0: '立方体甲', 1: '立方体乙' },
  楼层: { 0: 3, 1: 5 },
  高度: { 0: 50.0, 1: 50.0 },
  结构: { 0: '钢筋混凝土', 1: '钢结构' },
});
{
  const pre = 28 + ft.length + bt.length;
  const extra = (8 - (pre % 8)) % 8;
  if (extra) bt = Buffer.concat([bt, Buffer.alloc(extra, 0x20)]);
}
const body = Buffer.concat([ft, bt, glb]);
const b3dm = Buffer.alloc(28);          // spec: 28-byte header
b3dm.write('b3dm', 0, 'ascii');
b3dm.writeUInt32LE(1, 4);
b3dm.writeUInt32LE(28 + body.length, 8);
b3dm.writeUInt32LE(ft.length, 12);
b3dm.writeUInt32LE(0, 16);
b3dm.writeUInt32LE(bt.length, 20);
b3dm.writeUInt32LE(0, 24);
const outDir = process.argv[2];
fs.mkdirSync(path.join(outDir, 'L0'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'L0', 'tile.b3dm'), Buffer.concat([b3dm, body]));

// local ENU frame (transform column-major) + a local METER box — exactly the
// layout real MGO tiles use: boundingVolume.box is the FLAT 12-number form
// [cx,cy,cz, halfAxes 3x3 row-major] (the {center,halfAxes} object variant is
// NOT parsed by Cesium → empty bounding volume → the tile never traverses).
const tileset = {
  asset: { version: '1.0', tileGenerator: 'mgo-fake-b3dm' },
  geometricError: 500,
  root: {
    transform: enuTransform(LON, LAT),
    boundingVolume: {
      box: [0, 0, 30, 350, 0, 0, 0, 120, 0, 0, 0, 80],
    },
    geometricError: 50,
    refine: 'ADD',
    content: { uri: 'L0/tile.b3dm' },
  },
};
fs.writeFileSync(path.join(outDir, 'tileset.json'), JSON.stringify(tileset));
