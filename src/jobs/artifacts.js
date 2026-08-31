import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Post-run artifact discovery (design §6.5): probe the known output names of
 * each mgo subcommand — deliberately NOT a blind file enumeration.
 * URLs point at the /ws data plane.
 */

const ROLES = {
  TILES: '3dtiles', TERRAIN: 'terrain', IMAGERY: 'imagery',
  GEOJSON: 'geojson', MODEL: 'model',
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
 * @returns {Promise<Array<{role, path, url, mediaType, viewer}>>} role-ordered
 */
export async function discoverArtifacts(jobId, outDir) {
  const urlOf = (p) => `/ws/${jobId}/out${p}`;
  const found = [];

  if (await exists(path.join(outDir, 'tileset.json'))) {
    found.push({ role: ROLES.TILES, path: '/tileset.json', url: urlOf('/tileset.json'),
      mediaType: 'application/json', viewer: { type: '3dtiles', url: urlOf('/tileset.json') } });
  }

  const files = await walk(outDir);
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
    found.push({ role: ROLES.MODEL, path: p, url: urlOf(p),
      mediaType: isGlb ? 'model/gltf-binary' : 'application/octet-stream',
      viewer: isGlb ? { type: 'model', url: urlOf(p) } : undefined });
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
