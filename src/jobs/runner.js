import { spawn } from 'node:child_process';
import fs from 'node:fs';
import treeKill from 'tree-kill';

function makeLineHandler(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      onLine(line);
    }
  };
}

/**
 * Spawn the mgo CLI in a child process (the ONLY compute path — see design
 * §4.3 route A).  argv is passed as an array: never through a shell.
 *
 * @returns {{promise: Promise<object>, cancel: () => void}}
 *   promise resolves to {ok:true, exitCode, signal, timedOut, canceled}
 *   or {ok:false, error} (spawn failure, e.g. binary missing).
 */
export function runJob({ binary, args, logPath, timeoutMs = 0, onLine }) {
  let killRequested = false;
  let killFn = () => {};

  const promise = new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: String(err?.message ?? err) });
      return;
    }

    const log = fs.createWriteStream(logPath, { flags: 'a' });
    let timedOut = false;
    let settled = false;

    const kill = () => {
      if (child?.pid) treeKill(child.pid, 'SIGTERM', () => {});
    };
    killFn = () => { killRequested = true; kill(); };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', makeLineHandler((l) => { log.write(`${l}\n`); onLine?.(l, 'stdout'); }));
    child.stderr.on('data', makeLineHandler((l) => { log.write(`${l}\n`); onLine?.(l, 'stderr'); }));
    // stdin is 'ignore' → child.stdin is null; nothing to close.

    const timer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; kill(); }, timeoutMs)
      : null;

    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      log.end();
      resolve(r);
    };

    child.on('error', (err) => finish({ ok: false, error: String(err?.message ?? err) }));
    child.on('close', (code, signal) => finish({
      ok: true,
      exitCode: typeof code === 'number' ? code : (killRequested || timedOut ? -1 : (signal ? -1 : 1)),
      signal,
      timedOut,
      canceled: killRequested && !timedOut,
    }));
  });

  return { promise, cancel: () => killFn() };
}
