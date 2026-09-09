import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, buildMergeArgs, resolveOutPath, tileStem } from '../src/jobs/argv.js';
import { jobSchema } from '../src/jobs/schemas.js';

const P = (o) => jobSchema.parse(o);

test('tiles: full mapping matches mgo CLI flags', () => {
  const params = P({
    type: 'tiles', zUp: true, rootGeometricError: 500, tileGeometricError: 50,
    refine: 'REPLACE', origin: [445000, 3260000, 0], minBlockDistance: 100, maxLod: 5,
    proj: { crs: 'EPSG:4547' },
    georef: { mode: 'multipos', fitOrder: 2, controlPointsPath: '/data/cp.csv' },
    simplify: { error: 0.01, normalWeight: 0.1, threshold: 0.1, lockBorder: true },
  });
  const args = buildArgs({ type: 'tiles', params },
    { input: '/in/a.fbx', out: '/out' });
  assert.deepEqual(args, [
    'tiles', '-i', '/in/a.fbx', '-o', '/out',
    '-Z', '-e', '500', '-t', '50', '-r', 'REPLACE',
    '--min-block', '100', '--max-lod', '5',
    '--prj', 'EPSG:4547', '--origin', '445000,3260000,0',
    '--georef', 'multipos', '--cps', '/data/cp.csv', '--fit-order', '2',
    '--error', '0.01', '--nweight', '0.1', '--threshold', '0.1', '--lock-border',
  ]);
});

test('tiles: inline cps prepared as file overrides path param', () => {
  const params = P({ type: 'tiles', georef: { mode: 'multipos', controlPoints: 'sx,sy,sz,tx,ty,tz\n1,2,3,4,5,6' } });
  const args = buildArgs({ type: 'tiles', params },
    { input: '/in/a.fbx', out: '/out', cpsFile: '/w/controlpoints.csv' });
  assert.ok(args.includes('--cps') && args.includes('/w/controlpoints.csv'));
});

test('uploaded prj file wins over proj.crs / proj.prjPath (prjFile priority)', () => {
  const params = P({ type: 'tiles', proj: { crs: 'EPSG:4547' } });
  const args = buildArgs({ type: 'tiles', params },
    { input: '/in/a.fbx', out: '/out', prjFile: '/w/input/_projection.prj' });
  assert.ok(args.includes('--prj') && args.includes('/w/input/_projection.prj'));
  assert.ok(!args.includes('EPSG:4547'), 'uploaded file must supersede the inline crs');
  const mesh = buildArgs({ type: 'mesh', params: { proj: { prjPath: '/data/x.prj' } } },
    { input: '/in/a.fbx', out: '/out/a.glb', prjFile: '/w/_projection.wkt' });
  assert.equal(mesh.at(mesh.indexOf('-p') + 1), '/w/_projection.wkt',
    'mesh: staged file wins over prjPath too');
});

test('proj schema: exactly one of crs | prjPath', () => {
  assert.equal(jobSchema.safeParse({ type: 'tiles', proj: { crs: 'EPSG:4547' } }).success, true);
  assert.equal(jobSchema.safeParse({ type: 'tiles', proj: { prjPath: '/d/x.prj' } }).success, true);
  assert.equal(jobSchema.safeParse({ type: 'tiles', proj: { crs: 'EPSG:4547', prjPath: '/d/x.prj' } }).success, false);
  assert.equal(jobSchema.safeParse({ type: 'tiles', proj: {} }).success, false);
});

test('terrain: samples/maxLod/no-normals + implicit -v', () => {
  const params = P({ type: 'terrain', maxLod: 8, samplesPerTile: 65, normals: false,
    proj: { prjPath: '/data/x.prj' } });
  const args = buildArgs({ type: 'terrain', params }, { input: '/in/d.tif', out: '/out' });
  assert.deepEqual(args, [
    'terrain', '-i', '/in/d.tif', '-o', '/out',
    '--max-lod', '8', '--samples', '65', '--no-normals',
    '--prj', '/data/x.prj', '-v',
  ]);
});

test('image: only -i/-o/--prj accepted', () => {
  const params = P({ type: 'image', proj: { crs: 'EPSG:4528' } });
  assert.deepEqual(buildArgs({ type: 'image', params }, { input: '/i.tif', out: '/o' }),
    ['image', '-i', '/i.tif', '-o', '/o', '--prj', 'EPSG:4528']);
});

test('geojson: crs + pretty', () => {
  const params = P({ type: 'geojson', sourceCrs: 'EPSG:4547', targetCrs: 'EPSG:4326', pretty: true });
  assert.deepEqual(buildArgs({ type: 'geojson', params }, { input: '/in/a.geojson', out: '/out/a.geojson' }),
    ['geojson', '-i', '/in/a.geojson', '-o', '/out/a.geojson',
      '--source-crs', 'EPSG:4547', '--target-crs', 'EPSG:4326', '--pretty']);
});

test('mesh: short-form flags (-p/-g/-e/-n/-t/-L/-l) + output file', () => {
  const params = P({
    type: 'mesh', outputFormat: 'glb', coordMode: 'left', reorder: true, rebuild: true,
    proj: { crs: 'EPSG:4547' },
    georef: { mode: '7param', sevenParameter: [1, 2, 3, 0.1, 0.2, 0.3, 5], offset: [0, 0, 0] },
    simplify: { error: 0.01, normalWeight: 0.1, threshold: 0.1, lockBorder: true, localError: true },
  });
  const args = buildArgs({ type: 'mesh', params },
    { input: '/in/a.fbx', out: '/out/a.glb' });
  assert.deepEqual(args, [
    'mesh', '-i', '/in/a.fbx', '-o', '/out/a.glb',
    '-p', 'EPSG:4547', '-C', 'left', '-r', 'true', '-R', 'true',
    '-g', '7param', '--7p', '1,2,3,0.1,0.2,0.3,5', '--offset', '0,0,0',
    '-e', '0.01', '-n', '0.1', '-t', '0.1', '-L', 'true', '-l', 'true',
  ]);
});

test('mesh: -L/-l take a value; lockBorder:false emits -L false (CLI default is ON)', () => {
  const args = buildArgs({ type: 'mesh', params: { simplify: { lockBorder: false, localError: true } } },
    { input: '/in/a.fbx', out: '/out/a.glb' });
  assert.ok(args.includes('-L') && args[args.indexOf('-L') + 1] === 'false');
  assert.ok(args.includes('-l') && args[args.indexOf('-l') + 1] === 'true');
});

test('mesh: reorder/rebuild are booleans — false/absent emit nothing', () => {
  const args = buildArgs({ type: 'mesh', params: { reorder: false, rebuild: false } },
    { input: '/in/a.fbx', out: '/out/a.glb' });
  assert.ok(!args.includes('-r') && !args.includes('-R'));
});

test('georef: --7p / --cps forwarded without explicit mode (self-typing flags)', () => {
  const a7p = buildArgs({ type: 'tiles', params: { georef: { sevenParameter: [1, 2, 3, 4, 5, 6, 7] } } },
    { input: '/in/a.fbx', out: '/out' });
  assert.ok(a7p.includes('--7p') && a7p.includes('1,2,3,4,5,6,7'), 'sevenParameter must not be dropped');
  assert.ok(!a7p.includes('--georef'), 'no mode → no --georef flag');
  const acps = buildArgs({ type: 'terrain', params: { georef: { controlPointsPath: '/data/cp.csv' } } },
    { input: '/in/a.tif', out: '/out' });
  assert.ok(acps.includes('--cps') && acps.includes('/data/cp.csv'));
});

test('georef offset is mesh-only — tiles/terrain/osgb must not emit --offset', () => {
  const args = buildArgs({ type: 'tiles', params: { georef: { mode: '7param', offset: [1, 2, 3] } } },
    { input: '/in/a.fbx', out: '/out' });
  assert.ok(!args.includes('--offset'), 'tiles CLI has no --offset');
});

test('osgb: enu/origin/maxLod/georef/simplify', () => {
  const params = P({ type: 'osgb', enu: [30.5, 120.2], maxLod: 18,
    georef: { mode: 'anchor' }, simplify: { error: 0.02 } });
  const args = buildArgs({ type: 'osgb', params }, { input: '/in/Data', out: '/out' });
  assert.ok(args.includes('--enu') && args.includes('30.5,120.2'));
  assert.ok(args.includes('--georef') && args.includes('anchor'));
  assert.ok(args.includes('--error') && args.includes('0.02'));
  assert.ok(args.at(-1) === '-v');
});

test('resolveOutPath: mesh/geojson write a file, tiles a per-input dir, others outDir', () => {
  assert.equal(resolveOutPath({ type: 'mesh', params: { outputFormat: 'glb' } }, '/w/out', 'scene.fbx'), '/w/out/scene.glb');
  assert.equal(resolveOutPath({ type: 'geojson', params: {} }, '/w/out', 'sites.geojson'), '/w/out/sites.geojson');
  // unified tiles layout: every input (1…N) converts into out/<stem>/
  assert.equal(resolveOutPath({ type: 'tiles', params: {} }, '/w/out', 'a.fbx'), '/w/out/a');
  assert.equal(resolveOutPath({ type: 'tiles', params: {} }, '/w/out', 'a b.dae'), '/w/out/a_b');
  assert.equal(resolveOutPath({ type: 'terrain', params: {} }, '/w/out', 'd.tif'), '/w/out');
});

test('tileStem: sanitizes, dedupes, falls back safely', () => {
  assert.equal(tileStem('model.fbx'), 'model');
  assert.equal(tileStem('../../etc/passwd.obj'), 'passwd');
  assert.equal(tileStem('a b.dae'), 'a_b');
  assert.equal(tileStem('.hidden'), 'hidden');
  assert.equal(tileStem('中文 楼宇.slb'), 'model'); // fully non-ASCII → fallback
  const used = new Set();
  assert.equal(tileStem('a.fbx', used), 'a');
  assert.equal(tileStem('a.obj', used), 'a_2');
  assert.equal(tileStem('中文.fbx', used), 'model');      // falls back…
  assert.equal(tileStem('楼宇.stl', used), 'model_2');    // …and dedupes
});

test('buildMergeArgs: 3d-tiles-tools mergeJson with one -i per result', () => {
  assert.deepEqual(
    buildMergeArgs(['/w/out/a/tileset.json', '/w/out/b/tileset.json'], '/w/out/tileset.json'),
    ['mergeJson', '-i', '/w/out/a/tileset.json', '-i', '/w/out/b/tileset.json', '-o', '/w/out/tileset.json']);
  assert.deepEqual(
    buildMergeArgs(['/w/out/a/tileset.json'], '/w/out/tileset.json'),
    ['mergeJson', '-i', '/w/out/a/tileset.json', '-o', '/w/out/tileset.json']);
});

test('schema rejects unknown keys, bad georef and even samplesPerTile', () => {
  assert.equal(jobSchema.safeParse({ type: 'tiles', bogus: 1 }).success, false);
  assert.equal(jobSchema.safeParse({ type: 'terrain', samplesPerTile: 64 }).success, false);
  assert.equal(jobSchema.safeParse({ type: 'terrain', samplesPerTile: 256 }).success, false, 'CLI caps samples at 255');
  assert.equal(jobSchema.safeParse({ type: 'terrain', samplesPerTile: 1 }).success, false, 'CLI requires >= 2');
  assert.equal(jobSchema.safeParse({ type: 'tiles', georef: { mode: '7param', sevenParameter: [1, 2] } }).success, false);
  assert.equal(jobSchema.safeParse({ type: 'tiles', refine: 'ADD' }).success, true);
  // mesh reorder/rebuild must be booleans (CLI GetBool)
  assert.equal(jobSchema.safeParse({ type: 'mesh', reorder: 0.5 }).success, false);
  assert.equal(jobSchema.safeParse({ type: 'mesh', reorder: true }).success, true);
});

test('schema: offset/localError are mesh-only, verbose is not an API param', () => {
  // --offset and -l exist only on the mesh CLI (verified against MGOConsole -h);
  // accepting them for tiles/terrain/osgb validated params that argv silently
  // dropped. verbose is service plumbing (terrain/osgb always pass -v for the
  // progress parser), never a user-settable param.
  assert.equal(jobSchema.safeParse({ type: 'tiles', georef: { offset: [1, 2, 3] } }).success, false);
  assert.equal(jobSchema.safeParse({ type: 'terrain', simplify: { localError: true } }).success, false);
  assert.equal(jobSchema.safeParse({ type: 'mesh', georef: { offset: [1, 2, 3] } }).success, true);
  assert.equal(jobSchema.safeParse({ type: 'mesh', simplify: { localError: true } }).success, true);
  assert.equal(jobSchema.safeParse({ type: 'terrain', verbose: true }).success, false);
  assert.equal(jobSchema.safeParse({ type: 'mesh', verbose: false }).success, false);
});
