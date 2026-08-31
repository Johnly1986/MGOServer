import fs from 'node:fs';

/**
 * Zero-dependency `.env` loader.
 *
 * Why not `node --env-file` in the npm script, or the dotenv package: the service
 * has to come back up identically after a reboot — systemd/bare `node src/server.js`
 * skips npm scripts entirely, and a missing `--env-file` argument makes Node abort
 * when the file is absent.  So config loading itself pulls `<repo>/.env` in.
 *
 * Precedence matches the usual convention: an already-set `process.env` value wins
 * over the file, so per-invocation overrides and systemd `Environment=` still work.
 */

/** Parse dotenv text into { KEY: value }. Blank lines and `#` comments are skipped. */
export function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^(export|set)\s+/, '');
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    const quoted = val.length > 1
      && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")));
    if (quoted) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

/**
 * Read `file` (absent/unreadable is normal → no-op) and apply only the keys that
 * `env` does not already define.
 * @returns {Record<string, string>} the entries actually applied (for logging)
 */
export function loadDotEnv(file, env = process.env) {
  if (!file) return {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const applied = {};
  for (const [key, val] of Object.entries(parseDotEnv(text))) {
    if (env[key] === undefined || env[key] === '') { env[key] = val; applied[key] = val; }
  }
  return applied;
}
