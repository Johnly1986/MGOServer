import { z } from 'zod';

/**
 * zod schemas for every job type (docs/VISUALIZATION_SERVICE_DESIGN.md §6.3,
 * appendix A).  The API layer validates against these BEFORE anything touches
 * the mgo CLI; a 422 here means the service must never see exit code 2.
 */

const num = z.number().finite();
const vec3 = z.array(num).length(3);
const crsSpec = z.string().min(2).max(8000);

export const projSchema = z.object({
  crs: crsSpec.optional(),          // inline EPSG:<code> / WKT / +proj=...
  prjPath: z.string().min(1).optional(), // server-side .prj path (allowedRoots enforced)
}).strict().refine((v) => Boolean(v.crs) !== Boolean(v.prjPath), {
  message: 'proj requires exactly one of crs | prjPath',
});

export const georefSchema = z.object({
  mode: z.enum(['7param', 'multipos', 'anchor']).optional(),
  sevenParameter: z.array(num).length(7).optional(),
  controlPoints: z.string().min(4).optional(),      // inline CSV text (sx,sy,sz,tx,ty,tz)
  controlPointsPath: z.string().min(1).optional(),  // server-side CSV path
  fitOrder: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  autoCrs: z.boolean().optional(),
  offset: vec3.optional(),                          // --offset, mesh only
});

export const simplifySchema = z.object({
  error: num.min(0).optional(),
  normalWeight: num.min(0).max(1).optional(),
  threshold: num.min(0).optional(),
  lockBorder: z.boolean().optional(),
  localError: z.boolean().optional(),               // -l, mesh only
}).strict();

const base = { verbose: z.boolean().optional() };

export const tilesSchema = z.object({
  type: z.literal('tiles'),
  zUp: z.boolean().optional(),
  rootGeometricError: num.gt(0).optional(),
  tileGeometricError: num.gt(0).optional(),
  refine: z.enum(['ADD', 'REPLACE']).optional(),
  origin: vec3.optional(),
  minBlockDistance: num.gt(0).optional(),
  maxLod: z.number().int().positive().optional(),
  proj: projSchema.optional(),
  georef: georefSchema.optional(),
  simplify: simplifySchema.optional(),
  ...base,
}).strict();

export const terrainSchema = z.object({
  type: z.literal('terrain'),
  maxLod: z.number().int().positive().optional(),
  samplesPerTile: z.number().int().refine(
    (v) => v >= 2 && v <= 255 && v % 2 === 1,
    { message: 'samplesPerTile must be an odd integer in [2, 255]' }).optional(),
  normals: z.boolean().optional(),                  // false → --no-normals
  origin: vec3.optional(),
  proj: projSchema.optional(),
  georef: georefSchema.optional(),
  simplify: simplifySchema.optional(),
  ...base,
}).strict();

export const imageSchema = z.object({
  type: z.literal('image'),
  proj: projSchema.optional(),
}).strict();

export const geojsonSchema = z.object({
  type: z.literal('geojson'),
  sourceCrs: crsSpec.optional(),
  targetCrs: crsSpec.optional(),
  pretty: z.boolean().optional(),
}).strict();

export const meshSchema = z.object({
  type: z.literal('mesh'),
  outputFormat: z.enum(['glb', 'gltf', 'obj', 'fbx', 'ply']).default('glb'),
  coordMode: z.enum(['original', 'left']).optional(),
  reorder: z.boolean().optional(),                  // -r (meshopt reorder pass, on/off)
  rebuild: z.boolean().optional(),                  // -R (rebuild/clean scene, on/off)
  configCsvPath: z.string().min(1).optional(),      // -c (server path)
  proj: projSchema.optional(),
  georef: georefSchema.optional(),
  simplify: simplifySchema.optional(),
  ...base,
}).strict();

export const osgbSchema = z.object({
  type: z.literal('osgb'),
  enu: z.array(num).length(2).or(z.array(num).length(3)).optional(),
  origin: vec3.optional(),
  maxLod: z.number().int().positive().optional(),
  proj: projSchema.optional(),
  georef: georefSchema.optional(),
  simplify: simplifySchema.optional(),
  ...base,
}).strict();

export const jobSchema = z.discriminatedUnion('type', [
  tilesSchema, terrainSchema, imageSchema,
  geojsonSchema, meshSchema, osgbSchema,
]);

export const JOB_TYPES = ['tiles', 'terrain', 'image', 'geojson', 'mesh', 'osgb'];

/** Input file extension whitelist per job type (server-side pre-validation). */
export const INPUT_EXT = {
  tiles: ['fbx', 'obj', 'gltf', 'glb', 'dae', '3ds', 'ply', 'stl'],
  mesh: ['fbx', 'obj', 'gltf', 'glb', 'dae', '3ds', 'ply', 'stl'],
  terrain: ['tif', 'tiff'],
  image: ['tif', 'tiff'],
  geojson: ['geojson', 'json'],
  osgb: [], // directory via inputPath, or (M3) zip
};

export const INPUT_KIND = {
  tiles: 'file', mesh: 'file', terrain: 'file',
  image: 'file', geojson: 'file', osgb: 'dir',
};
