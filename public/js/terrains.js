/**
 * 查看器在线地形源（免费公开 quantized-mesh 服务，无需 ion token）。
 * 与 basemaps.js 同级的「地球级」在线源注册表；归属文案在 HUD credit 行展示。
 *
 * re:Earth 全球地形（Mapterhorn 合并全球 DEM + EGM2008 垂直基准换算）：
 *   layer.json  https://terrain.reearth.land/cesium-mesh/ellipsoid/layer.json
 *   瓦片        https://terrain.reearth.land/cesium-mesh/ellipsoid/{z}/{x}/{y}.terrain
 * 标准 layer.json（tilejson 2.1.0）：format=quantized-mesh-1.0、scheme=tms、
 * projection=EPSG:4326（Cesium 据此用 2×1 的 GeographicTilingScheme）、0–14 级全球覆盖、
 * extensions=[octvertexnormals, watermask]（内嵌在瓦片二进制里，解码不产生额外请求）；
 * 高程已按 EGM2008 换算成椭球高，服务端 CORS 全开（access-control-allow-origin: *），
 * 浏览器直连即可，无需服务端代理。
 */
export const ONLINE_TERRAINS = {
  reearth: {
    label: '🌍 Re:Earth 全球地形',
    url: 'https://terrain.reearth.land/cesium-mesh/ellipsoid/',
    maxzoom: 14,
    credit: '地形 Re:Earth Terrain · Mapterhorn · EGM2008 (NGA)',
  },
};
