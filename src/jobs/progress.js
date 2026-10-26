/**
 * Parser for the mgo English progress protocol (switched from Chinese in the
 * same change set that introduced this service):
 *
 *   [TerrainConverter] Progress: 12/57
 *   [TerrainConverter] Done: 57/57
 *   [OSGBConverter] Done: 214 tile(s) -> /path/out/tileset.json
 *   [OSGBSimplify] Progress: 8/214        (mesh simplification phase)
 *   [ImageTiler] Progress: 3/7            (per-LEVEL granularity)
 *
 * Design: docs/VISUALIZATION_SERVICE_DESIGN.md §8.  Parsing failures NEVER
 * fail a job — the caller simply falls back to status-only progress.
 */

const MODULES = 'TerrainConverter|TilesConverter|OSGBConverter|OSGBReader|OSGBSimplify|ImageTiler|MeshGroupOptimizer|GeoJSONConverter';

const RE_PROGRESS = new RegExp(`^\\[(${MODULES})\\]\\s*Progress:\\s*(\\d+)/(\\d+)\\s*$`);
const RE_DONE_FRAC = new RegExp(`^\\[(${MODULES})\\]\\s*Done:\\s*(\\d+)/(\\d+)\\b`);
const RE_DONE_INFO = new RegExp(`^\\[(${MODULES})\\]\\s*Done:\\s*(.*)$`);
const RE_MODULE_LINE = new RegExp(`^\\[(?:${MODULES}|GeoTiffReader|TerrainQuadtree|TilesetWriter)\\]`);

/**
 * Stateful per-job parser.  Within a run that keeps the same `total`, done
 * and percent never move backwards (ImageTiler restarts counting per level,
 * parallel writers can interleave stale lines).
 */
export class ProgressParser {
  constructor() {
    this.last = { done: 0, total: 0, percent: 0, phase: null, module: null };
  }

  /** @returns {{type:'progress'|'done', done, total, percent, phase, module, detail?}|null} */
  parse(line) {
    let m = RE_PROGRESS.exec(line);
    if (m) {
      const module = m[1];
      const total = Number(m[3]);
      let done = Math.min(Number(m[2]), total);
      let percent = total > 0 ? Math.round((100 * done) / total) : 0;
      if (this.last.module === module && this.last.total === total) {
        done = Math.max(done, this.last.done);
        percent = Math.max(percent, this.last.percent);
      }
      const phase = module === 'ImageTiler' ? 'levels'
        : module === 'OSGBReader' ? 'read'
        : module === 'OSGBSimplify' ? 'simplify'
        : module === 'MeshGroupOptimizer' ? 'mesh'
        : module === 'GeoJSONConverter' ? 'convert' : 'tiles';
      this.last = { done, total, percent, phase, module };
      return { type: 'progress', done, total, percent, phase, module, detail: line.trim() };
    }
    m = RE_DONE_FRAC.exec(line);
    if (m) {
      const total = Number(m[3]);
      this.last = { done: total, total, percent: 100, phase: this.last.phase, module: m[1] };
      return { type: 'done', done: total, total, percent: 100,
        phase: this.last.phase, module: m[1], detail: line.trim() };
    }
    m = RE_DONE_INFO.exec(line);
    if (m) {
      // Done line without an X/Y fraction (OSGB tile count / ImageTiler summary)
      return { type: 'done', done: this.last.done, total: this.last.total,
        percent: Math.max(this.last.percent, 99), phase: this.last.phase,
        module: m[1], detail: m[2] };
    }
    return null;
  }

  snapshot() { return { ...this.last }; }
}

/**
 * 多文件 tiles job：把「单文件 0..100」折算进本 job 的全局切片。
 * done/total 必须与 percent 同尺度，否则 UI 出现 `97/97 (32%)` 这类自相矛盾
 * 数字（用户实测）。原始单文件计数保留在 message（detail）里可追溯。
 * 上限 98 把最后 2% 留给收尾（artifact 发现/校验），最终由 finish 置 100。
 */
export function scaleProgress(ev, scale) {
  const percent = Math.min(98,
    Math.floor(((scale.index + ev.percent / 100) / scale.files) * 98));
  return { done: percent, total: 100, percent };
}

// 已知边界：ImageTiler 逐层重启计数（每个 level 0..100），跨层时 job.progress
// 的 percent 会回落（L1 100% → L2 2%）。有意不钳制：clamp 成非递减会让进度条
// 卡在 100% 直到跑完（更误导），而引擎只在结束时输出总层数，无法做跨层累加。
// UI 侧以 phase='levels' 语义展示；若未来引擎输出层号，再在此做跨层归一。

/** Does this stdout/stderr line carry module diagnostics worth streaming? */
export function isModuleLine(line) {
  return RE_MODULE_LINE.test(line);
}
