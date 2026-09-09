import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobManager } from '../src/jobs/manager.js';

const cfg = (workspaceRoot) => ({
  workspaceRoot,
  maxConcurrentJobs: 2,
  queueMax: 10,
  minFreeGb: 0,
  ttlDays: 7,
  jobTimeoutS: 30,
  binary: 'true',
  tilesToolsCli: null,
});

test('sweepStaleTmp removes orphaned upload dirs, keeps fresh ones', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mgo-mgr-'));
  const tmp = path.join(root, 'tmp');
  await fsp.mkdir(tmp, { recursive: true });
  const m = new JobManager(cfg(root));
  try {
    // one fresh staged dir (mtime now) and one stale (mtime > 1h ago)
    await fsp.mkdir(path.join(tmp, 'fresh-upload'));
    const stale = path.join(tmp, 'old-crash-leftover');
    await fsp.mkdir(stale);
    await fsp.writeFile(path.join(stale, 'payload.bin'), 'x');
    const past = new Date(Date.now() - 2 * 3600_000);
    await fsp.utimes(stale, past, past);

    await m.sweepStaleTmp(3600_000);

    const left = await fsp.readdir(tmp);
    assert.deepEqual(left.sort(), ['fresh-upload'], 'stale dir must be swept, fresh kept');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('sweepStaleTmp is a no-op when tmp is missing', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mgo-mgr2-'));
  const m = new JobManager(cfg(root));
  try {
    await m.sweepStaleTmp();   // must not throw
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
