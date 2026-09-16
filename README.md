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

## 功能特性

- 支持六类任务：模型转 3D Tiles、地形切片、影像切片、GeoJSON 坐标转换、模型简化转格式、OSGB 倾斜摄影（需以 MGO_WITH_OSG 编译）。
- **BIM 属性绑定**：模型切片可开启属性绑定（IFC GUID / FBX·glTF 元数据 / 外部属性表 CSV），构件属性写入每个 b3dm 的 Batch Table；查看器中**点击构件即可查看属性**（高亮选中，可复制 JSON），并可选输出绑定透明度报告 `bim_report.json`（需引擎带 `--bim-*`，启动时自动探测，不支持则界面置灰）。
- **查看器在线地形**：HUD 可一键开关 Re:Earth 全球地形（Mapterhorn DEM + EGM2008，quantized-mesh 0–14 级，免费公开服务、浏览器直连无需代理/Token）；与本地任务地形自动仲裁（本地优先，移除后回落在线），深链 `?terrain=reearth` 直达。
- 坐标系投影支持 EPSG、WKT、+proj、.prj、 7 参数 Helmert、单锚点、多控制点配准。
- 支持 Windows / Linux 双平台，Node.js 服务形态，自带 systemd unit；第三方前端通过 REST API 即可接入。

## 环境要求

| 依赖 | 版本要求 | 说明 |
|------|----------|------|
| Node.js | >= 20 | 运行 MGOServer，服务层唯一直接依赖 |

## 安装

客户机**零构建**：引擎二进制 + 全部 GIS 运行库（含 PROJ 的 proj.db、GDAL 数据）由 `npm ci`
的 postinstall 从预配置地址自动下载安装（`package.json` 的 `mgoEngine.downloads`，可用环境变量覆盖，
见 `.env.example`）。装好 Node 后：

```bash
git clone https://github.com/Johnly1986/MGOServer.git && cd MGOServer
npm ci                # postinstall 自动下载自包含引擎包（引擎+全部 GIS 运行库+proj.db）并校验 sha256
npm run doctor        # 可选：体检引擎/动态库闭包/proj.db/glibc 基线，一条命令定位安装问题
```

引擎二进制不进 git：首次 `npm ci` 从 Release 下载（Linux 98MB / Windows 17MB），之后幂等跳过；
升级用 `npm run engine:update`。

- **离线内网**：`MGO_ENGINE_BUNDLE=/path/to/mgo-engine-<plat>.tgz npm ci`（包由构建机
  `npm run engine:pack` 产出，自包含 proj.db，解压即用）。
- **镜像加速**：`MGO_ENGINE_MIRROR=https://your-proxy/{url}`（或直接改
  `mgoEngine.downloads` 的 url/mirrors）。
- **自管引擎**：设 `MGO_BINARY` 指向已有可执行文件即可，安装器不干预。
- 旧路线仍然可用：把 [MGO](https://github.com/Johnly1986/MGO/releases) 构建产物放进
  `build/bin/linux/` 或 `build/bin/windows/`，并自行
  `sudo apt install libgdal34t64 libproj25 libtiff6 libopenscenegraph161 proj-data gdal-data`
  （Ubuntu 24.04）——自包含引擎包就是为了免掉这一步。

## 快速开始

```bash
npm start                                   # 监听 0.0.0.0:8080
curl http://127.0.0.1:8080/api/v1/health    # 返回 {"status":"ok",…} 即启动成功
```

浏览器打开 `http://127.0.0.1:8080/console.html`

**API 提交**：

```bash
# multipart 上传
curl -F 'options={"type":"terrain"}' -F file=@dem.tif http://127.0.0.1:8080/api/v1/jobs

# tiles 多文件：多个 -F file=…，options 里的转换参数对所有文件统一生效
curl -F 'options={"type":"tiles","proj":{"crs":"EPSG:4526"}}' \
  -F file=@tower.fbx -F file=@podium.obj http://127.0.0.1:8080/api/v1/jobs

# 模型带外部贴图时打包成 ZIP；
# tiles 树上传自动识别全部模型（modelPaths 可选：显式收窄到指定文件）
curl -F 'options={"type":"tiles","modelPaths":["bridge/root.fbx","roadbed/root.fbx"],
              "origin":[498700,2929900,0]}' \
  -F file=@models.zip -F prj=@103d10m.prj http://127.0.0.1:8080/api/v1/jobs

随后 `GET /api/v1/jobs/{id}` 查状态，或 `GET /api/v1/jobs/{id}/events` 订阅 SSE 进度。
```

**离线环境**：

```bash
npm i cesium@1.111 --no-save && npm run sync:cesium
```

同步后查看器自动使用本地自托管 Cesium（未同步时回退官方 CDN），全程零外网。Cesium 版本 1.111+。

**开发自测**：`npm test`（无需构建 C++ 引擎）、
`npm run test:ui`（Chromium 页面级回归）、
`npm run test:bim`（BIM 属性绑定交叉验证：服务端 `buildArgs` 生成的 argv → 真实 MGOConsole → 解码 b3dm Batch Table 核对侧表列与值 → **用真浏览器 + 真 Cesium 的 `parseBatchTable` 逐瓦片验证可解析性**；需带 `--bim-*` 的引擎与真实模型，可用 `--model` 指定）、
`npm run test:b3dm -- <文件或目录>`（单独用 Cesium 的 `parseBatchTable` 体检任意 b3dm 的 Batch Table，自带静态服务，无需先启动服务）、
`npm run dev`（热重载）。

## 📄 许可

[Apache License 2.0](LICENSE)，无论是用于商业用途还是非商业用途都是免费的；
第三方依赖声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

平台支持：MGO 引擎以 MSVC 2022（Windows）与 GCC 9+（Linux）构建验证。
