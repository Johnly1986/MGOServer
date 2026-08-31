import { isIP } from 'node:net';
import fs from 'node:fs';

/**
 * IP whitelist helpers for the API's write-protection layer.
 *
 * Whitelist entries are either an exact IP (IPv4 or IPv6) or a CIDR block
 * ("10.0.0.0/8", "2001:db8::/32").  IPv4-mapped IPv6 addresses
 * (::ffff:1.2.3.4) are normalized to their plain IPv4 form before matching.
 */

/** Normalize IPv4-mapped IPv6 (::ffff:1.2.3.4) to the plain IPv4 form. */
export function normalizeIp(ip) {
  const s = String(ip).trim();
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : s;
}

/**
 * Parse one whitelist entry into a matcher descriptor, or null if invalid.
 * @returns {null | {type:'exact', ip:string, fam:4|6} | {type:'cidr', ip:string, bits:number, fam:4|6}}
 */
export function parseCidr(entry) {
  const s = String(entry).trim();
  if (!s) return null;
  const slash = s.indexOf('/');
  if (slash === -1) {
    const fam = isIP(s);
    return fam ? { type: 'exact', ip: s, fam } : null;
  }
  const addr = s.slice(0, slash);
  const bits = Number(s.slice(slash + 1));
  const fam = isIP(addr);
  if (!fam || !Number.isInteger(bits) || bits < 0 || bits > (fam === 4 ? 32 : 128)) return null;
  return { type: 'cidr', ip: addr, bits, fam };
}

function toBigInt(ip, fam) {
  if (fam === 4) {
    return ip.split('.').reduce((acc, p) => (acc << 8n) | BigInt(Number(p)), 0n);
  }
  // IPv6 (may contain "::")
  const [head, tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  const all = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  return all.reduce((acc, h) => (acc << 16n) | BigInt(parseInt(h || '0', 16)), 0n);
}

/** True when `ip` is allowed by the parsed whitelist `entries` (string forms). */
export function ipAllowed(ip, entries) {
  const norm = normalizeIp(ip);
  const fam = isIP(norm);
  if (!fam) return false;
  for (const raw of entries) {
    const e = parseCidr(raw);
    if (!e) continue;
    if (e.type === 'exact') {
      if (normalizeIp(e.ip) === norm) return true;
      continue;
    }
    if (e.fam !== fam) continue;
    const shift = BigInt(fam === 4 ? 32 - e.bits : 128 - e.bits);
    if (toBigInt(norm, fam) >> shift === toBigInt(e.ip, fam) >> shift) return true;
  }
  return false;
}

/** Addresses that are always allowed (this machine); not removable. */
export const BUILTIN_LOCAL = ['127.0.0.1', '::1'];

/**
 * Load the whitelist: built-in localhost ∪ MGO_IP_WHITELIST (comma-separated
 * IP/CIDR) ∪ <workspace>/whitelist.json (managed via POST /api/v1/whitelist).
 * Invalid entries are dropped silently.
 */
export function loadWhitelist({ envList = '', filePath = '' }) {
  const set = new Set();
  for (const ip of BUILTIN_LOCAL) set.add(normalizeIp(ip));
  for (const raw of String(envList).split(',')) {
    const e = raw.trim();
    if (e && parseCidr(e)) set.add(e);
  }
  if (filePath && fs.existsSync(filePath)) {
    try {
      const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(arr)) {
        for (const raw of arr) {
          const e = String(raw).trim();
          if (e && parseCidr(e)) set.add(e);
        }
      }
    } catch { /* corrupt file → ignore */ }
  }
  return [...set];
}
