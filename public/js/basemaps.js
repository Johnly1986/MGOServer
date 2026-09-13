/**
 * 查看器底图源（免费公开 XYZ 瓦片服务，无需 ion token）。
 * 全部支持 CORS；归属文案在 HUD credit 行展示。
 */
export const BASE_MAPS = {
  esri_img: {
    label: '🛰 卫星影像 (Esri)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    max: 19,
    credit: '影像 © Esri, Maxar, Earthstar Geographics, 及 GIS 用户社区',
  },
  esri_street: {
    label: '🗺 街道地图 (Esri)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    max: 19,
    credit: '© Esri, HERE, Garmin, Foursquare, OpenStreetMap 贡献者',
  },
  osm: {
    label: '🧭 OSM 标准地图',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    max: 19,
    credit: '© OpenStreetMap 贡献者 (ODbL)',
  },
  carto_dark: {
    label: '🌙 Carto 深色',
    url: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    max: 20,
    credit: '© OpenStreetMap 贡献者 © CARTO',
  },
  carto_light: {
    label: '☀️ Carto 浅色',
    url: 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    max: 20,
    credit: '© OpenStreetMap 贡献者 © CARTO',
  },
  topo: {
    label: '⛰ OpenTopoMap 地形',
    url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
    max: 17,
    credit: '© OpenStreetMap 贡献者 (ODbL)；高程 SRTM/ASTER',
  },
};
