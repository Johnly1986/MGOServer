#!/usr/bin/env node
/**
 * 用 Cesium 自身的 parseBatchTable 校验 b3dm 的 Batch Table 能否被 Cesium 消费。
 *
 * 这是 Cesium 1.111 加载 b3dm 时真正走的路径：
 *   Batched3DModel3DTileContent.process → parseBatchTable → MetadataTable
 * 自写解码器只能证明「字节按我们的理解排布」，这里证明「Cesium 也能读懂」——
 * 两者不是一回事：Batch Table 二进制列的 componentType 必须是 3D Tiles 规范的
 * 字符串枚举（"INT"/"FLOAT"/"DOUBLE"），写成 glTF 数字枚举（5124/5126/5128）会让
 * parseBatchTable 拿到 undefined 组件类型，整个 b3dm 加载失败：
 *   TypeError: Cannot read properties of undefined (reading 'buffer')
 *
 * 用法:
 *   node scripts/probe-b3dm-batchtable.mjs <file.b3dm|dir> [--url http://127.0.0.1:8080]
 *   --url   用已在运行的服务提供 Cesium.js（默认自起一个静态服务）
 * 退出码: 0 全部可解析；1 有无法解析的 b3dm；2 参数/环境错误。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CESIUM_PUBLIC = path.join(ROOT, 'public');
const MIME = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };

const target = process.argv[2];
if (!target) { console.error('usage: probe-b3dm-batchtable.mjs <file.b3dm|dir> [--url http://127.0.0.1:8080]'); process.exit(2); }
const urlArg = process.argv.indexOf('--url');
let base = urlArg >= 0 ? process.argv[urlArg + 1].replace(/\/+$/, '') : null;

/** 自起静态服务：只为把 Cesium.js 交给浏览器，避免依赖外部进程。 */
function servePublic() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.join(CESIUM_PUBLIC, rel);
    if (!file.startsWith(CESIUM_PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function decodeB3dm(buf) {
  if (buf.length < 28 || buf.toString('ascii', 0, 4) !== 'b3dm') throw new Error('not b3dm');
  const ftJsonLen = buf.readUInt32LE(12);
  const ftBinLen = buf.readUInt32LE(16);
  const btJsonLen = buf.readUInt32LE(20);
  const btBinLen = buf.readUInt32LE(24);
  let off = 28;
  const ftJson = ftJsonLen ? JSON.parse(buf.toString('utf8', off, off + ftJsonLen)) : {};
  off += ftJsonLen + ftBinLen;
  const btJsonRaw = buf.toString('utf8', off, off + btJsonLen); off += btJsonLen;
  const btBin = buf.subarray(off, off + btBinLen);
  let btJson = {};
  if (btJsonRaw.trim()) { try { btJson = JSON.parse(btJsonRaw); } catch { btJson = {}; } }
  return { ftJson, btJson, btBin, btJsonLen, btBinLen };
}

function collect(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.b3dm')) files.push(p);
    }
  };
  if (fs.statSync(dir).isDirectory()) walk(dir); else files.push(dir);
  return files;
}

const isDir = fs.statSync(target).isDirectory();
const files = collect(target);
if (!files.length) { console.error(`未找到 b3dm: ${target}`); process.exit(2); }

let own = null;
if (!base) { own = await servePublic(); base = `http://127.0.0.1:${own.port}`; }

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const bail = async (msg, code) => {
  await browser.close().catch(() => {});
  if (own) own.server.close();
  console.error(msg);
  process.exit(code);
};
try {
  await page.goto(`${base}/viewer.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Cesium && window.Cesium.VERSION, null, { timeout: 60000 });
  const version = await page.evaluate(() => Cesium.VERSION);
  const hasParse = await page.evaluate(() => typeof Cesium.parseBatchTable);
  if (hasParse !== 'function') await bail(`Cesium ${version} 未导出 parseBatchTable（探测不可用）`, 2);
  console.log(`Cesium ${version} / parseBatchTable 可用`);

  const limit = Number(process.env.B3DM_PROBE_LIMIT ?? 0) || files.length;
  let bad = 0; let checked = 0;
  for (const f of files.slice(0, limit)) {
    const d = decodeB3dm(fs.readFileSync(f));
    const rel = isDir ? path.relative(target, f) : path.basename(f);
    const btJson = d.btJson && typeof d.btJson === 'object' ? d.btJson : {};
    const cols = Object.entries(btJson).map(([k, v]) =>
      `${k}:${Array.isArray(v) ? `json[${v.length}]` : `bin(componentType=${JSON.stringify(v.componentType)})`}`);
    const res = await page.evaluate(({ count, btJson, btBinB64 }) => {
      try {
        const bin = Uint8Array.from(atob(btBinB64), (c) => c.charCodeAt(0));
        const t = Cesium.parseBatchTable({ count, batchTable: btJson, binaryBody: bin });
        const ids = [];
        const pt = typeof t.getPropertyTable === 'function' ? t.getPropertyTable(0) : undefined;
        if (pt) for (const id of pt.getPropertyIds()) ids.push(id);
        return { ok: true, properties: ids };
      } catch (e) { return { ok: false, error: `${e.name}: ${e.message}` }; }
    }, { count: d.ftJson.BATCH_LENGTH ?? 0, btJson, btBinB64: Buffer.from(d.btBin).toString('base64') });
    checked++;
    if (!res.ok) bad++;
    console.log(`${res.ok ? 'OK  ' : 'FAIL'} ${rel}  BATCH_LENGTH=${d.ftJson.BATCH_LENGTH ?? 0} btJson=${d.btJsonLen}B btBin=${d.btBinLen}B`);
    if (d.btJsonLen && (checked <= 3 || !res.ok)) console.log(`      列: ${cols.join(' | ') || '(空)'}`);
    if (res.ok) { if (checked <= 3) console.log(`      Cesium 解析属性: ${JSON.stringify(res.properties)}`); }
    else console.log(`      ${res.error}`);
  }
  console.log(bad ? `\n${bad}/${checked} 个 b3dm 无法被 Cesium 解析` : `\n${checked} 个 b3dm 均可被 Cesium 解析`);
  await browser.close();
  if (own) own.server.close();
  process.exit(bad ? 1 : 0);
} catch (e) {
  await bail(`probe failed: ${e}`, 2);
}
