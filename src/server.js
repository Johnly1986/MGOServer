import Fastify, { LogController } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig, ENV_FILE, dotEnvKeys } from './config.js';
import { normalizeIp, BUILTIN_LOCAL } from './ipmatch.js';
import { JobManager } from './jobs/manager.js';
import { probeMgo } from './mgo.js';
import { registerApi } from './api/routes.js';
import { registerDataPlane } from './api/data-plane.js';

/** Minimal dark-themed 403 page for browsers (non-whitelisted client IP). */
function forbiddenPage(ip) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>403 禁止访问</title>
<style>
  body{margin:0;font:14px/1.7 "PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;
       background:#0e1116;color:#e6ecf5;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{max-width:520px;padding:36px 40px;background:#171c24;border:1px solid #2d3744;border-radius:14px;
        box-shadow:0 10px 34px rgba(0,0,0,.4)}
  h1{margin:0 0 10px;font-size:22px} .code{color:#ef5b68;font-weight:800}
  .ip{font:12px ui-monospace,Consolas,monospace;background:#0a0d12;padding:4px 10px;border-radius:6px;color:#93a0b4}
  p{color:#93a0b4;font-size:13.5px;margin:8px 0}
  .hint{margin-top:14px;padding-top:12px;border-top:1px solid #2d3744;color:#6b7889;font-size:12px}
  code{font:12px ui-monospace,Consolas,monospace;color:#7cc0ff}
</style></head><body><div class="card">
  <h1><span class="code">403</span> · 访问被拒绝</h1>
  <p>您的 IP <span class="ip">${ip}</span> 不在服务白名单中，页面与接口均已拦截。</p>
  <p>如需授权：请在服务器本机打开 <code>/whitelist.html</code> 白名单设置页，添加该 IP 后保存，立即生效。</p>
  <div class="hint">MGO 服务 · IP 白名单访问控制</div>
</div></body></html>`;
}

/**
 * Assemble the app (exported for tests).  Route precedence: /api/v1 and /ws
 * are registered first and are more specific than the static wildcard, so
 * public/** (console.html, viewer.html, optional self-hosted cesium/) fills
 * everything else.
 */
export async function buildApp(cfg = loadConfig()) {
  const app = Fastify({
    logger: { level: cfg.logLevel ?? 'info' },
    // Only take X-Forwarded-For from peers we actually control (see config.js):
    // 'loopback' for a local reverse proxy, a hop count, or a subnet list.
    // `true` would let any remote client forge `X-Forwarded-For: 127.0.0.1` and
    // both walk past the IP gate and reach the localhost-only whitelist API.
    trustProxy: cfg.trustProxy ?? 'loopback',
    logController: new LogController({ disableRequestLogging: true }),
  });

  const manager = new JobManager(cfg);
  await manager.init();
  const mgo = await probeMgo(cfg.binary);
  const cesiumLocal = fs.existsSync(cfg.cesiumLocalEntry);

  await app.register(multipart, {
    limits: { fileSize: cfg.uploadMaxBytes, files: cfg.uploadMaxFiles, fields: 8 },
  });

  /* ---- global access gate: every path requires a whitelisted client IP ----
   * Exemptions: health/capabilities (harmless status probes) and the
   * whitelist-management endpoints (their own routes enforce LOCAL_ONLY).
   * Everything else — pages, /api reads+writes, /ws artifacts — is closed
   * to non-whitelisted IPs. */
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (url === '/api/v1/health' || url === '/api/v1/capabilities' || url.startsWith('/api/v1/whitelist')) return;
    const ip = normalizeIp(req.ip);
    if (cfg.isAllowedIp(ip)) return;
    const accept = String(req.headers.accept ?? '');
    if (!url.startsWith('/api/') || accept.includes('text/html')) {
      return reply.code(403).type('text/html; charset=utf-8').send(forbiddenPage(ip));
    }
    return reply.code(403).send({
      error: { code: 'IP_NOT_ALLOWED', message: `client IP ${ip} is not in the whitelist`, requestId: req.id },
    });
  });

  /* ---- uniform error envelope ---- */
  app.setErrorHandler((error, req, reply) => {
    const status = error.statusCode ?? 500;
    const body = {
      error: {
        code: error.errCode ?? (status >= 500 ? 'INTERNAL' : 'BAD_REQUEST'),
        message: error.statusCode ? error.message : 'internal server error',
        requestId: req.id,
      },
    };
    if (error.details) body.error.details = error.details;
    if (status >= 500) req.log.error({ err: error }, 'request failed');
    return reply.code(status).send(body);
  });

  registerApi(app, { manager, cfg, mgo, cesiumLocal });
  registerDataPlane(app, manager, cfg);

  // '/' resolves to console.html via index list.
  await app.register(fastifyStatic, {
    root: cfg.publicDir,
    prefix: '/',
    index: ['console.html'],
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${fs.sep}cesium${fs.sep}`)
        || filePath.includes('/cesium/')) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      }
    },
  });

  app.decorate('manager', manager);
  app.decorate('cfg', cfg);
  app.decorate('mgoInfo', mgo);
  app.addHook('onClose', async () => manager.stop());

  return app;
}

/* istanbul ignore next */
async function main() {
  const cfg = loadConfig();
  const app = await buildApp(cfg);
  await app.listen({ host: cfg.host, port: cfg.port });
  app.log.info({
    msg: 'MGOServer up',
    url: `http://${cfg.host}:${cfg.port}`,
    binary: cfg.binary,
    mgo: app.mgoInfo,
    cesium: fs.existsSync(cfg.cesiumLocalEntry) ? 'self-hosted' : 'CDN fallback',
    auth: 'ip-whitelist (localhost always allowed)',
    // Loud on purpose: a missing `whitelist.json` / forgotten MGO_HOST after a
    // reboot is otherwise indistinguishable from "the client IP isn't allowed".
    whitelist: cfg.whitelist,
    whitelistFile: fs.existsSync(cfg.whitelistFile) ? cfg.whitelistFile : `${cfg.whitelistFile} (absent)`,
    envFile: dotEnvKeys.length ? `${ENV_FILE} [${dotEnvKeys.join(',')}]` : `${ENV_FILE} (not loaded)`,
    trustProxy: cfg.trustProxy,
  });
  if (!app.mgoInfo.found) {
    app.log.warn({
      msg: `mgo binary not runnable: ${cfg.binary} — job submission will fail; `
        + 'fix MGO_BINARY (or build the C++ toolkit at ../MGO) and restart',
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('MGOServer failed to start:', err); process.exit(1); });
}
