# MGOServer

> 带网页界面的 3D Tiles 切片工具：把 MGO C++ 转换引擎包装成 HTTP 服务，浏览器提交模型 / DEM / 影像 / OSGB，返回 Cesium 原生流式瓦片并一键预览。

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey.svg)](#)
[![Test](https://github.com/Johnly1986/MGOServer/actions/workflows/ci.yml/badge.svg)](https://github.com/Johnly1986/MGOServer/actions/workflows/ci.yml)

## 📖 项目简介

本项目将工程测绘类数据——FBX/OBJ 等三维模型、GeoTIFF DEM / 正射影像、投影坐标 GeoJSON、
OSGB 倾斜摄影——处理为 CesiumJS 可直接加载的切片数据，支持三种输出：

- **3D Tiles**（b3dm + `tileset.json`），模型与 OSGB 实景三维；
- **地形**（quantized-mesh-1.0，`{z}/{x}/{y}.terrain` + 自动生成的 `layer.json`）；
- **影像**（Web Mercator TMS 瓦片 + `tilemapresource.xml`）。

切片计算由 [MGO](https://github.com/Johnly1986/MGO) C++17 引擎完成，MGOServer 在其上补齐了
使用闭环：网页任务控制台提交、SSE 实时进度、内置 CesiumJS 查看器预览、成果自动托管
（`/ws/{jobId}/out/**`，正确 MIME + immutable 缓存 + CORS）。成果目录也可整体拷走，交给
Nginx 等任意 Web 服务器发布。

主要解决**内网离线部署、数据不出本机、不依赖 Cesium ion 云服务**场景下的本地切片需求：
全链路（含 Cesium 前端库）可自托管，无账号、无授权验证、无遥测。

## ✨ 功能特性

- ✅ 六类任务：模型转 3D Tiles（`tiles`）、地形切片（`terrain`）、影像切片（`image`）、
  GeoJSON 坐标转换（`geojson`）、模型简化转格式（`mesh`）、OSGB 倾斜摄影（`osgb`，
  需引擎以 `MGO_WITH_OSG` 编译）
- ✅ 输入覆盖 FBX / OBJ / glTF / glb / DAE / 3DS / PLY / STL、GeoTIFF、OSGB 目录或 ZIP；
  输出自带 `tileset.json` / `layer.json` / `tilemapresource.xml` 描述文件，Cesium URL 直接加载
- ✅ 切片跑在原生 C++ 进程，terrain 出瓦多线程并行；简化基于扩展版 meshoptimizer，
  锁定瓦片边界不留缝；服务层任务排队限流、可取消、超时兜底、成果按 TTL 自动清理
- ✅ 坐标系引擎侧闭环：EPSG / WKT / `+proj` / `.prj` 定义投影，7 参数 Helmert、单锚点、
  多控制点最小二乘配准（可自动探测源投影），大场景逐顶点重投影消除切面残差；
  三维转地心坐标、二维转经纬度，前端零补偿
- ✅ 网页拖拽提交，SSE 逐瓦片粒度推进度、断线续传；GB 级数据可免上传直读服务器本地路径
- ✅ IP 白名单控制写操作，读接口开放给消费端页面
- ✅ Windows / Linux 双平台，Node.js 服务形态，自带 systemd unit；第三方前端只需调 REST API

## 🔧 环境要求

| 依赖 | 版本要求 | 说明 |
|------|----------|------|
| Node.js | >= 20 | 运行 MGOServer，服务层唯一直接依赖 |
| MGO 可执行文件 | v1.0.0 | **仓库已内置** Linux x86-64 预编译版（`build/bin/`，含引擎自带 `.so`，RUNPATH 已指向 `$ORIGIN`），clone 即用；Windows 等其他平台自行构建后放入 `build/bin/`，或用 `MGO_BINARY` 指路 |
| 系统 GIS 运行库 | Ubuntu 24.04 apt | 内置二进制所需的动态库，一条命令装齐：`sudo apt install libgdal34t64 libproj25 libtiff6 libopenscenegraph161 proj-data gdal-data` |
| CMake、C++17 编译器、vcpkg | >= 3.18；GCC 9+ / MSVC 2022 | 仅自行构建 MGO 引擎时需要；Assimp、Boost 等由 vcpkg 自动安装 |

## 📦 安装

Linux x86-64 开箱即用——引擎二进制已随仓库提供，装好 Node 和一组运行库即可：

```bash
git clone https://github.com/Johnly1986/MGOServer.git && cd MGOServer
npm ci
sudo apt install libgdal34t64 libproj25 libtiff6 libopenscenegraph161 proj-data gdal-data
```

**自行构建引擎**（内置的只有 Linux x86-64；Windows / macOS 或其他发行版需要自己出一份）：

```bash
git clone https://github.com/Johnly1986/MGO.git ../MGO
cd ../MGO
make release        # Linux / macOS
# Windows（PowerShell）：
#   cmake -B build -A x64 -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake
#   cmake --build build --config Release
```

构建产物（`MGOConsole` / `MGOConsole.exe` 及其依赖的 `.so` / `.dll`）放进本仓库 `build/bin/`
即可被自动发现，放别处则用 `MGO_BINARY` 指定。

## 🚀 快速开始

```bash
npm start                                   # 监听 0.0.0.0:8080
curl http://127.0.0.1:8080/api/v1/health    # 返回 {"status":"ok",…} 即启动成功
```

浏览器打开 `http://127.0.0.1:8080/console.html`：选任务类型 → 拖入文件 → 「提交任务」→
进度走完点「打开查看器」，成果渲染在地球上。成果直链形如
`http://<host>:8080/ws/<jobId>/out/tileset.json`，可给自己页面的 `Cesium.Cesium3DTileset.fromUrl` 直接使用。

**API 提交**（不用网页时）：

```bash
# multipart 上传
curl -F 'options={"type":"terrain"}' -F file=@dem.tif http://127.0.0.1:8080/api/v1/jobs

# 或引用服务器本地文件（需 MGO_ALLOW_LOCAL_PATH=1）
curl -H 'Content-Type: application/json' \
  -d '{"type":"tiles","inputPath":"/data/city.fbx","proj":{"crs":"EPSG:4526"}}' \
  http://127.0.0.1:8080/api/v1/jobs
```

随后 `GET /api/v1/jobs/{id}` 查状态，或 `GET /api/v1/jobs/{id}/events` 订阅 SSE 进度。
任务参数全集（配准、简化细分项）见 [docs/VISUALIZATION_SERVICE_DESIGN.md](docs/VISUALIZATION_SERVICE_DESIGN.md) 附录 A。

**访问控制**：写操作（POST / DELETE）要求客户端 IP 在白名单内，本机 `127.0.0.1` / `::1` 恒放行；
读接口不设限。要让外部电脑能提交：在服务器本机打开 `whitelist.html` 加入自己的 IP 并保存，
立即生效，持久化到 `workspace/whitelist.json`，重启不丢。

**配置**：全部有内置默认值，`cp .env.example .env` 覆盖，常用项：

| 变量 | 默认 | 用途 |
|------|------|------|
| `MGO_HOST` / `MGO_PORT` | `0.0.0.0` / `8080` | 监听地址 |
| `MGO_BINARY` | 自动探测 | MGO 可执行文件路径；默认顺序：本仓库 `build/bin/`（内置）→ 同级 `../MGO/build/bin/` → PATH |
| `MGO_IP_WHITELIST` | `127.0.0.1`,`::1` | 启动兜底白名单，支持 CIDR |
| `MGO_MAX_CONCURRENT_JOBS` | `1` | 并发任务数（terrain 内部已并行，谨慎调大） |
| `MGO_TTL_DAYS` | `7` | 成果保留天数 |

真实环境变量优先于 `.env` 文件，键位全集见 [.env.example](.env.example)。

**常驻运行（Linux systemd）**：

```bash
sudo cp deploy/mgo-server.service /etc/systemd/system/
sudo cp deploy/mgo-server.env.example /etc/mgo-server.env   # 按需改 IP / binary / 端口
sudo systemctl daemon-reload && sudo systemctl enable --now mgo-server
```

开机自启、崩溃自动拉起。部署完可跑一次 `scripts/verify-deployment.sh`（临时 workspace 起服务
逐项断言，生产实例上跑也安全）。走 Nginx 反代时部署在同机、透传 `X-Forwarded-For`，
保持 `MGO_TRUST_PROXY=loopback`，不要设 `true`（可被伪造绕过白名单）。

**离线环境**：

```bash
npm i cesium@1.111 --no-save && npm run sync:cesium
```

同步后查看器自动使用本地自托管 Cesium（未同步时回退官方 CDN），全程零外网。版本必须锁 1.111，
地形输出的解码行为照它校准。

**开发自测**：`npm test`（桩二进制驱动真实任务管线，无需构建 C++ 引擎）、
`npm run test:ui`（Chromium 页面级回归）、`npm run dev`（热重载）。

## 📄 许可

Apache-2.0，免费、可商用、可闭源集成，无授权验证、无功能限制；第三方依赖声明见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。服务无遥测，除 Cesium CDN（可自托管）外
不访问外部网络，数据全程留在自己的服务器上。

平台支持：MGO 引擎以 MSVC 2022（Windows）与 GCC 9+（Linux）构建验证，测绘行业常见的
Windows Server 与机房 Linux 均可运行；内置的预编译引擎为 Ubuntu 24.04 / x86-64 构建，
Windows 按上文自行构建一份放入 `build/bin/` 即可。macOS 走同一套 vcpkg 流程理论可用，
未持续验证。服务层 CI 覆盖 Node 20 / 22。
