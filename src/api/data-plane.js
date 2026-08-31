import path from 'node:path';
import fs from 'node:fs';

/**
 * Data plane (design §7): serve job artifacts under /ws/{jobId}/out/** with
 * Cesium-friendly headers — correct MIME for b3dm/terrain/octet-stream,
 * immutable caching for content, CORS for crossOrigin fetches, and hard
 * path-containment so a URL can never escape the job's out/ directory.
 */

const MIME = {
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.terrain': 'application/octet-stream',
  '.b3dm': 'application/octet-stream',
  '.i3dm': 'application/octet-stream',
  '.pnts': 'application/octet-stream',
  '.cmpt': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.xml': 'application/xml',
  '.obj': 'text/plain',
  '.fbx': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
};

const SHORT_CACHE = new Set(['.json', '.geojson']);

export function registerDataPlane(app, manager, cfg) {
  app.route({
    method: ['GET', 'HEAD'],
    url: '/ws/:jobId/out/*',
    handler: (req, reply) => {
      const job = manager.get(req.params.jobId);
      if (!job) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'job not found', requestId: req.id },
        });
      }
      let rel;
      try { rel = decodeURIComponent(req.params['*'] ?? ''); } catch {
        return reply.code(400).send({ error: { code: 'BAD_PATH', message: 'malformed url' } });
      }
      if (!rel || rel.split('/').some((s) => s === '..') || path.isAbsolute(rel)) {
        return reply.code(400).send({ error: { code: 'BAD_PATH', message: 'malformed path' } });
      }
      const outDir = manager.outDir(job.id);
      const target = path.resolve(outDir, rel);
      if (!(target === outDir || target.startsWith(outDir + path.sep))) {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'path escape denied' } });
      }
      let real;
      try { real = fs.realpathSync(target); } catch {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'no such artifact' } });
      }
      const realOut = (() => { try { return fs.realpathSync(outDir); } catch { return null; } })();
      if (!realOut || !(real === realOut || real.startsWith(realOut + path.sep))) {
        return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'symlink escape denied' } });
      }
      let st;
      try { st = fs.statSync(real); } catch {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'no such artifact' } });
      }
      if (st.isDirectory()) {
        return reply.code(404).send({
          error: { code: 'DIRECTORY', message: 'this endpoint serves files, not listings' },
        });
      }

      const ext = path.extname(real).toLowerCase();
      const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
      reply.header('Content-Type', MIME[ext] ?? 'application/octet-stream');
      reply.header('Content-Length', st.size);
      reply.header('ETag', etag);
      reply.header('Last-Modified', st.mtime.toUTCString());
      reply.header('Cache-Control', SHORT_CACHE.has(ext)
        ? 'public, max-age=60'
        : 'public, max-age=31536000, immutable');
      reply.header('Access-Control-Allow-Origin', cfg.corsOrigin);
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      if (req.method === 'HEAD') return reply.send();
      return reply.send(fs.createReadStream(real));
    },
  });
}
