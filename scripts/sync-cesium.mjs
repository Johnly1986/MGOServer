/**
 * Copy self-hosted Cesium (pinned 1.111 to match the quantized-mesh decoder
 * calibration in TerrainConverter) from node_modules into public/cesium.
 *
 *   npm i cesium@1.111 --no-save   (one-off, ~large download)
 *   npm run sync:cesium
 *
 * Without this, viewer.html transparently falls back to the Cesium CDN.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'cesium', 'Build', 'Cesium');
const dst = path.join(root, 'public', 'cesium');

if (!fs.existsSync(src)) {
  console.error(`cesium build not found at:\n  ${src}\n`
    + 'install it first:  npm i cesium@1.111 --no-save');
  process.exit(1);
}
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
const sizeMB = (fs.readdirSync(dst)
  .reduce((n, f) => n + (fs.statSync(path.join(dst, f)).size), 0) / 1e6).toFixed(1);
console.log(`synced ${dst} (top-level entries incl. Cesium.js, Workers, Widgets — full tree copied).`);
