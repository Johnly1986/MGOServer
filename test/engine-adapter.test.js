// Engine-adapter regression suite (audit 2026-10).
// Locks the MGOServer <-> MGO CLI contract: schema acceptance/rejection,
// argv mapping, progress modules and the capability probe.  Uses the real
// MGOConsole binary when available (MGO_BINARY), else SKIPs those parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { buildArgs } from '../src/jobs/argv.js';
import { jobSchema } from '../src/jobs/schemas.js';
import { ProgressParser } from '../src/jobs/progress.js';
import { probeMgo } from '../src/mgo.js';
import { JobManager } from '../src/jobs/manager.js';

const io = { input: 'IN', out: 'OUT' };

test('tiles: compressMeshopt/mergeSmallTiles map to engine flags', () => {
  const a = buildArgs({ type: 'tiles', params: { compressMeshopt: true, mergeSmallTiles: true } }, io);
  assert.ok(a.includes('--compress-meshopt'));
  assert.ok(a.includes('--merge-small-tiles'));
  // opt-in only: absent flags when not requested
  const b = buildArgs({ type: 'tiles', params: {} }, io);
  assert.ok(!b.includes('--compress-meshopt') && !b.includes('--merge-small-tiles'));
});

test('tiles/osgb reject autoCrs; mesh accepts it (M1 regression)', () => {
  assert.ok(!jobSchema.safeParse({ type: 'tiles', georef: { autoCrs: true } }).success);
  assert.ok(!jobSchema.safeParse({ type: 'osgb', georef: { autoCrs: true } }).success);
  assert.ok(jobSchema.safeParse({ type: 'mesh', georef: { autoCrs: true } }).success);
  // and the shared builder never emits --auto-crs for non-mesh even if fed raw
  const t = buildArgs({ type: 'tiles', params: { georef: { autoCrs: true } } }, io);
  assert.ok(!t.includes('--auto-crs'));
});

test('terrain accepts NO georef param at all (M2 regression)', () => {
  assert.ok(!jobSchema.safeParse({ type: 'terrain', georef: { mode: '7param' } }).success);
  assert.ok(!jobSchema.safeParse({ type: 'terrain', georef: { sevenParameter: [0, 0, 0, 0, 0, 0, 1] } }).success);
  // builder defense-in-depth: even bypassing the schema, no georef flags ship
  const a = buildArgs({ type: 'terrain', params: { georef: { sevenParameter: [0, 0, 0, 0, 0, 0, 1] } } }, io);
  assert.ok(!a.includes('--7p') && !a.includes('--georef') && !a.includes('--cps'));
});

test('image: zoom/origin/nodata map to engine flags', () => {
  const a = buildArgs({ type: 'image', params: { minZoom: 10, maxZoom: 12, origin: [1, 2, 3], nodata: [0, 0, 0] } }, io);
  for (const f of ['--min-zoom', '10', '--max-zoom', '12', '--origin', '1,2,3', '--nodata', '0,0,0']) {
    assert.ok(a.includes(f), `missing ${f}`);
  }
  assert.ok(jobSchema.safeParse({ type: 'image', minZoom: 10, maxZoom: 12 }).success);
  assert.ok(!jobSchema.safeParse({ type: 'image', minZoom: 30 }).success);   // engine allows 0..24
  assert.ok(!jobSchema.safeParse({ type: 'image', nodata: [0, 0] }).success); // exactly 3
});

test('bim: metadata flag forwards; strategy/idProperty unchanged', () => {
  const a = buildArgs({ type: 'tiles', params: { bim: { bind: true, metadata: true } } }, io);
  assert.ok(a.includes('--bim-bind') && a.includes('--bim-metadata'));
  assert.ok(jobSchema.safeParse({ type: 'tiles', bim: { metadata: true } }).success);
});

test('progress: MeshGroupOptimizer lines are parsed (G6 regression)', () => {
  const p = new ProgressParser();
  assert.equal(p.parse('[MeshGroupOptimizer] Loading model: x'), null);
  const d = p.parse('[MeshGroupOptimizer] Done: 1/1');
  assert.ok(d, 'Done line must parse');
  assert.equal(d.type, 'done');
  assert.equal(d.percent, 100);
  assert.equal(d.module, 'MeshGroupOptimizer');
});

test('probe: --version --json drives capability detection (G7)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'probe-'));
  const fake = path.join(dir, 'fake-mgo.sh');
  await fsp.writeFile(fake, [
    '#!/bin/bash',
    'case "$1 $2" in',
    '  "--version --json") echo \'{"version":"9.9.9","proj":"9.4.0","osgb":true,"features":["validate","meshopt-compression","osgb"]}\' ;;',
    '  "version "*) echo "MGO v9.9.9" ;;',
    '  "help "*) echo "subcommands: tiles terrain image geojson mesh osgb validate" ;;',
    '  "tiles --help") echo "  --bim-bind  --merge-small-tiles  --compress-meshopt" ;;',
    'esac',
  ].join('\n'), { mode: 0o755 });
  const info = await probeMgo(fake);
  assert.equal(info.version, '9.9.9');
  assert.equal(info.hasOsgb, true);
  assert.equal(info.hasBim, true);
  assert.equal(info.hasMeshopt, true);
  assert.equal(info.hasValidate, true);
  assert.equal(info.hasMergeTiles, true);
  await fsp.rm(dir, { recursive: true, force: true });
});

// End-to-end against the REAL engine when provided (ctest/CI sets MGO_BINARY;
// locally: MGO_BINARY=../MGO/build/bin/MGOConsole node --test).
const REAL = process.env.MGO_BINARY;
test('real engine: validateOutput returns structured ok for real output', { skip: !REAL }, async () => {
  const src = process.env.MGO_DEMO_TILES || '/root/coding/MGO/build/demo_out/tiles';
  if (!fs.existsSync(src)) { assert.fail(`no demo tiles output at ${src}; run make demo or set MGO_DEMO_TILES`); }
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'val-'));
  const jobId = 'j1';
  await fsp.cp(src, path.join(workspace, 'jobs', jobId, 'out'), { recursive: true });
  const mock = {
    cfg: { binary: REAL, workspaceRoot: workspace },
    outDir(id) { return path.join(this.cfg.workspaceRoot, 'jobs', id, 'out'); },
  };
  const v = await JobManager.prototype.validateOutput.call(mock, { id: jobId, type: 'tiles', artifacts: [] });
  assert.ok(v, 'validation must parse real validate --json');
  assert.equal(v.ok, true);
  assert.equal(v.kind, '3d-tiles');
  assert.ok(v.contentFiles > 0);
  await fsp.rm(workspace, { recursive: true, force: true });
});
