/**
 * Parser for the mgo English progress protocol (switched from Chinese in the
 * same change set that introduced this service):
 *
 *   [TerrainConverter] Progress: 12/57
 *   [TerrainConverter] Done: 57/57
 *   [OSGBConverter] Done: 214 tile(s) -> /path/out/tileset.json
 *   [ImageTiler] Progress: 3/7            (per-LEVEL granularity)
 *
 * Design: docs/VISUALIZATION_SERVICE_DESIGN.md §8.  Parsing failures NEVER
 * fail a job — the caller simply falls back to status-only progress.
 */

const MODULES = 'TerrainConverter|TilesConverter|OSGBConverter|OSGBReader|ImageTiler';

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
        : module === 'OSGBReader' ? 'read' : 'tiles';
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

/** Does this stdout/stderr line carry module diagnostics worth streaming? */
export function isModuleLine(line) {
  return RE_MODULE_LINE.test(line);
}
