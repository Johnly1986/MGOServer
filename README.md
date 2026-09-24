<div align="center">

# MGOServer

**3D Tiles 切片服务 · 3D Tiles Tiling Server for CesiumJS**

把 BIM 模型（FBX / OBJ / glTF）、OSGB 倾斜摄影、GeoTIFF DEM / 正射影像一键切片为
CesiumJS 原生流式数据 —— 浏览器上传、在线三维预览，REST API 供第三方前端集成。

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![CI](https://github.com/Johnly1986/MGOServer/actions/workflows/ci.yml/badge.svg)](https://github.com/Johnly1986/MGOServer/actions/workflows/ci.yml)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-brightgreen.svg)](#-快速开始)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-brightgreen.svg)](https://nodejs.org/)

<img width="840" height="449" alt="MGOServer 控制台：上传模型 / OSGB / DEM / 影像并切片，CesiumJS 三维预览" src="https://github.com/user-attachments/assets/4760363e-e7cf-40d5-828e-0a8ececf6488" />

[3D Tiles](https://www.ogc.org/standard/3dtiles/) · [CesiumJS](https://cesium.com/platform/cesiumjs/) · [quantized-mesh](https://github.com/CesiumGS/quantized-mesh) · OSGB · BIM · GIS · Digital Twin

</div>

## 📖 它是什么

MGOServer 是 MGO（C++17 三维切片引擎）的 Node.js HTTP 服务封装；引擎二进制由公开门面仓 [MGO-CLI](https://github.com/Johnly1986/MGO-CLI) 发布：

| 输入 | 输出 |
|------|------|
| FBX / OBJ / glTF 模型、OSGB 倾斜摄影 | **3D Tiles**（b3dm + `tileset.json`） |
| GeoTIFF DEM | **地形瓦片**（quantized-mesh-1.0：`{z}/{x}/{y}.terrain` + 自动生成 `layer.json`） |
| GeoTIFF 正射影像 | **影像瓦片**（Web Mercator TMS + `tilemapresource.xml`） |
| 投影坐标 GeoJSON | 坐标转换后的 GeoJSON |

支持六类任务：模型转 3D Tiles、地形切片、影像切片、GeoJSON 坐标转换、模型简化转格式、OSGB 倾斜摄影（需 `MGO_WITH_OSG` 编译的引擎）。

## ✨ 核心特性

- 🔗 **BIM 属性绑定** — IFC GUID / FBX·glTF 元数据 / 外部属性表 CSV 写入每个 b3dm 的 Batch Table；查看器点击构件即高亮并查看属性（可复制 JSON），可选输出绑定报告 `bim_report.json`。
- 🗺️ **完整坐标投影** — EPSG / WKT / +proj / .prj / 七参数 Helmert / 单锚点 / 多控制点配准。
- 🖥️ **双平台易部署** — Windows / Linux；自带 systemd unit，第三方前端经 REST API 即可接入。

## 🚀 快速开始

> 依赖：**Node.js ≥ 20**。

```bash
git clone https://github.com/Johnly1986/MGOServer.git && cd MGOServer
npm ci              # postinstall 自动下载引擎包（Linux ~98MB / Windows ~17MB），幂等可重复
npm run doctor      # 可选：一键体检引擎 / 动态库闭包 / proj.db / glibc 基线
npm start           # 监听 0.0.0.0:8080
```

打开 **<http://127.0.0.1:8080/console.html>** 即可上传切片、三维预览。

REST API 提交：

```bash
# 地形切片：上传 DEM
curl -F 'options={"type":"terrain"}' -F file=@dem.tif http://127.0.0.1:8080/api/v1/jobs

# 模型转 3D Tiles：多文件上传，options 参数对所有文件统一生效；带外部贴图时打包 ZIP 上传
curl -F 'options={"type":"tiles","proj":{"crs":"EPSG:4526"}}' -F file=@tower.fbx -F file=@podium.obj http://127.0.0.1:8080/api/v1/jobs
```

| 端点 | 说明 |
|------|------|
| `GET /api/v1/health` | 健康检查 |
| `GET /api/v1/jobs/{id}` | 查询任务状态 |
| `GET /api/v1/jobs/{id}/events` | SSE 实时进度 |

<details>
<summary><b>离线内网 / 镜像加速 / 自管引擎</b></summary>

| 场景 | 做法 |
|------|------|
| 离线内网 | `MGO_ENGINE_BUNDLE=/path/to/mgo-engine-<plat>.tgz npm ci`（包由构建机 `npm run engine:pack` 产出，自包含 proj.db） |
| 镜像加速 | `MGO_ENGINE_MIRROR=https://your-proxy/{url}`，或直接改 `package.json` 的 `mgoEngine.downloads` |
| 自管引擎 | 设 `MGO_BINARY` 指向已有可执行文件，安装器不干预 |
| 传统路线 | 将 [MGO-CLI Releases](https://github.com/Johnly1986/MGO-CLI/releases) 产物放入 `build/bin/{linux,windows}/`；Ubuntu 24.04 需 `sudo apt install libgdal34t64 libproj25 libtiff6 libopenscenegraph161 proj-data gdal-data` |

全部环境变量见 [`.env.example`](.env.example)；升级引擎用 `npm run engine:update`。

</details>

## 🧪 开发与测试

```bash
npm run dev                          # 热重载开发
npm test                             # 单元测试（无需构建 C++ 引擎）
npm run test:ui                      # Chromium 页面级回归
npm run test:bim                     # BIM 属性绑定交叉验证（服务端 → MGOConsole → 真 Cesium parseBatchTable 逐瓦片验证）
npm run test:b3dm -- <文件或目录>     # 体检任意 b3dm 的 Batch Table，自带静态服务，无需启动主服务
```

<details>
<summary><b>离线 Cesium 自托管</b></summary>

```bash
npm i cesium@1.111 --no-save && npm run sync:cesium
```

同步后查看器自动使用本地自托管 Cesium（未同步时回退官方 CDN），全程零外网。支持 Cesium 1.111+。

</details>

## 📄 许可

[Apache-2.0](LICENSE)（商业与非商业用途均免费），第三方依赖声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
引擎构建验证：MSVC 2022（Windows）、GCC 9+（Linux）。

