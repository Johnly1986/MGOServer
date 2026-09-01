# MGOServer

[![Test](https://github.com/Johnly1986/MGOServer/actions/workflows/ci.yml/badge.svg)](https://github.com/Johnly1986/MGOServer/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

带网页界面的 3D Tiles 切片工具，把 [MGO](https://github.com/Johnly1986/MGO) C++ 转换引擎包装成 HTTP 服务。
在浏览器里提交数据（模型、DEM、正射影像、GeoJSON、OSGB 倾斜摄影），服务端调用 MGO 将其切成果
Cesium 可直接流式加载的 3D Tiles、quantized-mesh 地形、TMS 影像瓦片，托管成果并自带查看器预览。
面向不想装命令行、记参数的使用者；第三方前端只用 API 和成果 URL 即可接入。

## 任务类型

| 类型 | 输入 | 输出 |
|------|------|------|
| `tiles` | FBX / OBJ / glTF / glb / DAE / 3DS / PLY / STL | 3D Tiles（b3dm + `tileset.json`） |
| `terrain` | GeoTIFF DEM | quantized-mesh-1.0 地形瓦片（含 `layer.json` 与法线） |
| `image` | GeoTIFF 正射影像 | Web Mercator TMS 影像瓦片（含 `tilemapresource.xml`） |
| `geojson` | 投影坐标 GeoJSON | 经纬度 GeoJSON（EPSG:4326） |
| `mesh` | 同 `tiles` | 简化后的 `.glb/.gltf/.obj/.fbx/.ply` |
| `osgb` | OSGB 目录或 ZIP（引擎需编译 OSG 支持） | 3D Tiles |

投影和坐标系统一在 C++ 侧处理：投影接受 EPSG / WKT / `+proj` 串或 `.prj` 文件；配准支持
7 参数 Helmert、单锚点、多控制点最小二乘拟合（可自动探测源投影），大场景另有逐顶点重投影
消除切面残差。三维成果转地心坐标、二维转经纬度，前端直接加载，不需要也不允许再做轴向补偿。

## 效率

- 转换本身全在 MGO 原生进程里跑，Node 只负责调度、解析 stdout 进度和静态托管，不经手数据。
- terrain 出瓦在 C++ 侧已是多线程；简化用扩展版 meshoptimizer，锁定瓦片边界，不留缝。
- 输出即最终格式，落地后不再转码。静态响应按 b3dm / terrain 给正确 MIME，带 immutable 缓存和
  CORS，浏览器与 Cesium 直接可用。
- 大文件可以不上传：开 `MGO_ALLOW_LOCAL_PATH`，数据放服务器上，提交任务时 JSON 里给绝对路径。
- 进度走 SSE 推，逐瓦片粒度，断线用 `Last-Event-ID` 续传，没有轮询。
- 默认单任务排队（`MGO_MAX_CONCURRENT_JOBS=1`），超时 4 小时兜底，成果按 TTL（默认 7 天）
  自动清理，磁盘不用人盯。

## 环境要求

- Node.js ≥ 20
- MGO 可执行文件。依次探测同级目录 `../MGO/build/bin/MGOConsole`、本仓库 `build/bin/`、
  PATH 上的 `mgo`；路径不同时用 `MGO_BINARY` 指定绝对路径。引擎构建：

  ```bash
  git clone https://github.com/Johnly1986/MGO.git ../MGO
  cd ../MGO && make release        # Windows: cmake -B build -A x64 …，再 --config Release
  ```

## 快速开始

```bash
git clone https://github.com/Johnly1986/MGOServer.git && cd MGOServer
npm ci
npm start                          # 监听 0.0.0.0:8080
```

```bash
curl http://127.0.0.1:8080/api/v1/health    # 返回 {"status":"ok",…} 即启动成功
```

浏览器打开 `http://127.0.0.1:8080/console.html`，选任务类型、拖入文件、点「提交任务」，
进度条走完点「打开查看器」，成果直接渲染在地球上。

## 页面与 API

三个页面：`/console.html` 任务控制台，`/viewer.html` 成果查看器（CesiumJS），
`/whitelist.html` IP 白名单管理。

API 在 `/api/v1` 下，常用这些：

```
POST   /api/v1/jobs                  提交任务（multipart 上传，或 JSON + inputPath 读服务器本地文件）
GET    /api/v1/jobs/{id}             任务状态
GET    /api/v1/jobs/{id}/events      SSE 进度流
POST   /api/v1/jobs/{id}/cancel      取消
GET    /api/v1/jobs/{id}/artifacts   成果清单与查看器链接
GET    /api/v1/capabilities          能力探测（引擎是否编译了 osgb 等）
GET    /ws/{jobId}/out/**            成果直链（CORS），如 /ws/<id>/out/tileset.json
```

各任务参数（投影、配准、简化细分项）见 [docs/VISUALIZATION_SERVICE_DESIGN.md](docs/VISUALIZATION_SERVICE_DESIGN.md)
附录 A。

## 访问控制

写操作（POST / DELETE）要求客户端 IP 在白名单内，名单外一律 403；读接口不设限，成果链接可以直接
给消费端页面用。本机 `127.0.0.1` / `::1` 恒放行。要让外部电脑能提交：先在服务器本机打开
`whitelist.html` 把自己的 IP 加入并保存，立即生效，持久化在 `workspace/whitelist.json`，重启不丢。

## 配置

全部配置均有内置默认值，开箱即用。需覆盖时 `cp .env.example .env` 编辑，或直接设环境变量
（真实环境变量优先于 `.env`，三种启动路径行为一致），键位全集见 [.env.example](.env.example)。
常用几个：

| 变量 | 默认 | 用途 |
|------|------|------|
| `MGO_HOST` / `MGO_PORT` | `0.0.0.0` / `8080` | 监听地址 |
| `MGO_BINARY` | 自动探测 | MGO 可执行文件路径 |
| `MGO_IP_WHITELIST` | `127.0.0.1`,`::1` | 启动兜底白名单，逗号分隔，支持 CIDR |
| `MGO_TRUST_PROXY` | `loopback` | 允许哪个对端用 `X-Forwarded-For` 改写客户端 IP |
| `MGO_MAX_CONCURRENT_JOBS` | `1` | 并发任务数（terrain 内部已并行，谨慎调大） |
| `MGO_TTL_DAYS` | `7` | 成果保留天数 |

走 nginx 等反向代理时：反代部署在同机并透传 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，
保持 `MGO_TRUST_PROXY=loopback`。不要设成 `true`，否则任何人都能伪造 `X-Forwarded-For: 127.0.0.1`
绕过白名单。

## 常驻运行（systemd）

```bash
sudo cp deploy/mgo-server.service /etc/systemd/system/
sudo cp deploy/mgo-server.env.example /etc/mgo-server.env    # 按需改 IP / binary / 端口
sudo systemctl daemon-reload && sudo systemctl enable --now mgo-server
journalctl -u mgo-server -f
```

开机自启、崩溃 3 秒后自动拉起，unit 自带 NoNewPrivileges / ProtectSystem 等加固。启动日志会打印
生效的 url / binary / whitelist / trustProxy，便于核对配置。部署完可跑一次
`scripts/verify-deployment.sh`：用临时 workspace 另起一份服务逐项断言，生产实例上跑也安全。

## 离线环境

`viewer.html` 默认引用官方 CDN 的 Cesium。纯内网环境先自托管一份：

```bash
npm i cesium@1.111 --no-save && npm run sync:cesium
```

同步后页面自动改用本地副本，全程不碰外网。版本必须锁 1.111，地形输出的解码行为是照它校准的。

## 许可与平台

Apache-2.0，免费，可商用，无授权验证、无功能限制。服务无遥测，除 Cesium CDN（可自托管）外
不访问外部网络，数据全程留在你自己的服务器上，可以跑在物理隔离内网。

Windows 与 Linux 双平台：MGO 引擎以 MSVC 2022 和 GCC 9+ 构建验证过，测绘行业常见的 Windows
Server 和机房 Linux 都能跑；Node 服务层本身跨平台，macOS 走同一套 vcpkg 流程理论可用，未持续
验证。服务层 CI 在 Node 20 / 22 双版本跑全量测试。

## 开发

```bash
npm test          # 单元 + 端到端：桩二进制驱动真实任务管线，不需要构建 C++ 引擎
npm run test:ui   # Chromium 页面级回归
npm run dev       # 热重载
```

设计依据见 [docs/VISUALIZATION_SERVICE_DESIGN.md](docs/VISUALIZATION_SERVICE_DESIGN.md)，
第三方依赖声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
