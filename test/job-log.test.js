// Console log/progress regression suite (2026-10 user report).
//
// The console showed two symptoms against a 3-file tiles job:
//   1. `[progress] 97/97 (32%)` — per-file done/total mixed with the globally
//      folded percent;
//   2. the "real-time" section repeated the whole history above it — the SSE
//      endpoint replayed every buffered event on first connect while the panel
//      had already rendered run.log history.
//
// Both are locked here: scaleProgress keeps one scale, and replayed SSE events
// carry `replay: true` so the console can skip the duplicate log lines.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { scaleProgress } from '../src/jobs/progress.js';

const IS_WIN = process.platform === 'win32';
const FAKE = path.join(import.meta.dirname, 'fixtures', 'fake-mgo.sh');

// ---------------------------------------------------------------- pure logic
test('multi-file progress: done/total/percent share one global scale', () => {
  // 3-file job: first file finishes → 32/100 (32%), never 97/97 (32%).
  const first = scaleProgress({ percent: 100 }, { index: 0, files: 3 });
  assert.deepEqual(first, { done: 32, total: 100, percent: 32 });

  const mid = scaleProgress({ percent: 50 }, { index: 1, files: 3 });
  assert.equal(mid.total, 100);
  assert.equal(mid.done, mid.percent, 'done must equal percent on the global scale');

  const last = scaleProgress({ percent: 100 }, { index: 2, files: 3 });
  assert.equal(last.total, 100);
  assert.ok(last.percent >= 97 && last.percent <= 98,
    `final file stays below 100 until artifacts are ready, got ${last.percent}`);
});

// --------------------------------------------------------------- live server
let app; let base; let tmp;

before(async () => {
  if (IS_WIN) return; // fake binary is bash-only
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mgo-log-'));
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

test('SSE replay is flagged so the console does not duplicate history', skip, async () => {
  const input = path.join(tmp, 'pts.geojson');
  await fsp.writeFile(input, '{"type":"FeatureCollection","features":[]}');
  const r = await fetch(`${base}/api/v1/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'geojson', inputPath: input }),
  });
  assert.equal(r.status, 201);
  const { id } = await r.json();

  // wait for a terminal state so the event buffer has replayable entries
  const deadline = Date.now() + 15000;
  for (;;) {
    const j = await (await fetch(`${base}/api/v1/jobs/${id}`)).json();
    if (['succeeded', 'failed', 'canceled', 'usage_error'].includes(j.status)) break;
    if (Date.now() > deadline) throw new Error('job did not finish');
    await new Promise((res) => setTimeout(res, 100));
  }

  // log history (already rendered by the panel) exists…
  const log = await (await fetch(`${base}/api/v1/jobs/${id}/log?tail=300`)).json();
  assert.ok(log.lines.length > 0, 'run.log history must be non-empty');
  // engine version is the first thing in run.log — banner/version questions
  // ("why is there no banner?") are answered without guessing
  assert.ok(log.lines.some((l) => l.startsWith('[Service] engine: MGO v')),
    'run.log must record the engine version');

  // …and every replayed SSE event is marked, so the panel can skip duplicates
  const ctrl = new AbortController();
  const sse = await fetch(`${base}/api/v1/jobs/${id}/events`, { signal: ctrl.signal });
  const reader = sse.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const stop = Date.now() + 4000;
  while (Date.now() < stop) {
    const { value, done } = await reader.read().catch(() => ({ done: true }));
    if (done) break;
    buf += dec.decode(value, { stream: true });
    if (/"replay":true/.test(buf) && /"type":"status"/.test(buf)) break;
  }
  ctrl.abort();
  assert.match(buf, /"replay":true/, 'replayed events must carry replay:true');
  assert.match(buf, /"type":"hello"/, 'stream must start with the hello frame');
});