#!/usr/bin/env node
/**
 * BIM 属性绑定交叉验证（MGOServer 服务层 ↔ MGO 引擎 ↔ 3D Tiles Batch Table）
 *
 * 验证链路上每一环都使用“生产同一份代码/同一份参数”：
 *   1. 用服务端 schema 校验 UI/API 会提交的 bim 参数（src/jobs/schemas.js）；
 *   2. 用服务端 buildArgs() 生成 argv（src/jobs/argv.js）——与任务实际 spawn 的完全一致；
 *   3. 用 argv 驱动真实 MGOConsole 转换（不是 fake）；
 *   4. 解析产出的 b3dm：Batch Table 必须包含 --bim-props 侧表的列与值；
 *   5. 核对 --bim-report 透明度报告与 Batch Table 一致。
 *
 * 用法：
 *   node scripts/cross-validate-bim.mjs                       # 自动选模型（优先 ../MGO/Data/bridge）
 *   node scripts/cross-validate-bim.mjs --model <model> [--max-lod 1] [--keep]
 *   MGO_BINARY=/path/to/MGOConsole node scripts/cross-validate-bim.mjs
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildArgs } from '../src/jobs/argv.js';
import { jobSchema } from '../src/jobs/schemas.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);

let pass = 0; let fail = 0;
const check = (ok, label, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); } else { fail++; console.log(`  FAIL  ${label}${detail ? '\n        ' + detail : ''}`); }
};
const step = (t) => console.log(`\n== ${t}`);

/* ---------- 0. 引擎定位 + --bim-* 能力探测 ---------- */
/** 候选引擎（显式 MGO_BINARY > 兄弟仓库开发构建 > 仓库内置二进制）。
 *  逐个探测 --bim-*：内置二进制可能早于属性绑定特性，交给调用方选第一个可用者。 */
function binaryCandidates() {
  if (process.env.MGO_BINARY) return [process.env.MGO_BINARY];
  const plat = process.platform === 'win32' ? 'windows' : 'linux';
  return [
    path.join(ROOT, '..', 'MGO', 'build', 'bin', 'MGOConsole'),
    path.join(ROOT, '..', 'MGO', 'build', 'bin', plat, 'MGOConsole'),
    path.join(ROOT, 'build', 'bin', plat, 'MGOConsole'),
  ].filter((c) => { try { return fs.existsSync(c); } catch { return false; } });
}
const run = (bin, args, opts = {}) => new Promise((resolve) => {
  execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    resolve({ err, code: err?.code ?? 0, out: String(stdout ?? ''), errOut: String(stderr ?? '') });
  });
});

/* ---------- b3dm 解码（28 字节头；BT JSON 支持 legacy map 与新式 array+bin） ---------- */
function decodeB3dm(buf) {
  if (buf.length < 28 || buf.toString('ascii', 0, 4) !== 'b3dm') throw new Error('not a b3dm');
  const ftJsonLen = buf.readUInt32LE(12);
  const ftBinLen = buf.readUInt32LE(16);
  const btJsonLen = buf.readUInt32LE(20);
  const btBinLen = buf.readUInt32LE(24);
  const ft = ftJsonLen ? JSON.parse(buf.toString('utf8', 28, 28 + ftJsonLen)) : {};
  const btOff = 28 + ftJsonLen + ftBinLen;
  const bt = btJsonLen ? JSON.parse(buf.toString('utf8', btOff, btOff + btJsonLen)) : {};
  const btBin = buf.subarray(btOff + btJsonLen, btOff + btJsonLen + btBinLen);
  const glbOff = btOff + btJsonLen + btBinLen;
  return { ft, bt, btBin, glbOff, glbMagic: buf.toString('ascii', glbOff, glbOff + 4) };
}
/** BT 列（legacy {index:value} 或 array 形态；array 里可能是二进制引用对象）→ 值数组 */
function columnValues(bt, key) {
  const col = bt[key];
  if (col === undefined) return null;
  if (Array.isArray(col)) return col;
  if (col && typeof col === 'object') {
    const n = Math.max(-1, ...Object.keys(col).map((k) => Number(k)).filter(Number.isFinite));
    return Array.from({ length: n + 1 }, (_, i) => col[String(i)]);
  }
  return null;
}
/** 3D Tiles Batch Table 二进制列的 componentType 是字符串枚举（规范 Table 格式），
 *  不是 glTF accessor 的数字枚举。历史上引擎写成了 5124/5126/5128，CesiumJS
 *  parseBatchTable 用字符串 switch 解析 → 组件类型 undefined → 读 undefined.buffer
 *  → 整个 b3dm 加载失败。这里以规范字符串为准，同时识别数字以便定位旧产物。 */
const COMPONENT_TYPES = {
  BYTE: 5120, UNSIGNED_BYTE: 5121, SHORT: 5122, UNSIGNED_SHORT: 5123,
  INT: 5124, UNSIGNED_INT: 5125, FLOAT: 5126, DOUBLE: 5128,
};
function componentTypeOf(meta) {
  if (typeof meta.componentType === 'string') return COMPONENT_TYPES[meta.componentType];
  return meta.componentType;   // 数字：非规范写法，仅用于解码旧产物
}
/** Batch Table 里的二进制列描述符（对象形态或 array+bin 的逐行引用形态）。 */
function binaryDescriptors(bt) {
  const out = [];
  for (const [key, col] of Object.entries(bt)) {
    if (Array.isArray(col)) {
      for (const v of col) {
        if (v && typeof v === 'object' && v.byteOffset !== undefined) { out.push([key, v]); break; }
      }
    } else if (col && typeof col === 'object' && col.byteOffset !== undefined) {
      out.push([key, col]);
    }
  }
  return out;
}
/** array 形态 + binary body 的数值列 → 解码（float/int 标量） */
function decodeBinaryColumn(bt, btBin, i) {
  const refs = Object.entries(bt).filter(([, v]) => Array.isArray(v) && v[i] && typeof v[i] === 'object' && v[i].byteOffset !== undefined);
  const out = {};
  for (const [key, arr] of refs) {
    const meta = arr[i];
    const ct = componentTypeOf(meta);
    const byteLen = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[ct] ?? 1;
    let val;
    try {
      if (ct === 5126) val = btBin.readFloatLE(meta.byteOffset);
      else if (ct === 5121) val = btBin.readUInt8(meta.byteOffset);
      else if (ct === 5120) val = btBin.readInt8(meta.byteOffset);
      else if (ct === 5123) val = btBin.readUInt16LE(meta.byteOffset);
      else if (ct === 5122) val = btBin.readInt16LE(meta.byteOffset);
      else if (ct === 5125) val = btBin.readUInt32LE(meta.byteOffset);
    } catch { val = undefined; }
    out[key] = `${ct === 5126 ? (typeof val === 'number' ? val.toFixed(2) : val) : val} (${byteLen}B@${meta.byteOffset})`;
  }
  return out;
}

async function main() {
  step('引擎与能力');
  const cands = binaryCandidates();
  if (!cands.length) {
    console.log('  SKIP  未找到 MGOConsole —— 设 MGO_BINARY 或构建 ../MGO');
    process.exit(0);
  }
  let bin = null; let help = null;
  for (const c of cands) {
    const h = await run(c, ['tiles', '--help']);
    const capable = /--bim-bind/.test(h.out);
    console.log(`  ${capable ? '✓' : '✗'} ${c}${capable ? '' : '（无 --bim-* ，跳过）'}`);
    if (capable && !bin) { bin = c; help = h; }
  }
  if (!bin) {
    console.log('  SKIP  候选引擎均不支持属性绑定（--bim-bind）——请用带该特性的 MGO 构建，或设 MGO_BINARY');
    process.exit(0);
  }
  console.log(`  选用引擎: ${bin}`);
  const ver = await run(bin, ['version']);
  check(/--bim-bind/.test(help.out), '引擎支持 --bim-*（tiles --help 含 --bim-bind）');
  console.log(`  ${(ver.out.split('\n')[0] || '').trim()}`);

  /* ---------- 1. 模型选择 ---------- */
  step('模型与侧表');
  let model = argOf('--model');
  if (!model) {
    const cands = [
      path.join(ROOT, '..', 'MGO', 'Data', 'bridge', 'root.fbx'),
      path.join(ROOT, 'test', 'fixtures', 'cubeA.obj'),
    ];
    model = cands.find((c) => fs.existsSync(c));
  }
  if (!model || !fs.existsSync(model)) {
    console.log('  SKIP  无可用的真实模型（--model 指定）');
    process.exit(0);
  }
  const maxLod = argOf('--max-lod', '1');
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'mgo-bim-xval-'));
  console.log(`  模型: ${model}`);
  console.log(`  工作目录: ${work}${has('--keep') ? '' : '（结束即删）'}`);

  /* ---------- 2. 第一遍：只开绑定，拿到引擎解析出的构件 ID ---------- */
  step('第一遍：引擎解析构件 ID（--bim-bind --bim-report，无侧表）');
  const probeOut = path.join(work, 'probe');
  await fsp.mkdir(probeOut, { recursive: true });
  // 注意：不能加 noSceneMeta —— 关掉场景元数据后引擎只写「有属性可写」的
  // 构件，纯几何 b3dm 的 BATCH_LENGTH=0，报告 features 也为空，就没法据此
  // 构造侧表键。保留场景元数据时 objectId/objectName 列恒在，正是 join 键来源。
  const probeParams = jobSchema.parse({
    type: 'tiles', maxLod: Number(maxLod),
    bim: { bind: true, report: true },
  });
  const probeArgs = buildArgs({ type: 'tiles', params: probeParams }, { input: model, out: probeOut });
  console.log(`  argv: ${probeArgs.join(' ')}`);
  const p1 = await run(bin, probeArgs, { cwd: path.dirname(bin) });
  check(p1.code === 0, '第一遍转换退出码 0', (p1.errOut || p1.out).slice(-400));
  const probeReportPath = probeArgs[probeArgs.indexOf('--bim-report') + 1];
  const probeReport = fs.existsSync(probeReportPath) ? JSON.parse(await fsp.readFile(probeReportPath, 'utf8')) : null;
  check(Boolean(probeReport), `--bim-report 已生成：${probeReportPath}`);
  if (!probeReport) { finish(work); return; }
  const feats = probeReport.features ?? [];
  console.log(`  报告: strategy=${probeReport.strategy} instances=${probeReport.instances} features(列举)=${feats.length} idSource=${JSON.stringify(probeReport.idSourceCounts ?? {})}`);
  check(feats.length > 0, '引擎解析出可用构件 ID（报告 features 非空）');
  if (!feats.length) { finish(work); return; }

  /* ---------- 3. 依据真实 ID 构造侧表，字段名刻意用中文 + 数值型混排 ---------- */
  const picked = feats.filter((f) => f.objectId && f.objectId !== 'DefaultName').slice(0, 8);
  const useFeats = picked.length ? picked : feats.slice(0, 8);
  const ledgerRows = ['objectId,楼层,结构,防火等级,造价'];
  useFeats.forEach((f, i) => ledgerRows.push(`${f.objectId},${i % 5 + 1},${i % 2 ? '钢结构' : '钢筋混凝土'},${i % 3 ? '一级' : '二级'},${(1234.5 + i).toFixed(1)}`));
  const ledgerPath = path.join(work, 'ledger.csv');
  await fsp.writeFile(ledgerPath, ledgerRows.join('\n') + '\n', 'utf8');
  console.log(`  侧表: ${ledgerPath}（${useFeats.length} 行，键来自第一遍解析结果）`);

  /* ---------- 4. 第二遍：服务端 buildArgs 生成 argv 并驱动引擎 ---------- */
  step('第二遍：服务端 argv（--bim-props/--bim-id-property）→ 引擎写出 Batch Table');
  const out2 = path.join(work, 'out');
  await fsp.mkdir(out2, { recursive: true });
  const params = jobSchema.parse({
    type: 'tiles', maxLod: Number(maxLod),
    bim: {
      bind: true, propsPath: ledgerPath, idProperty: 'objectName',
      report: true,
    },
  });
  const args = buildArgs({ type: 'tiles', params }, { input: model, out: out2 });
  console.log(`  argv: ${args.join(' ')}`);
  const p2 = await run(bin, args, { cwd: path.dirname(bin) });
  const errLines = (p2.errOut || '').split('\n').filter((l) => /bim/i.test(l)).slice(0, 6);
  errLines.forEach((l) => console.log('  引擎: ' + l.trim()));
  check(p2.code === 0, '第二遍转换退出码 0', (p2.errOut || p2.out).slice(-400));
  if (p2.code !== 0) { finish(work); return; }
  const reportPath = args[args.indexOf('--bim-report') + 1];
  const report = JSON.parse(await fsp.readFile(reportPath, 'utf8'));
  console.log(`  绑定报告: instances=${report.instances} withSidecarRow=${report.withSidecarRow} withObjectId=${report.withObjectId}`);
  check(report.withSidecarRow > 0, '侧表命中（report.withSidecarRow > 0）');

  /* ---------- 5. 解码 b3dm：Batch Table 必须带侧表列与值 ---------- */
  step('交叉核对：b3dm Batch Table ↔ 侧表 CSV');
  const b3dms = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.b3dm')) b3dms.push(p);
    }
  };
  walk(out2);
  check(b3dms.length > 0, `产出 b3dm 文件（${b3dms.length} 个）`);
  const want = useFeats[0];
  const wantRow = ledgerRows[1].split(',');
  let hit = null; let scanned = 0;
  for (const fp of b3dms) {
    const d = decodeB3dm(fs.readFileSync(fp));
    scanned++;
    const ids = columnValues(d.bt, 'objectId') ?? [];
    const idx = ids.findIndex((v) => String(v) === String(want.objectId));
    if (idx >= 0) { hit = { fp, d, idx }; break; }
  }
  check(Boolean(hit), `在 b3dm 中找到第一遍解析出的构件 "${want.objectId}"`, `已扫描 ${scanned} 个 b3dm，列样例 ${JSON.stringify(Object.keys(decodeB3dm(fs.readFileSync(b3dms[0])).bt))}`);
  if (hit) {
    const fp = hit.fp;
    const { bt, btBin, glbMagic } = hit.d;
    const btKeys = Object.keys(bt);
    const idx = hit.idx;
    console.log(`  命中: ${path.relative(out2, fp)} #${idx}  列: ${btKeys.join(', ')}`);
    check(glbMagic === 'glTF', 'b3dm 内嵌二进制 glTF（Batch Table 与几何同体）');
    for (const [ki, key] of ['objectId', '楼层', '结构', '防火等级', '造价'].entries()) {
      const col = columnValues(bt, key);
      if (!col) { check(false, `Batch Table 含侧表列 "${key}"`, `实际列: ${btKeys.join(', ')}`); continue; }
      let v = col[idx];
      if (v && typeof v === 'object') v = decodeBinaryColumn(bt, btBin, idx)[key] ?? JSON.stringify(v);
      const expected = wantRow[ki];
      // 只有 楼层/造价 是数值列；中文字段一律按字符串比（曾按索引区间
      // 误判成数值 → Number('钢筋混凝土')=NaN → 明明相等却报 FAIL）
      const numeric = key === '楼层' || key === '造价';
      const ok = numeric ? Math.abs(Number(v) - Number(expected)) < 1e-6 : String(v) === expected;
      check(ok, `Batch Table 列 "${key}" 命中侧表值（${v} vs ${expected}）`);
    }
    const binCols = decodeBinaryColumn(bt, btBin, idx);
    console.log(`  二进制列解码: ${JSON.stringify(binCols).slice(0, 200)}`);
  }

  /* ---------- 6. Cesium 可解析性：componentType 必须是规范字符串枚举 ---------- */
  // 回归防线：CesiumJS（1.111）的 parseBatchTable 只认 "INT"/"FLOAT"/"DOUBLE" 这类
  // 字符串；写成 glTF 数字枚举时组件类型解析为 undefined，b3dm 在浏览器里直接报
  // "Cannot read properties of undefined (reading 'buffer')"。
  step('Batch Table 规范合规（Cesium parseBatchTable 可解析）');
  const descs = [];
  for (const fp of b3dms.slice(0, 60)) {
    const d = decodeB3dm(fs.readFileSync(fp));
    for (const [key, meta] of binaryDescriptors(d.bt)) descs.push([path.relative(out2, fp), key, meta]);
  }
  check(descs.length > 0, `二进制列描述符存在（${descs.length} 个），componentType 有实际校验对象`);
  const badType = descs.filter(([, , m]) => typeof m.componentType !== 'string');
  check(badType.length === 0,
    '二进制列 componentType 使用 3D Tiles 字符串枚举（非 glTF 数字枚举）',
    badType.slice(0, 4).map(([f, k, m]) => `${f} ${k}=${JSON.stringify(m.componentType)}`).join('; '));
  const unknownType = descs.filter(([, , m]) => typeof m.componentType === 'string' && !(m.componentType in COMPONENT_TYPES));
  check(unknownType.length === 0, 'componentType 取值在规范枚举内',
    unknownType.slice(0, 4).map(([f, k, m]) => `${f} ${k}=${m.componentType}`).join('; '));
  const sample = descs.slice(0, 3).map(([, k, m]) => `${k}={"componentType":"${m.componentType}","type":"${m.type}"}`);
  console.log(`  样例: ${sample.join(' | ')}`);

  /* ---------- 7. Cesium 实机解析（真浏览器 + 真 Cesium.js） ---------- */
  // 上面只证明「字节按我们的理解排布」；这一步用 Cesium 自己的 parseBatchTable
  // 证明「Cesium 也能读懂」。componentType 数字枚举的回归正是在这里被拦住。
  step('Cesium 实机解析：parseBatchTable');
  const probe = await run(process.execPath,
    [path.join(ROOT, 'scripts', 'probe-b3dm-batchtable.mjs'), out2],
    { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
  const probeTail = (probe.out || probe.errOut || '').trim().split('\n');
  const summary = probeTail.filter((l) => /Cesium |均可|无法被|FAIL|probe failed/.test(l)).slice(-8);
  summary.forEach((l) => console.log('  ' + l));
  check(probe.code === 0, 'Cesium parseBatchTable 可解析全部 b3dm（Batch Table 规范合规）',
    probe.code === 0 ? '' : probeTail.slice(-12).join('\n        '));
  // 报告逐构件标注命中来源：只配侧表时是 sidecar；场景元数据与侧表都在时是
  // merged（侧表覆盖同名场景列）——两者都算「可追溯」。
  const srcCount = {};
  for (const f of report.features ?? []) srcCount[f.matchSource] = (srcCount[f.matchSource] ?? 0) + 1;
  console.log(`  报告 matchSource 分布: ${JSON.stringify(srcCount)}`);
  check((report.features ?? []).some((f) => f.matchSource === 'sidecar' || f.matchSource === 'merged'),
    '报告逐构件标注侧表命中来源（sidecar/merged）');
  finish(work);
}

function finish(work) {
  if (!has('--keep')) fs.rmSync(work, { recursive: true, force: true });
  else console.log(`\n工作目录保留: ${work}`);
  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('cross-validate failed:', e); process.exit(2); });
