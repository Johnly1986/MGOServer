import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Post-run artifact discovery (design §6.5): probe the known output names of
 * each mgo subcommand — deliberately NOT a blind file enumeration.
 * URLs point at the /ws data plane.
 */

const ROLES = {
  TILES: '3dtiles', TERRAIN: 'terrain', IMAGERY: 'imagery',
  GEOJSON: 'geojson', MODEL: 'model', BIM_REPORT: 'bimReport',
};

const MAX_WALK = 20000;

async function exists(p) {
  try { await fsp.stat(p); return true; } catch { return false; }
}

async function walk(outDir) {
  const files = [];
  const stack = [outDir];
  while (stack.length && files.length < MAX_WALK) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (e.isFile()) files.push(abs);
      if (files.length >= MAX_WALK) break;
    }
  }
  return files;
}

const rel = (outDir, abs) => '/' + path.relative(outDir, abs).split(path.sep).join('/');

/**
 * glTF version of a binary .glb, or null when it cannot be determined.
 * GLB 2.0: 12-byte header (magic/version/length) + chunk header whose type is
 * 'JSON' (0x4E4F534A).  Assimp's legacy exporter writes version 1 with a
 * numeric content-format word instead, so the version field alone is enough.
 */
async function glbVersion(file) {
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const head = Buffer.alloc(12);
      const { bytesRead } = await fh.read(head, 0, 12, 0);
      if (bytesRead < 12 || head.toString('ascii', 0, 4) !== 'glTF') return null;
      return head.readUInt32LE(4);
    } finally { await fh.close(); }
  } catch { return null; }
}

/** glTF version of a JSON .gltf (asset.version, e.g. "1.0" → 1). */
async function gltfTextVersion(file) {
  try {
    const doc = JSON.parse(await fsp.readFile(file, 'utf8'));
    const v = String(doc?.asset?.version ?? '');
    const major = parseInt(v, 10);
    return Number.isFinite(major) ? major : null;
  } catch { return null; }
}

/**
 * Legacy Batch Table probe (3D Tiles Table format).
 *
 * The binary-column descriptor must spell `componentType` as the spec string
 * enum ("INT"/"FLOAT"/"DOUBLE"/…).  Older engine builds wrote the glTF numeric
 * enum (5124/5126/5128); CesiumJS's parseBatchTable then resolves the component
 * type to undefined and dies with
 *   TypeError: Cannot read properties of undefined (reading 'buffer')
 * for EVERY b3dm that carries a binary Batch Table column — i.e. any tile built
 * with `--bim-bind`.  Those tiles cannot be previewed, so flag them instead of
 * handing out a 查看 link (mirrors the glTF 1.0 handling above).
 *
 * @returns {Promise<'legacy'|'spec'|null>} null when there is nothing to judge.
 */
async function batchTableComponentType(b3dmFile) {
  try {
    const fh = await fsp.open(b3dmFile, 'r');
    try {
      const head = Buffer.alloc(28);
      const { bytesRead } = await fh.read(head, 0, 28, 0);
      if (bytesRead < 28 || head.toString('ascii', 0, 4) !== 'b3dm') return null;
      const ftJsonLen = head.readUInt32LE(12);
      const ftBinLen = head.readUInt32LE(16);
      const btJsonLen = head.readUInt32LE(20);
      if (!btJsonLen || btJsonLen > 4 * 1024 * 1024) return null;
      const off = 28 + ftJsonLen + ftBinLen;
      const buf = Buffer.alloc(btJsonLen);
      await fh.read(buf, 0, btJsonLen, off);
      const bt = JSON.parse(buf.toString('utf8'));
      const descriptors = [];
      for (const v of Object.values(bt)) {
        if (Array.isArray(v)) { if (v[0] && typeof v[0] === 'object') descriptors.push(v[0]); }
        else if (v && typeof v === 'object') descriptors.push(v);
      }
      if (!descriptors.length) return null;              // no binary columns
      return descriptors.some((d) => typeof d.componentType === 'number') ? 'legacy' : 'spec';
    } finally { await fh.close(); }
  } catch { return null; }
}

/** First legacy b3dm found in the output tree, or null. */
async function findLegacyBatchTable(files) {
  const b3dms = files.filter((f) => f.endsWith('.b3dm')).slice(0, 8);
  for (const f of b3dms) {
    if (await batchTableComponentType(f) === 'legacy') return f;
  }
  return null;
}

/**
 * @returns {Promise<Array<{role, path, url, mediaType, viewer}>>} role-ordered
 */
export async function discoverArtifacts(jobId, outDir) {
  const urlOf = (p) => `/ws/${jobId}/out${p}`;
  const found = [];

  const files = await walk(outDir);

  if (await exists(path.join(outDir, 'tileset.json'))) {
    const legacyBt = await findLegacyBatchTable(files);
    found.push({
      role: ROLES.TILES, path: '/tileset.json', url: urlOf('/tileset.json'),
      mediaType: 'application/json',
      viewer: legacyBt ? undefined : { type: '3dtiles', url: urlOf('/tileset.json') },
      ...(legacyBt ? {
        batchTableComponentType: 'numeric',
        warning: '旧引擎产出的 BIM 瓦片把 Batch Table 的 componentType 写成了数字枚举，Cesium 无法解析（Cannot read properties of undefined）——请用已修复的引擎重新转换',
      } : {}),
    });
  }

  const hasTerrain = files.some((f) => f.endsWith('.terrain'));
  const hasPng = files.some((f) => /\.(png|jpe?g)$/i.test(f));

  if (hasTerrain && (await exists(path.join(outDir, 'layer.json')))) {
    found.push({ role: ROLES.TERRAIN, path: '/layer.json', url: urlOf('/layer.json'),
      mediaType: 'application/json', viewer: { type: 'terrain', url: urlOf('') } });
  }
  if (hasPng) {
    const meta = (await exists(path.join(outDir, 'tilemapresource.xml')))
      ? '/tilemapresource.xml' : (await exists(path.join(outDir, 'layer.json')) ? '/layer.json' : null);
    if (meta) {
      found.push({ role: ROLES.IMAGERY, path: meta, url: urlOf(meta),
        mediaType: meta.endsWith('.xml') ? 'application/xml' : 'application/json',
        viewer: { type: 'imagery', url: urlOf('') } });
    }
  }

  const gj = files.find((f) => f.endsWith('.geojson'));
  if (gj) {
    const p = rel(outDir, gj);
    found.push({ role: ROLES.GEOJSON, path: p, url: urlOf(p),
      mediaType: 'application/geo+json', viewer: { type: 'geojson', url: urlOf(p) } });
  }

  const model = files.find((f) => f.endsWith('.glb'))
    ?? files.find((f) => /\.(gltf|obj|fbx|ply)$/i.test(f));
  if (model) {
    const p = rel(outDir, model);
    const isGlb = p.endsWith('.glb');
    // Probe the GLB/glTF version before advertising a preview: assimp's legacy
    // exporters emit glTF 1.0 ("glb"/"gltf"), which Cesium (2.0-only) rejects
    // with an opaque "Failed to load model".  Better to say so up-front than to
    // hand the user a 查看 link that cannot work (old jobs, older engines).
    const ver = isGlb ? await glbVersion(model) : await gltfTextVersion(model);
    const legacy = ver !== null && ver < 2;
    found.push({
      role: ROLES.MODEL, path: p, url: urlOf(p),
      mediaType: isGlb ? 'model/gltf-binary' : 'application/octet-stream',
      viewer: (isGlb && !legacy) ? { type: 'model', url: urlOf(p) } : undefined,
      ...(ver !== null ? { gltfVersion: ver } : {}),
      ...(legacy ? {
        warning: `glTF ${ver}.x 产物无法被 Cesium 预览（仅支持 2.0）——请用支持 glTF 2.0 导出的引擎重新转换`,
      } : {}),
    });
  }

  // BIM binding transparency manifests (tiles --bim-report): one per input
  // stem under out/<stem>/; plain JSON, no globe preview — download role only
  for (const f of files.filter((x) => /bim_report\.json$/i.test(x))) {
    const p = rel(outDir, f);
    found.push({ role: ROLES.BIM_REPORT, path: p, url: urlOf(p),
      mediaType: 'application/json' });
  }

  return found;
}

/** Pick the primary artifact for the "view on globe" link. */
export function primaryArtifact(artifacts) {
  for (const role of [ROLES.TILES, ROLES.TERRAIN, ROLES.IMAGERY, ROLES.GEOJSON, ROLES.MODEL]) {
    const a = artifacts.find((x) => x.role === role);
    if (a) return a;
  }
  return null;
}
