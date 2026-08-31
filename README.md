# MGOServer

[![Test](https://github.com/Johnly1986/MGOServer/actions/workflows/ci.yml/badge.svg)](https://github.com/Johnly1986/MGOServer/actions/workflows/ci.yml)

Node.js 可视化调用端口：把 [MGO](https://github.com/Johnly1986/MGO) 的转换能力暴露为 HTTP 服务，任务产物以 CesiumJS 直接渲染。
设计文档见 [docs/VISUALIZATION_SERVICE_DESIGN.md](docs/VISUALIZATION_SERVICE_DESIGN.md)。

- **控制面** `GET/POST /api/v1/*` — 任务提交 / 状态 / 进度（SSE）/ 取消 / 产物清单
- **数据面** `GET /ws/{jobId}/out/**` — 任务产物静态托管（3D Tiles / terrain / TMS 影像 / GeoJSON / glTF，CORS + immutable 缓存）
- **前端** `/console.html`（任务控制台）、`/viewer.html`（CesiumJS 查看器）、`/whitelist.html`（白名单设置）

> 本工程从 MGO 主仓库的 `mgo-server/` 子目录独立而来（v0.1.0），只依赖 MGO 的**可执行文件**，
> 不再与其共享代码树；C++ 侧的进度协议 `[Module] Progress: X/Y` / `Done:` 仍是跨仓库契约。

## 运行

前置：Node ≥ 20，以及一份已构建的 MGO C++ 工具链（默认按同级目录 `../MGO/build/bin/MGOConsole` 探测，
也可用 `MGO_BINARY` 指定绝对路径）。

```bash
git clone git@github.com:Johnly1986/MGO.git ../MGO && (cd ../MGO && make release)   # 被驱动的二进制
git clone git@github.com:Johnly1986/MGOServer.git && cd MGOServer
npm ci
cp .env.example .env            # 可选：常驻部署的默认配置（见下）
npm start                       # 0.0.0.0:8080，需客户端 IP 在白名单内
```

配置来源优先级：**真实环境变量 > `.env`（`MGO_ENV_FILE` 可改路径）> 内置默认值**。
`src/dotenv.js` 自带零依赖的 `.env` 解析，`npm start`、裸 `node src/server.js`、systemd
`ExecStart` 三条路径行为一致——不再出现「shell 里 export 过就能用，重启后配置消失」。

| 变量 | 默认 | 说明 |
|------|------|------|
| `MGO_HOST` / `MGO_PORT` | `0.0.0.0` / `8080` | 监听地址。设 `127.0.0.1` 可只留本机（配合反代） |
| `MGO_ENV_FILE` | `<repo>/.env` | 配置文件路径；不存在则静默跳过 |
| `MGO_BINARY` | `../MGO/build/bin/MGOConsole` | mgo 可执行文件；**显式设置即权威**（路径写错时 `mgo.found=false` + 启动告警，不再悄悄回退到 PATH 上的同名程序） |
| `MGO_WORKSPACE` | `workspace/` | 任务目录（上传/产物/日志/job.json/`whitelist.json`），TTL 自动清理 |
| `MGO_MAX_CONCURRENT_JOBS` | `1` | 任务级并发（terrain 内部已多线程，勿轻易调大） |
| `MGO_UPLOAD_MAX_BYTES` | 2 GiB | 上传上限 |
| `MGO_ALLOW_LOCAL_PATH=1` + `MGO_ALLOWED_ROOTS` | 关 | 免上传直读服务器本地文件/目录（OSGB 必需） |
| `MGO_IP_WHITELIST` | `127.0.0.1`/`::1` | **全局访问白名单**（页面/API/产物/写操作均校验；本机始终允许），逗号分隔 IP 或 CIDR |
| `MGO_TRUST_PROXY` | `loopback` | 允许哪些对端通过 `X-Forwarded-For` 改写客户端 IP：本机反代用 `loopback`，多级/异地反代用跳数或网段。**没有 `true` 这个安全取值**——那等于允许远程客户端伪造 `X-Forwarded-For: 127.0.0.1` 直取白名单管理接口 |
| `MGO_CORS_ORIGIN` | `*` | `/ws` 与 SSE 的 CORS |


## 快速上手

```bash
# 1. 同机文件 → quantized-mesh 地形
curl -X POST http://127.0.0.1:8080/api/v1/jobs -H 'content-type: application/json' \
  -d '{"type":"terrain","inputPath":"/data/dem.tif","maxLod":8}'

# 2. 上传模型 → 3D Tiles
curl -X POST http://127.0.0.1:8080/api/v1/jobs \
  -F 'options={"type":"tiles","zUp":true,"proj":{"crs":"EPSG:4547"}}' \
  -F file=@roadbed.fbx

# 3. OSGB 目录上传（文件夹选择器）：relPaths 逐文件携带相对路径，服务端重建目录树
curl -X POST http://127.0.0.1:8080/api/v1/jobs \
  -F 'options={"type":"osgb","dirName":"Block_1","relPaths":["Block_1/Data/Tile_1/Tile_1.osgb","Block_1/Data/Tile_1/1_1.jpg"]}' \
  -F 'file=@Block_1/Data/Tile_1/Tile_1.osgb;filename=f_000001' \
  -F 'file=@Block_1/Data/Tile_1/1_1.jpg;filename=f_000002'

# 3. 打开 http://127.0.0.1:8080/ 看进度，点「查看」上地球
```

## Cesium 自托管（离线环境）

```bash
npm i cesium@1.111 --no-save
npm run sync:cesium            # 拷入 public/cesium（viewer.html 自动优先本地）
```

未同步时 viewer.html 自动回退到官方 1.111 CDN。版本必须与 TerrainConverter
的解码器校准版本（1.111）一致；地形产物的几何/规格校验脚本在 MGO 仓库
`Script/Test/*_verify.py`（把 `/ws/{jobId}/out` 目录取下来后作为首参传入即可）。

## IP 白名单访问控制

- **全局门禁**：所有路径（页面 `/`、控制台、查看器、`/api/**`、`/ws/**` 产物）都要求客户端 IP 在白名单内，否则返回 403（浏览器显示提示页）。仅 `health`、`capabilities` 与白名单管理接口豁免。
- **白名单** = 本机 `127.0.0.1`/`::1`（恒允许、不可移除）∪ `MGO_IP_WHITELIST` ∪ `workspace/whitelist.json`；三者每次启动重新合并，互不覆盖。
- **本机管理**：控制台头部「⚙ 白名单设置」→ `/whitelist.html`（或 `GET/POST /api/v1/whitelist`），支持精确 IP 与 CIDR（如 `10.0.0.0/8`），保存即热生效并持久化到 `workspace/whitelist.json`；管理接口仅回环可调，误配不会锁死管理员。
- **客户端 IP 从哪来**：直连取 socket 对端；经本机反向代理时按 `MGO_TRUST_PROXY` 解析 `X-Forwarded-For`。动态出口 IP（家宽重拨换 IP）与改走 IPv6 都会造成「昨天能开、今天 403」——用豁免路径 `GET /api/v1/capabilities` 看服务端实际记录的 `client.ip` 即可定位。
- 排查顺序：`curl <base>/api/v1/health` 不通 → 进程没起 / 端口没监听 / 云安全组没放行；health 200 但页面 403 → IP 不在白名单。

## 部署为常驻服务

```bash
sudo cp deploy/mgo-server.service /etc/systemd/system/
sudo cp deploy/mgo-server.env.example /etc/mgo-server.env     # 按需改 IP / binary / 端口
sudo systemctl daemon-reload && sudo systemctl enable --now mgo-server
journalctl -u mgo-server -f
```

开机自启 + 崩溃自愈（`Restart=always`）+ 配置落盘（`EnvironmentFile`）三者齐备，才不存在
「重启机器后服务失联」。启动日志固定打印 `url / binary / mgo / whitelist / whitelistFile /
envFile / trustProxy`，一眼看出哪层配置没生效；`mgo` 探测失败另有 warn。
nginx 反代务必 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，
并保持 `MGO_TRUST_PROXY=loopback`（默认值）。

## 运维

- **metrics**：`GET /api/v1/metrics` 返回任务统计（总数/按状态/队列深度/运行中）、并发限额、白名单条目数与进程内存（RSS/Heap），供监控探活。
- **mesh 配置 CSV**：任务表单支持上传逐构件简化配置（`-c`，按构件名正则匹配的 OptimizerItemLoader CSV），与 `.prj`/控制点 `.csv` 一样随任务上传、落盘到任务 input 目录。
- **OSGB zip 上传**：osgb 输入区支持直接上传 ZIP 压缩包——服务端用 yauzl 流式解压重建目录树（防解压炸弹：条目数/解压总量上限，路径穿越/绝对路径 422 拒绝），省去逐文件上传。

## 免费在线底图

查看器 HUD「底图影像」可选以下免费源（无需 token，浏览器直连瓦片服务器，
归属标注自动显示在面板底部），默认 Esri 卫星影像：

- 🛰 **卫星影像 (Esri World Imagery)** / 🗺 街道地图 (Esri World Street Map)
- 🧭 **OSM 标准地图** / 🌙 Carto 深色 / ☀️ Carto 浅色 / ⛰ OpenTopoMap
- 可切回「无底图（纯色地球）」

切换即生效并适配地形渲染：有底图时关闭太阳光照（影像自带明暗），无底图时
保留掠射光照以显示地形起伏。URL 可指定 `?basemap=esri_img|osm|none…`。

## 进度协议

服务解析 mgo 子进程 stdout 的英文协议行驱动 SSE 进度（设计 §8）：

```
[<Module>] Progress: <done>/<total>
[<Module>] Done: ...
```

解析失败自动退化为「仅状态」模式，绝不影响任务本身。修改这些输出行时请同步
`src/jobs/progress.js` 与 `test/fixtures/terrain-real.log`（黄金样例）。

## 测试

```bash
npm test                       # 53 项：进度协议 / 参数映射 / 产物发现 / 配置与 .env / e2e（假 mgo）
```

e2e 用 `test/fixtures/fake-mgo.sh` 顶替真实二进制，不依赖 C++ 构建；只需 Node。

前端页面级测试（真实 Chromium 驱动表单/上传/SSE/Cesium 渲染/移动端布局/产品化功能）：

```bash
npm i -D playwright && npx playwright install chromium
npm run fixture:terrain        # 生成 test/fixtures/test_terrain.tif（纯 python3，无 GDAL 依赖）
npm start &                    # 需服务在跑；本机(127.0.0.1)默认在白名单，无需凭证
npm run test:ui                # 25 项 UI 步骤，输出 PASS/FAIL/SKIP 汇总
```

第 9 步复用一例历史 `tiles` 任务渲染真实 3D Tiles；缺该数据（私有回归模型不随仓库分发）时记
SKIP 而非 FAIL。第 25 步会写 `workspace/whitelist.json`，脚本结束时恢复运行前的条目，
因此对着线上实例跑 UI 测试不会把管理员踢出去。

