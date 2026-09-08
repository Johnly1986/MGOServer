import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProgressParser, isModuleLine } from '../src/jobs/progress.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('golden fixture: real terrain run log parses to 4/4 100%', () => {
  const log = fs.readFileSync(path.join(here, 'fixtures/terrain-real.log'), 'utf8');
  const p = new ProgressParser();
  let progressEvents = 0;
  let last = null;
  for (const line of log.split('\n')) {
    const ev = p.parse(line);
    if (ev) { progressEvents++; last = ev; }
  }
  assert.ok(progressEvents >= 2, 'Progress + Done lines both recognized');
  assert.equal(last.type, 'done');
  assert.equal(last.done, 4);
  assert.equal(last.total, 4);
  assert.equal(last.percent, 100);
});

test('Progress line yields normalized fields', () => {
  const p = new ProgressParser();
  const ev = p.parse('[TilesConverter] Progress: 12/57');
  assert.equal(ev.type, 'progress');
  assert.equal(ev.done, 12);
  assert.equal(ev.total, 57);
  assert.equal(ev.percent, 21);
  assert.equal(ev.module, 'TilesConverter');
  assert.equal(ev.phase, 'tiles');
});

test('monotonic within same total', () => {
  const p = new ProgressParser();
  p.parse('[TerrainConverter] Progress: 5/10');
  const ev = p.parse('[TerrainConverter] Progress: 3/10'); // stale/interleaved
  assert.equal(ev.done, 5);
  assert.equal(ev.percent, 50);
});

test('ImageTiler granularity is per-level (phase=levels)', () => {
  const p = new ProgressParser();
  assert.equal(p.parse('[ImageTiler] Progress: 7/7').phase, 'levels');
  const done = p.parse('[ImageTiler] Done: 41 tiles (7 levels)');
  assert.equal(done.type, 'done');
  assert.equal(done.percent, 100); // already at 100 from 7/7, stays 100
});

test('OSGB fractional Done snaps to 100%', () => {
  const p = new ProgressParser();
  p.parse('[TerrainConverter] Progress: 0/4');
  const ev = p.parse('[TerrainConverter] Done: 4/4');
  assert.equal(ev.type, 'done');
  assert.equal(ev.percent, 100);
  assert.deepEqual(p.snapshot().percent, 100);
});

test('non-progress lines return null and stay quiet', () => {
  const p = new ProgressParser();
  assert.equal(p.parse('Warning 1: GDAL something'), null);
  assert.equal(p.parse(''), null);
  assert.equal(p.parse('[TerrainConverter] Wrote /tmp/x/0/0/0.terrain (8725 bytes)'), null);
});

test('isModuleLine matches diagnostics prefixes', () => {
  assert.ok(isModuleLine('[TerrainQuadtree] Geographic bounds: W=120'));
  assert.ok(isModuleLine('[TilesConverter] Progress: 1/2'));
  assert.ok(!isModuleLine('random text'));
});
