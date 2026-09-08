import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseDotEnv, loadDotEnv } from '../src/dotenv.js';
import { loadConfig, findMgoBinary, PKG_ROOT } from '../src/config.js';

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
  const cfg = loadConfig({});
  assert.equal(cfg.host, '0.0.0.0', 'must be reachable from other machines by default');
  assert.equal(cfg.trustProxy, 'loopback',
    'X-Forwarded-For must only be honored from a local proxy, never blindly');
  assert.ok(cfg.whitelist.includes('127.0.0.1') && cfg.whitelist.includes('::1'));
  assert.equal(typeof cfg.isAllowedIp, 'function');
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
