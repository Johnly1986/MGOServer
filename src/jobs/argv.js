import path from 'node:path';

/**
 * Validated job params → mgo argv array (docs/VISUALIZATION_SERVICE_DESIGN.md
 * appendix A).  Flags mirror MGOConsole's actual parsing per subcommand —
 * note that `mesh` uses short forms (-p/-g/-e/-n/-t/-L/-l) while the tile
 * converters use long forms (--prj/--georef/--error/...).
 *
 * buildArgs() receives PREPARED io paths only (inline control-point CSV has
 * already been written to disk by the manager).  spawn(binary, argv[]) — the
 * array never passes through a shell.
 */

const SUBCMD = {
  tiles: 'tiles', terrain: 'terrain', image: 'image',
  geojson: 'geojson', mesh: 'mesh', osgb: 'osgb',
};

const j = (v) => String(v);
const j3 = (a) => a.map(j).join(',');

function addProj(a, proj, flag = '--prj', prjFile) {
  const v = prjFile ?? proj?.prjPath ?? proj?.crs;
  if (v) a.push(flag, v);
}

function addOrigin(a, origin) {
  if (origin) a.push('--origin', j3(origin));
}

function addGeoref(a, g, { cpsFile, modeFlag = '--georef' } = {}) {
  if (!g) return;
  // NOTE: the CLI treats --7p / --cps as self-typing flags (they set the
  // georef mode themselves), so they must be forwarded even without an
  // explicit `mode` — gating on mode silently dropped filled-in params.
  if (g.mode) a.push(modeFlag, g.mode);
  if (g.sevenParameter) a.push('--7p', g.sevenParameter.map(j).join(','));
  const cps = cpsFile ?? g.controlPointsPath;
  if (cps) a.push('--cps', cps);
  if (g.fitOrder) a.push('--fit-order', j(g.fitOrder));
  if (g.autoCrs) a.push('--auto-crs');
  // note: --offset is mesh-only and handled in the mesh branch
}

function addSimplify(a, s, { mesh = false } = {}) {
  if (!s) return;
  if (mesh) {
    if (s.error !== undefined) a.push('-e', j(s.error));
    if (s.normalWeight !== undefined) a.push('-n', j(s.normalWeight));
    if (s.threshold !== undefined) a.push('-t', j(s.threshold));
    // NOTE: mesh -L/-l take a VALUE ("-L true|false") unlike the tile
    // converters' bare --lock-border; mesh lockBorder DEFAULTS to true in the
    // CLI, so an explicit -L false is how a user opts out.
    if (s.lockBorder !== undefined) a.push('-L', s.lockBorder ? 'true' : 'false');
    if (s.localError === true) a.push('-l', 'true');
  } else {
    if (s.error !== undefined) a.push('--error', j(s.error));
    if (s.normalWeight !== undefined) a.push('--nweight', j(s.normalWeight));
    if (s.threshold !== undefined) a.push('--threshold', j(s.threshold));
    if (s.lockBorder === true) a.push('--lock-border');
  }
}

/**
 * @param job    {type, params}
 * @param io     {input: string, out: string, cpsFile?: string}  absolute paths
 * @returns {string[]} argv after the binary, e.g. ['tiles','-i',...,'-o',...]
 */
export function buildArgs(job, io) {
  const p = job.params ?? {};
  const a = [SUBCMD[job.type], '-i', io.input, '-o', io.out];

  switch (job.type) {
    case 'tiles':
      if (p.zUp) a.push('-Z');
      if (p.rootGeometricError !== undefined) a.push('-e', j(p.rootGeometricError));
      if (p.tileGeometricError !== undefined) a.push('-t', j(p.tileGeometricError));
      if (p.refine) a.push('-r', p.refine);
      if (p.minBlockDistance !== undefined) a.push('--min-block', j(p.minBlockDistance));
      if (p.maxLod !== undefined) a.push('--max-lod', j(p.maxLod));
      addProj(a, p.proj, "--prj", io.prjFile);
      addOrigin(a, p.origin);
      addGeoref(a, p.georef, { cpsFile: io.cpsFile });
      addSimplify(a, p.simplify);
      break;

    case 'terrain':
      if (p.maxLod !== undefined) a.push('--max-lod', j(p.maxLod));
      if (p.samplesPerTile !== undefined) a.push('--samples', j(p.samplesPerTile));
      if (p.normals === false) a.push('--no-normals');
      addProj(a, p.proj, "--prj", io.prjFile);
      addOrigin(a, p.origin);
      addGeoref(a, p.georef, { cpsFile: io.cpsFile });
      addSimplify(a, p.simplify);
      a.push('-v'); // module diagnostics are cheap and useful in run.log
      break;

    case 'image':
      addProj(a, p.proj, "--prj", io.prjFile);
      break;

    case 'geojson':
      if (p.sourceCrs) a.push('--source-crs', p.sourceCrs);
      if (p.targetCrs) a.push('--target-crs', p.targetCrs);
      if (p.pretty) a.push('--pretty');
      break;

    case 'mesh':
      addProj(a, p.proj, "-p", io.prjFile);
      if (p.coordMode) a.push('-C', p.coordMode);
      if (p.reorder === true) a.push('-r', 'true');   // CLI bool (GetBool accepts "true"/"1")
      if (p.rebuild === true) a.push('-R', 'true');
      if (io.cfgFile ?? p.configCsvPath) a.push('-c', io.cfgFile ?? p.configCsvPath);
      if (p.georef) {
        if (p.georef.mode) a.push('-g', p.georef.mode);
        if (p.georef.sevenParameter) a.push('--7p', p.georef.sevenParameter.map(j).join(','));
        const cps = io.cpsFile ?? p.georef.controlPointsPath;
        if (cps) a.push('--cps', cps);
        if (p.georef.fitOrder) a.push('--fit-order', j(p.georef.fitOrder));
        if (p.georef.autoCrs) a.push('--auto-crs');
        if (p.georef.offset) a.push('--offset', j3(p.georef.offset));
      }
      addSimplify(a, p.simplify, { mesh: true });
      break;

    case 'osgb':
      addProj(a, p.proj, "--prj", io.prjFile);
      if (p.enu) a.push('--enu', j3(p.enu));
      addOrigin(a, p.origin);
      if (p.maxLod !== undefined) a.push('--max-lod', j(p.maxLod));
      addGeoref(a, p.georef, { cpsFile: io.cpsFile });
      addSimplify(a, p.simplify);
      a.push('-v');
      break;

    default:
      throw new Error(`unknown job type: ${job.type}`);
  }
  return a;
}

/** Output target inside the job workspace for a given job (dir vs file). */
export function resolveOutPath(job, outDir, inputName) {
  if (job.type === 'mesh') {
    const stem = path.basename(inputName, path.extname(inputName)) || 'model';
    return path.join(outDir, `${stem}.${job.params.outputFormat ?? 'glb'}`);
  }
  if (job.type === 'geojson') {
    const stem = path.basename(inputName, path.extname(inputName)) || 'output';
    return path.join(outDir, `${stem}.geojson`);
  }
  return outDir;
}
