import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadWhitelist, ipAllowed } from './ipmatch.js';
import { loadDotEnv } from './dotenv.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = path.resolve(here, '..');

/** package.json identity, surfaced by /api/v1/health instead of a hardcoded string. */
export const PKG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')); }
  catch { return { name: 'mgoserver', version: '0.0.0' }; }
})();

/**
 * Pull `<repo>/.env` into process.env before anything reads configuration, so a
 * restarted service (systemd, bare `node src/server.js`, container entrypoint)
 * behaves exactly like the session it was hand-started in.  `MGO_ENV_FILE` points
 * at an alternative path; real environment variables always win over the file.
 */
export const ENV_FILE = process.env.MGO_ENV_FILE || path.join(PKG_ROOT, '.env');
export const dotEnvKeys = Object.keys(loadDotEnv(ENV_FILE));

function env(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function envInt(name, def) {
  const v = parseInt(env(name, ''), 10);
  return Number.isFinite(v) ? v : def;
}
function envBool(name, def) {
  const v = env(name, undefined);
  if (v === undefined) return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

/** Platform sub-directory of build/bin/ that holds the bundled engine binary
 *  and its side-car libraries: windows/ for MGOConsole.exe + .dll, linux/ for
 *  MGOConsole + .so ($ORIGIN RUNPATH, so the folder can move freely). */
export const PLATFORM_BIN_DIR = process.platform === 'win32' ? 'windows' : 'linux';

/**
 * Locate the mgo executable.
 *
 * Search order:
 *   1. MGO_BINARY — explicit override, always wins
 *   2. ./build/bin/<platform>/  — binary bundled with this repo, windows/ or linux/
 *      (falls back to a flat ./build/bin/ from older layouts)
 *   3. ../MGO/build/bin/**   — sibling checkout (dev layout, engine built separately)
 *   4. <parent>/build/bin/** — legacy, when this code still lived in MGO/mgo-server
 *   5. 'mgo' on PATH
 */
export function findMgoBinary(explicit) {
  // An explicit MGO_BINARY is authoritative, even if the path is wrong: silently
  // falling back to whatever `mgo` happens to be on PATH turns a typo into "the
  // wrong binary ran".  probeMgo() reports { path, found:false } and startup warns.
  if (explicit) return explicit;

  const bins = ['MGOConsole', 'MGOConsole.exe', path.join('Release', 'MGOConsole.exe')];
  const cands = [];
  const roots = [];
  for (const root of [PKG_ROOT, path.resolve(PKG_ROOT, '..', 'MGO'), path.resolve(PKG_ROOT, '..')]) {
    roots.push(path.join(root, 'build', 'bin', PLATFORM_BIN_DIR), path.join(root, 'build', 'bin'));
  }
  for (const dir of roots) for (const b of bins) cands.push(path.join(dir, b));
  cands.push('mgo');
  for (const c of cands) {
    try { if (c === 'mgo' || fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return 'mgo';
}

/**
 * Which peers may rewrite the client IP via X-Forwarded-For.
 * 'loopback' (default) = a reverse proxy on this machine; a number = that many
 * trailing hops are trusted; any other value is handed to proxy-addr as a subnet
 * list (e.g. '10.0.0.0/8, 127.0.0.1').  Never 'true': that lets any remote client
 * forge `X-Forwarded-For: 127.0.0.1` and walk past both IP gates.
 */
function envTrustProxy() {
  const v = env('MGO_TRUST_PROXY', 'loopback');
  return /^\d+$/.test(v) ? Number(v) : v;
}

export function loadConfig(overrides = {}) {
  const base = {
    host: env('MGO_HOST', '0.0.0.0'),
    port: envInt('MGO_PORT', 8080),
    binary: findMgoBinary(env('MGO_BINARY', undefined)),
    workspaceRoot: path.resolve(PKG_ROOT, env('MGO_WORKSPACE', 'workspace')),
    corsOrigin: env('MGO_CORS_ORIGIN', '*'),
    uploadMaxBytes: envInt('MGO_UPLOAD_MAX_BYTES', 2 * 1024 ** 3),
    uploadMaxFiles: envInt('MGO_UPLOAD_MAX_FILES', 5000),
    minFreeGb: envInt('MGO_MIN_FREE_GB', 10),
    maxConcurrentJobs: envInt('MGO_MAX_CONCURRENT_JOBS', 1),
    queueMax: envInt('MGO_QUEUE_MAX', 100),
    jobTimeoutS: envInt('MGO_JOB_TIMEOUT_S', 4 * 3600),
    ttlDays: envInt('MGO_TTL_DAYS', 7),
    allowLocalPath: envBool('MGO_ALLOW_LOCAL_PATH', false),
    allowedRoots: String(env('MGO_ALLOWED_ROOTS', ''))
      .split(path.delimiter).filter(Boolean).map((p) => path.resolve(p)),
    publicDir: path.join(PKG_ROOT, 'public'),
    cesiumLocalEntry: path.join(PKG_ROOT, 'public', 'cesium', 'Cesium.js'),
    logLevel: env('MGO_LOG_LEVEL', 'info'),
    trustProxy: envTrustProxy(),
  };
  const cfg = { ...base, ...overrides };

  // IP whitelist for write operations: localhost is always allowed, plus
  // MGO_IP_WHITELIST (comma-separated IP/CIDR) plus <workspace>/whitelist.json
  // (runtime-managed via POST /api/v1/whitelist — localhost only).
  const whitelistFile = path.join(cfg.workspaceRoot, 'whitelist.json');
  const whitelist = loadWhitelist({ envList: env('MGO_IP_WHITELIST', ''), filePath: whitelistFile });
  return {
    ...cfg,
    whitelistFile,
    whitelist,                                   // live array (routes push into it at runtime)
    isAllowedIp: (ip) => ipAllowed(ip, whitelist),
  };
}
