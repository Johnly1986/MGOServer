/**
 * 任务类型元数据与参数表单规格（console 专用）。
 * 字段键与 src/jobs/schemas.js、src/jobs/argv.js 的映射保持一致：
 * 这里只是「JSON → 表单控件」的声明式描述，不含任何 DOM。
 */

export const ICONS = { tiles: '🏗', terrain: '⛰', image: '🛰', geojson: '📍', mesh: '🧊', osgb: '📷' };
export const DESC = {
  tiles: '模型（FBX/OBJ 等，支持多文件）→ 3D Tile',
  terrain: 'DEM GeoTIFF → Cesium 地形瓦片',
  image: '正射影像 GeoTIFF → TMS 瓦片',
  osgb: 'OSGB 倾斜摄影 → 3D Tiles',
  geojson: 'GeoJSON → EPSG:4326',
  mesh: '模型分组简化 → 新模型格式'
};
export const TYPE_CN = {
  tiles: '模型转 3D Tiles', terrain: '地形切片', image: '影像切片',
  geojson: '坐标转换', mesh: '模型简化', osgb: '倾斜摄影',
};
/* select 值的中文注释（value 不变，仅显示更直观） */
export const OPT_CN = {
  '7param': '七参数', multipos: '控制点拟合', anchor: '锚点',
  original: '原始坐标', left: '左手坐标系',
  ADD: '叠加细化', REPLACE: '替换细化',
};
/** 输入区 accept 白名单（与服务端 INPUT_EXT 对齐；zip 是上传通道附加项） */
export const FILE_ACCEPT = {
  tiles: '.fbx,.obj,.gltf,.glb,.dae,.3ds,.ply,.stl',
  mesh: '.fbx,.obj,.gltf,.glb,.dae,.3ds,.ply,.stl',
  terrain: '.tif,.tiff',
  image: '.tif,.tiff',
  geojson: '.geojson,.json',
};
export const fileAccept = (t) => FILE_ACCEPT[t] ?? '';

/** 一个表单字段的声明：k=参数路径（@ 前缀=附件），t=控件类型 */
export const F = (k, t, label, o = {}) => ({ k, t, label, ...o });
export const el2 = (name, fields) => ({ name, fields });

export const gProj = () => el2('投影', [
  F('proj.crs', 'text', '输入数据坐标系', { span: true, ph: 'EPSG:4547 / WKT / +proj=…', hint: '声明输入数据所用的坐标系（EPSG 代码 / WKT / proj4 字符串）' }),
  F('@prj', 'file', '或上传 .prj / .wkt 文件', { accept: '.prj,.wkt,.proj', span: true, uploadOnly: true, hint: '提供投影定义文件（「⬆ 上传」模式），上传后忽略上方文本框' }),
  F('proj.prjPath', 'pathtext', '或选择服务器投影文件（.prj / .wkt / .proj）', {
    span: true, pext: '.prj,.wkt,.proj', ph: '/data/prj/cgcs2000.prj',
    hint: '「🖥 服务器路径」模式专用：浏览选取服务器本地投影定义文件',
  }),
]);
export const gOrigin = (label = '坐标原点') => el2(label, [
  F('origin', 'vec3', 'Origin', { subs: ['E/X (m)', 'N/Y (m)', 'H (m)'], hint: '输出瓦片网格的原点坐标（局部坐标 → 地心的平移量）' }),
]);
export const gGeoref = ({ meshOffset = false } = {}) => {
  const g = el2('地理配准', [
    F('georef.mode', 'select', '配准方式', { opts: ['', '7param', 'multipos', 'anchor'], hint: '把源数据对齐到目标坐标系的方法；留空 = 按已填参数自动判定' }),
    F('georef.fitOrder', 'select', '拟合阶数', { opts: ['', '1', '2', '3'], hint: '控制点拟合多项式阶数：1=刚性/相似，2=二次，3=三次；点数少时用 1' }),
    F('georef.autoCrs', 'bool', '自动识别源坐标系', { hint: '让 CLI 尝试从数据 / sidecar 文件识别源 CRS' }),
    F('georef.sevenParameter', 'seven', '七参数', { span: true, hint: 'Helmert 七参数：3 平移 + 3 旋转 + 1 尺度，用于不同大地坐标系间的转换',
      subs: [['mx', null, '平移 (m)'], ['my', null, '平移 (m)'], ['mz', null, '平移 (m)'],
             ['rx', null, '旋转 (角秒)'], ['ry', null, '旋转 (角秒)'], ['rz', null, '旋转 (角秒)'],
             ['s', null, '尺度 (ppm)']] }),
    F('georef.controlPoints', 'area', '控制点 CSV 文本（源 → 目标）', { span: true, hint: '每行一条：源X,源Y,源Z,目标X,目标Y,目标Z（逗号或空格分隔），至少 3 条' }),
    F('@cps', 'file', '或上传控制点 .csv', { accept: '.csv,.txt', span: true, uploadOnly: true, hint: '内容与上方文本框相同，来自文件时优先生效' }),
  ]);
  if (meshOffset) g.fields.push(F('georef.offset', 'vec3', '投影偏移', { subs: [['dE', null, '米'], ['dN', null, '米'], ['dH', null, '米']], hint: '配准完成后的整体平移量（米），用于微调成果位置' }));
  return g;
};
export const gSimplify = ({ local = false, errPh = '留空=不简化' } = {}) => {
  const g = el2('简化', [
    F('simplify.error', 'num', '误差 error', { ph: errPh, min: 0, max: 0.2, hint: '简化允许的相对几何偏差；值越大保留的面越少、速度越快' }),
    F('simplify.normalWeight', 'num', '法线权重', { ph: '默认 0.1', min: 0, max: 1, hint: '简化时保持法线方向的权重；越大光照越平滑稳定' }),
    F('simplify.threshold', 'num', '三角面比例', { ph: '默认 0.1', min: 0, hint: '面合并的判定比例；越大简化越保守' }),
    // mesh 的 -L 是带值布尔且 CLI 默认开 → 默认勾选；其余类型默认关
    F('simplify.lockBorder', 'bool', '锁边', local ? { def: true, hint: '固定开放边界与接缝顶点，防止简化后模型出现裂缝' } : { hint: '固定开放边界与接缝顶点，防止简化后模型出现裂缝' }),
  ]);
  if (local) g.fields.push(F('simplify.localError', 'bool', '按绝对误差简化', { hint: '误差按绝对值（米）逐网格判定，而非相对整模型尺寸' }));
  return g;
};
/* BIM 属性绑定（引擎 tiles --bim-*）：构件级业务属性写入每个 b3dm 的
 * Batch Table，查看器「点击模型」直接读取展示。外部属性表走 props 附件
 * （服务端落盘为 _bim_props.csv），引擎侧 --bim-props 隐含开启绑定 → 选了
 * 属性表就自动勾上「启用绑定」（syncBim），与 CLI 语义保持一致。 */
export const gBim = () => el2('属性绑定（BIM）', [
  F('bim.bind', 'bool', '启用属性绑定', { span: true, hint: '把构件属性（IFC GlobalId / FBX·glTF UDP 元数据 / 外部属性表）写入 3D Tiles Batch Table；查看器中点击模型即可查看详情。不勾且未选属性表 = 完全不传 --bim-* 参数，输出与旧管线逐字节一致' }),
  F('@props', 'file', '外部属性表 CSV（首列 = 构件 ID 关联键）', { accept: '.csv,.txt', span: true, uploadOnly: true, hint: '台账表：首列为关联键（对象名 / GUID），支持 RFC4180 引号与 UTF-8 BOM；纯数字单元格升为整型/浮点列，其余按字符串保留。选择后自动开启绑定' }),
  F('bim.propsPath', 'pathtext', '或选择服务器属性表 CSV（.csv / .txt）', { span: true, pext: '.csv,.txt', ph: '/data/ledger.csv', hint: '「🖥 服务器路径」模式专用；与「⬆ 上传」属性表二选一，上传文件优先' }),
  F('bim.idProperty', 'text', '构件 ID 键（逗号分隔，可留空）', { span: true, ph: 'GlobalId,ElementId', hint: '覆盖默认 ID 键：先在场景元数据、再在属性表列名中查找；留空 = 用各格式默认键（GlobalId / ElementId / ifcGUID / UniqueId）' }),
  F('bim.strategy', 'select', '绑定策略', { opts: ['', 'ifc', 'fbx', 'gltf2', 'obj', '3ds', 'generic'], hint: '构件 ID / 元数据的按格式解析方式；留空 = 按输入文件扩展名自动选择，仅在识别不准时强制指定' }),
  F('bim.noSceneMeta', 'bool', '仅用外部属性表', { hint: '跳过场景内元数据（--bim-no-scene-meta）：属性完全来自 CSV' }),
  F('bim.noInherit', 'bool', '不继承父节点元数据', { hint: '子构件不再继承祖先节点上的元数据（--bim-no-inherit）' }),
  F('bim.report', 'bool', '输出绑定透明度报告', { hint: '逐构件的 ID 命中来源与匹配情况写入 out/<模型>/bim_report.json，在任务产物列表中可下载核对' }),
]);

/** 每类型的「高级参数」组（渲染时拼在 BASIC 组之后） */
export const UI = {
  tiles: () => [gProj(), gOrigin(), gGeoref(), gSimplify(), gBim()],
  terrain: () => ([
    { name: '地形参数', fields: [
      F('maxLod', 'int', '最大层级 LOD', { ph: '留空=自动', min: 1, hint: '地形瓦片细分到第几级；越大越精细，输出量级成倍增加' }),
      F('samplesPerTile', 'int', '每瓦片采样数', { ph: '65', min: 2, max: 255, odd: true, hint: '每个地形瓦片的网格采样点数（须为奇数，如 33/65/129/257）' }),
      F('normals', 'bool', '导出顶点法线', { def: true, hint: '输出法线数据，地形光照更平滑（体积略增大）' }),
    ]},
    gOrigin('坐标原点'), gProj(), gGeoref(),
    gSimplify({ local: false, errPh: '留空=0.001' }),
  ]),
  image: () => [gProj()],
  geojson: () => ([{ name: '转换参数（输出默认转经纬度）', fields: [
    F('sourceCrs', 'text', '源坐标系', { span: true, ph: 'EPSG:4547 / ENU:lat,lon / WKT / +proj=' , hint: '留空则读文件内 crs 成员，均无时按经纬度处理；目标坐标系固定为 EPSG:4326，无需设置' }),
    F('pretty', 'bool', '格式化输出 JSON', { hint: '缩进排版输出文件，便于阅读（体积略增大）' }),
  ]}]),
  mesh: () => ([
    { name: '输出', fields: [
      F('outputFormat', 'select', '输出格式', { opts: ['glb', 'gltf', 'obj', 'fbx', 'ply'], hint: '目标模型格式；glb 为二进制单文件，最通用' }),
      F('coordMode', 'select', '输出坐标系', { opts: ['', 'original', 'left'], hint: 'original=保持原始坐标，left=转左手系；默认自动转地心坐标' }),
      F('reorder', 'bool', '顶点重排优化（减小体积）', { hint: '按空间邻接重排顶点顺序，压缩率更高、加载更快' }),
      F('rebuild', 'bool', '加载时重建场景', { hint: '加载输入时强制重建场景图，用于排查异常结构' }),
      F('@cfg', 'file', '或上传逐构件简化配置 CSV（按名称匹配）', { accept: '.csv,.txt', span: true, uploadOnly: true, hint: '每行：构件名,误差 —— 为不同构件单独指定简化力度' }),
    ]},
    gProj(), gGeoref({ meshOffset: true }), gSimplify({ local: true }),
  ]),
  osgb: () => ([
    { name: 'OSGB', fields: [
      F('maxLod', 'int', '最大层级 LOD', { ph: '留空=自动', min: 1, hint: '模型瓦片最大细分层级；越大越精细，耗时成倍增加' }),
      F('enu', 'vec3', 'ENU 参考点（覆盖自动计算）', {
        subs: [['纬度°', { min: -90, max: 90 }], ['经度°', { min: -180, max: 180 }], ['高程 m', null]],
        span: true, hint: '转站参考点（模型所在地理位置）；留空 = 从 OSG 元数据自动计算',
      }),
    ]},
    gOrigin(), gProj(), gGeoref(), gSimplify(),
  ]),
};

/** 每类型的核心组（首个 details 默认展开） */
export const BASIC = {
  tiles: [
    { name: '3D Tiles', fields: [
      F('zUp', 'bool', 'Y-up ↔ Z-up', { span: true, hint: '仅当源模型坐标已符合测量惯例（Z 轴向上）时勾选' }),
    ]},
    { name: '分块与 LOD', fields: [
      F('rootGeometricError', 'num', '根几何误差（米）', { ph: '留空=按包围盒自动', pos: true, hint: '最粗一级瓦片的屏幕误差预算；越大首屏越快、远景越糊' }),
      F('refine', 'select', '细化模式', { opts: ['', 'ADD', 'REPLACE'], hint: 'ADD=子瓦片叠加在父瓦片上（地形常用），REPLACE=子瓦片替换父瓦片（白模常用）' }),
      F('minBlockDistance', 'num', '最小分块距离（米）', { ph: '留空=自动', pos: true, hint: '两物体距离小于此值时合并为一块，不再细分' }),
      F('maxLod', 'int', '最大层级 LOD', { ph: '留空=自动', min: 1, hint: '模型瓦片最大细分层级；越大越精细，耗时成倍增加' }),
    ]},
  ],
};
