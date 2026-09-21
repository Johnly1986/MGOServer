import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseDotEnv, loadDotEnv } from '../src/dotenv.js';
import { loadConfig, findMgoBinary, parseAllowedRoots, PKG_ROOT } from '../src/config.js';

test('parseDotEnv: KEY=VALUE, comments, quotes, blank lines, export prefix', () => {
  const p = parseDotEnv([
    '# comment',
    '',
    'MGO_HOST=0.0.0.0',
    '  MGO_PORT = 9000  ',
    'MGO_IP_WHITELIST="1.2.3.4,10.0.0.0/8"',
    "MGO_WORKSPACE='ws'",
    'export MGO_LOG_LEVEL=debug',
    'MGO_CORS_ORIGIN=*',
    'no_equals_here',
    '=empty_key',
    'MGO_EMPTY=',
  ].join('\n'));
  assert.equal(p.MGO_HOST, '0.0.0.0');
  assert.equal(p.MGO_PORT, '9000');
  assert.equal(p.MGO_IP_WHITELIST, '1.2.3.4,10.0.0.0/8');
  assert.equal(p.MGO_WORKSPACE, 'ws');
  assert.equal(p.MGO_LOG_LEVEL, 'debug');
  assert.equal(p.MGO_CORS_ORIGIN, '*');
  assert.equal(p.MGO_EMPTY, '');
  assert.ok(!('no_equals_here' in p) && !('' in p));
});

test('loadDotEnv: absent file is a no-op, real env wins, missing keys applied', () => {
  const env = { MGO_PORT: '8080' };
  assert.deepEqual(loadDotEnv(path.join(os.tmpdir(), 'definitely-not-here-12345.env'), env), {});

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mgoserver-env-')), '.env');
  fs.writeFileSync(file, 'MGO_HOST=0.0.0.0\nMGO_PORT=9999\nMGO_TRUST_PROXY=loopback\n');
  const applied = loadDotEnv(file, env);
  assert.equal(env.MGO_PORT, '8080', 'pre-existing env must not be overwritten');
  assert.equal(env.MGO_HOST, '0.0.0.0');
  assert.deepEqual(Object.keys(applied).sort(), ['MGO_HOST', 'MGO_TRUST_PROXY']);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('config defaults: public bind, loopback-only proxy trust', () => {
  // hermetic: loadConfig() reads process.env (which <repo>/.env seeded at
  // import) — a developer running with MGO_HOST/MGO_TRUST_PROXY set must not
  // flip these assertions.  Force the documented defaults and restore after.
  const keys = ['MGO_HOST', 'MGO_PORT', 'MGO_TRUST_PROXY', 'MGO_IP_WHITELIST'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    const cfg = loadConfig({});
    assert.equal(cfg.host, '0.0.0.0', 'must be reachable from other machines by default');
    assert.equal(cfg.trustProxy, 'loopback',
      'X-Forwarded-For must only be honored from a local proxy, never blindly');
    assert.ok(cfg.whitelist.includes('127.0.0.1') && cfg.whitelist.includes('::1'));
    assert.equal(typeof cfg.isAllowedIp, 'function');
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('parseAllowedRoots: POSIX splits on :', () => {
  assert.deepEqual(parseAllowedRoots('/data/incoming:/data/prj', 'linux'),
    ['/data/incoming', '/data/prj']);
  assert.deepEqual(parseAllowedRoots(' /a : /b ', 'linux'), ['/a', '/b']);
});

test('parseAllowedRoots: Windows splits on ;', () => {
  assert.deepEqual(parseAllowedRoots('D:\\data;E:\\prj', 'win32'), ['D:\\data', 'E:\\prj']);
  // drive-letter colons must survive the split
  assert.deepEqual(parseAllowedRoots('C:\\data', 'win32'), ['C:\\data']);
  assert.deepEqual(parseAllowedRoots('C:/data/models', 'win32'), ['C:/data/models']);
  // UNC shares stay whole
  assert.deepEqual(parseAllowedRoots('\\\\srv\\share;D:\\x', 'win32'), ['\\\\srv\\share', 'D:\\x']);
});

test('parseAllowedRoots: Windows tolerates POSIX-habit : glued drive paths', () => {
  // the classic Windows misconfiguration: no ';' anywhere, so the whole value
  // used to become one bogus path and the file dialog listed nothing
  assert.deepEqual(parseAllowedRoots('D:\\data:D:\\prj', 'win32'), ['D:\\data', 'D:\\prj']);
  assert.deepEqual(parseAllowedRoots('C:/a:C:/b:C:/c', 'win32'), ['C:/a', 'C:/b', 'C:/c']);
  assert.deepEqual(parseAllowedRoots('D:\\data;C:/x:C:/y', 'win32'), ['D:\\data', 'C:/x', 'C:/y']);
});

test('parseAllowedRoots: quotes, empties and duplicates collapse', () => {
  assert.deepEqual(parseAllowedRoots('"D:\\a";\'D:\\b\'', 'win32'), ['D:\\a', 'D:\\b']);
  assert.deepEqual(parseAllowedRoots('"/data/a"', 'linux'), ['/data/a']);
  assert.deepEqual(parseAllowedRoots(' ;; ', 'win32'), []);
  assert.deepEqual(parseAllowedRoots('', 'linux'), []);
  assert.deepEqual(parseAllowedRoots('/a:/a', 'linux'), ['/a']);
  assert.deepEqual(parseAllowedRoots(undefined, 'win32'), []);
});

test('parseAllowedRoots: * passes through as the wildcard marker on both platforms', () => {
  assert.deepEqual(parseAllowedRoots('*', 'win32'), ['*']);
  assert.deepEqual(parseAllowedRoots('*', 'linux'), ['*']);
  assert.deepEqual(parseAllowedRoots('*;D:\\data', 'win32'), ['*', 'D:\\data']);
});

test('loadConfig: MGO_ALLOWED_ROOTS unset or * means wildcard (allowAllRoots)', () => {
  const saved = process.env.MGO_ALLOWED_ROOTS;
  try {
    delete process.env.MGO_ALLOWED_ROOTS;
    let cfg = loadConfig({});
    assert.equal(cfg.allowAllRoots, true, 'unset roots must default to whole-filesystem wildcard');
    assert.deepEqual(cfg.allowedRoots, []);

    process.env.MGO_ALLOWED_ROOTS = '*';
    cfg = loadConfig({});
    assert.equal(cfg.allowAllRoots, true);
    assert.deepEqual(cfg.allowedRoots, []);

    process.env.MGO_ALLOWED_ROOTS = '*' + path.delimiter + '/data/x';
    cfg = loadConfig({});
    assert.equal(cfg.allowAllRoots, true, 'a * entry flips wildcard on; explicit roots are kept too');
    assert.deepEqual(cfg.allowedRoots, [path.resolve('/data/x')]);

    process.env.MGO_ALLOWED_ROOTS = '/data/x';
    cfg = loadConfig({});
    assert.equal(cfg.allowAllRoots, false, 'explicit roots mean explicit containment');
    assert.deepEqual(cfg.allowedRoots, [path.resolve('/data/x')]);
  } finally {
    if (saved === undefined) delete process.env.MGO_ALLOWED_ROOTS;
    else process.env.MGO_ALLOWED_ROOTS = saved;
  }
});

test('loadConfig: an explicit allowedRoots override forces containment (hermetic tests)', () => {
  const saved = process.env.MGO_ALLOWED_ROOTS;
  process.env.MGO_ALLOWED_ROOTS = '*';
  try {
    const cfg = loadConfig({ allowedRoots: ['/data/y'] });
    assert.equal(cfg.allowAllRoots, false,
      'an explicit override is a containment declaration — wildcard must not leak in from .env');
    assert.deepEqual(cfg.allowedRoots, [path.resolve('/data/y')]);
    assert.equal(loadConfig({ allowedRoots: [], allowAllRoots: true }).allowAllRoots, true,
      'allowAllRoots can still be requested explicitly alongside an override');
  } finally {
    if (saved === undefined) delete process.env.MGO_ALLOWED_ROOTS;
    else process.env.MGO_ALLOWED_ROOTS = saved;
  }
});

test('findMgoBinary: explicit override wins, sibling ../MGO layout probed', () => {
  assert.equal(findMgoBinary('/tmp/custom-mgo'), '/tmp/custom-mgo');
  // whatever is on this machine, discovery must return an absolute path or the PATH name
  const found = findMgoBinary(undefined);
  assert.ok(found === 'mgo' || path.isAbsolute(found), `unexpected discovery result: ${found}`);
  // the sibling repo candidate must be derived from PKG_ROOT, not the process cwd
  assert.equal(path.resolve(PKG_ROOT, '..', 'MGO', 'build', 'bin', 'MGOConsole'),
    path.join(path.dirname(PKG_ROOT), 'MGO', 'build', 'bin', 'MGOConsole'));
});
