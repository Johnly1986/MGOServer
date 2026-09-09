import { fromBufferPromise } from 'yauzl';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

/**
 * Stream-extract a ZIP buffer into `destDir`, preserving relative paths.
 *
 * Bomb protections (all configurable):
 *  - entry-name validation: reject absolute paths, ".."/"." segments, empty
 *    segments and backslash escapes (zip spec uses '/'; "a\..\b" is treated
 *    as a literal segment and rejected via the empty/.. check after the
 *    backslash normalisation);
 *  - maxEntries: hard cap on the number of file entries;
 *  - maxTotalBytes: cap on the total *uncompressed* size (zip-bomb guard);
 *  - reservedRootNames: reject root-level entries whose name is reserved for
 *    service-staged side-cars (otherwise a zip entry could silently overwrite
 *    the staged _projection.prj / _controlpoints.csv / _config.csv).
 *
 * @param {Buffer} buf
 * @param {string} destDir
 * @param {{maxEntries?:number, maxTotalBytes?:number, reservedRootNames?:Set<string>}} [limits]
 * @returns {Promise<{files:number, bytes:number, dirs:number}>}
 */
export async function extractZip(buf, destDir, {
  maxEntries = 50000,
  maxTotalBytes = 8 * 1024 ** 3,
  reservedRootNames = null,
} = {}) {
  const zipfile = await fromBufferPromise(buf, { lazyEntries: true });
  let files = 0;
  let dirs = 0;
  let bytes = 0;

  await new Promise((resolve, reject) => {
    const onError = (err) => { cleanup(); reject(err); };
    const onEnd = () => { cleanup(); resolve(); };
    const cleanup = () => {
      zipfile.removeListener('entry', onEntry);
      zipfile.removeListener('end', onEnd);
      zipfile.removeListener('error', onError);
    };
    let processing = false;
    let queue = [];

    const pump = () => {
      while (queue.length && !processing) {
        const entry = queue.shift();
        processing = true;
        handleEntry(entry).then(() => {
          processing = false;
          if (queue.length) pump();
          else zipfile.readEntry();
        }, onError);
      }
    };

    const onEntry = (entry) => {
      // yauzl 3 has no isDirectory() — DOS directory attribute bit or '/' suffix
      const isDir = (entry.externalFileAttributes & 0x10) !== 0 || String(entry.fileName).endsWith('/');
      if (isDir) { dirs++; zipfile.readEntry(); return; }
      queue.push(entry);
      pump();
    };

    const handleEntry = async (entry) => {
      files++;
      if (files > maxEntries) {
        throw Object.assign(new Error('zip contains too many entries'), { code: 'ZIP_BOMB' });
      }
      // path safety: normalise backslashes, reject traversal / absolute / empty segments
      const name = String(entry.fileName).replace(/\\/g, '/');
      const parts = name.split('/');
      if (name.startsWith('/') || parts.some((s) => !s || s === '.' || s === '..')) {
        throw Object.assign(new Error(`unsafe zip entry path: ${entry.fileName}`), { code: 'ZIP_PATH' });
      }
      // a root-level entry sharing a side-car staging name would overwrite the
      // staged projection / control-points / mesh-config file silently
      if (reservedRootNames && parts.length === 1 && reservedRootNames.has(parts[0].toLowerCase())) {
        throw Object.assign(
          new Error(`zip entry "${name}" uses a name reserved for service side-cars — rename it inside the archive`),
          { code: 'ZIP_RESERVED' });
      }
      bytes += entry.uncompressedSize;
      if (bytes > maxTotalBytes) {
        throw Object.assign(new Error('zip expands beyond the size limit'), { code: 'ZIP_BOMB' });
      }
      const dest = path.join(destDir, ...parts);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const stream = await zipfile.openReadStreamPromise(entry);
      await pipeline(stream, fs.createWriteStream(dest));
    };

    zipfile.on('entry', onEntry);
    zipfile.on('end', onEnd);
    zipfile.on('error', onError);
    zipfile.readEntry();
  });

  zipfile.close();
  return { files, bytes, dirs };
}
