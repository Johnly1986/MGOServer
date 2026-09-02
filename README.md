# MGOServer

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey.svg)](#)
[![Test](https://github.com/Johnly1986/MGOServer/actions/workflows/ci.yml/badge.svg)](https://github.com/Johnly1986/MGOServer/actions/workflows/ci.yml)

>  3D Tiles 切片工具：基于 MGO C++ 转换引擎包装成 HTTP 服务，浏览器提交模型 / DEM / 影像 / OSGB，返回 Cesium 原生流式瓦片并一键预览。

<img width="1854" height="993" alt="image" src="https://github.com/user-attachments/assets/f8bd158d-91ac-4415-8690-a41cb639a65e" />

## 📖 项目简介

本项目将BIM数据——FBX/OBJ 等三维模型、GeoTIFF DEM / 正射影像、投影坐标 GeoJSON、
OSGB 倾斜摄影——处理为 CesiumJS 可直接加载的切片数据，支持三种输出：

- **3D Tiles**（b3dm + `tileset.json`），模型与 OSGB 实景三维；
- **地形**（quantized-mesh-1.0，`{z}/{x}/{y}.terrain` + 自动生成的 `layer.json`）；
- **影像**（Web Mercator TMS 瓦片 + `tilemapresource.xml`）。

切片计算由 [MGO](https://github.com/Johnly1986/MGO) C++17 引擎完成。

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
- ✅ Windows / Linux 双平台，Node.js 服务形态，自带 systemd unit；第三方前端只需调 REST API

## 🔧 环境要求

| 依赖 | 版本要求 | 说明 |
|------|----------|------|
| Node.js | >= 20 | 运行 MGOServer，服务层唯一直接依赖 |
| MGO 可执行文件 | v0.7.0 | **仓库已内置** Linux x86-64 预编译版（`build/bin/linux/`，含引擎自带 `.so`，RUNPATH 指向 `$ORIGIN`，整目录可随意搬动），clone 即用；探测按系统选目录：Windows 查 `build/bin/windows/`，Linux 查 `build/bin/linux/` |
| 系统 GIS 运行库 | Ubuntu 24.04 apt | 内置二进制所需的动态库：`sudo apt install libgdal34t64 libproj25 libtiff6 libopenscenegraph161 proj-data gdal-data` |

## 📦 安装

Linux x86-64 开箱即用——引擎二进制已随仓库提供，装好 Node 和一组运行库即可：

```bash
git clone https://github.com/Johnly1986/MGOServer.git && cd MGOServer
npm ci
sudo apt install libgdal34t64 libproj25 libtiff6 libopenscenegraph161 proj-data gdal-data
```

构建产物（`MGOConsole` 及其 `.so`，或 `MGOConsole.exe` 及其 `.dll`）按系统放进本仓库
`build/bin/linux/` 或 `build/bin/windows/` 即可被自动发现，放别处则用 `MGO_BINARY` 指定。

## 🚀 快速开始

```bash
npm start                                   # 监听 0.0.0.0:8080
curl http://127.0.0.1:8080/api/v1/health    # 返回 {"status":"ok",…} 即启动成功
```

浏览器打开 `http://127.0.0.1:8080/console.html`：选任务类型 → 拖入文件 → 「提交任务」→
进度走完点「打开查看器」，成果渲染在地球上。

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
| `MGO_BINARY` | 自动探测 | MGO 可执行文件路径；默认顺序：本仓库 `build/bin/linux/` 或 `build/bin/windows/` |
| `MGO_TTL_DAYS` | `7` | 成果保留天数 |

真实环境变量优先于 `.env` 文件，键位全集见 [.env.example](.env.example)。

**常驻运行（Linux systemd）**：

```bash
sudo cp deploy/mgo-server.service /etc/systemd/system/
sudo cp deploy/mgo-server.env.example /etc/mgo-server.env   # 按需改 IP / binary / 端口
sudo systemctl daemon-reload && sudo systemctl enable --now mgo-server
```

**离线环境**：

```bash
npm i cesium@1.111 --no-save && npm run sync:cesium
```

同步后查看器自动使用本地自托管 Cesium（未同步时回退官方 CDN），全程零外网。Cesium 版本 1.111+。

**开发自测**：`npm test`（桩二进制驱动真实任务管线，无需构建 C++ 引擎）、
`npm run test:ui`（Chromium 页面级回归）、`npm run dev`（热重载）。

## 📄 许可

Apache-2.0，免费、可商用、可闭源集成，无授权验证、无功能限制；第三方依赖声明见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

平台支持：MGO 引擎以 MSVC 2022（Windows）与 GCC 9+（Linux）构建验证。
