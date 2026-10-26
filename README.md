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

- **BIM 属性绑定** — IFC GUID / FBX·glTF 元数据 / 外部属性表 CSV 绑定；构建属性表导出。
- **完整坐标投影** — EPSG / WKT / +proj / .prj / 七参数 Helmert / 单锚点 / 多控制点配准。
- **模型轻量化** — 模型 / 地形 / 倾斜摄影 轻量化。
- **双平台易部署** — Windows / Linux；自带 systemd unit，第三方前端经 REST API 即可接入。

## 🚀 快速开始

> 依赖：**Node.js ≥ 20**。

```bash
git clone https://github.com/Johnly1986/MGOServer.git && cd MGOServer
npm ci              # postinstall 自动下载引擎包（Linux ~98MB / Windows ~27MB），幂等可重复
npm run doctor      # 可选：一键体检引擎 / 动态库闭包 / proj.db / glibc 基线 / 上游是否有新引擎
npm start           # 监听 0.0.0.0:8080
```

> `npm ci` 装的是 `package.json` 里**固定版本 + sha256** 的引擎（可复现、可离线、装机结果可预期）。
> 想直接拿 MGO-CLI 最新 Release：`npm run engine:update -- --latest`——它会查一次 GitHub API，
> 取对应平台资产并用该资产自带的 sha256 digest 校验；查询失败（离线 / API 限流 / 该平台无资产）
> 会告警并自动回退到固定版本，不会让安装失败。

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
| 升级到最新 | `npm run engine:update -- --latest`：取 [MGO-CLI 最新 Release](https://github.com/Johnly1986/MGO-CLI/releases/latest) 的对应平台资产，用 release asset 自带 digest 校验；查询失败自动回退到固定版本。GitHub API 未认证限额 60 次/小时/IP，提额用 `GITHUB_TOKEN=xxx npm run engine:update -- --latest` |
| 镜像加速 | `package.json mgoEngine.downloads.*.mirrors` 已内置（`{url}` 模板，跨版本有效）；临时换/加用 `MGO_ENGINE_MIRROR=https://your-proxy/{url}` |
| 自管引擎 | 设 `MGO_BINARY` 指向已有可执行文件，安装器不干预 |
| 传统路线 | 将 [MGO-CLI Releases](https://github.com/Johnly1986/MGO-CLI/releases) 产物放入 `build/bin/{linux,windows}/`；Ubuntu 24.04 需 `sudo apt install libgdal34t64 libproj25 libtiff6 libopenscenegraph161 proj-data gdal-data` |

全部环境变量见 [`.env.example`](.env.example)（安装器读的是进程环境变量，`.env` 只影响服务进程）；升级引擎用 `npm run engine:update`，或加 `-- --latest` 追新。

</details>

<details>
<summary><b>安装 / 更新引擎报错？先看这里</b></summary>

安装器（`postinstall` 与 `npm run engine:update`）只做四件事：**按预配置地址下载 → sha256 校验 →
解压到 `build/bin/<platform>/` → probe 自检**。出现 `fetch failed` 说明本机到下载地址（GitHub
Release 资产或镜像）不通，引擎本身没有问题——同一份资产在联网机器上 `sha256` 是能对上的。

**1）先确认命令**。npm 的子命令必须带 `run`：

```bash
npm run engine:update              # 重新安装固定版本（= setup.mjs --force）
npm run engine:update -- --latest  # 追 MGO-CLI 最新 Release（查询失败自动回退固定版本）
```

`npm engine:update` 会被 npm 当成未知命令（提示 `Did you mean … npm run engine:update`），
不会执行任何安装动作。

**2）下载失败**（`fetch failed` / 连接重置 / 超时）。按成本从低到高：

- **镜像兜底（推荐，先重跑）**：`package.json` 的 `mgoEngine.downloads.*.mirrors` 已内置国内可达的
  GitHub 加速镜像，直连失败会自动改用镜像重试，无需任何配置。也可自己指定（`{url}` 会替换成真实下载地址）：

  ```powershell
  # Windows PowerShell
  $env:MGO_ENGINE_MIRROR="https://ghproxy.net/{url}"; npm run engine:update
  ```

  ```bash
  # Linux / macOS
  MGO_ENGINE_MIRROR='https://ghproxy.net/{url}' npm run engine:update
  ```

- **离线包（镜像也不通时最可靠）**：在任意能上外网的机器/浏览器下载对应平台的 Release 资产，
  拷到目标机后用 `MGO_ENGINE_BUNDLE` 指过去（离线包优先于任何网络地址）：

  ```powershell
  $env:MGO_ENGINE_BUNDLE="D:\downloads\MGO-0.9.5-win-x64.zip"; npm run engine:update
  ```

  ```bash
  MGO_ENGINE_BUNDLE=/data/MGO-0.9.5-linux-x64.tar.gz npm ci
  ```

  资产地址与 sha256 见 `package.json`（当前 win-x64 `41ceb3af…472e`、linux-x64 `c1b85dca…3f4a`），
  下载后可用 `certutil -hashfile … SHA256` / `sha256sum` 核对。

- **代理**：Node 内置 `fetch` 默认**不读** `HTTPS_PROXY`，需显式开启（Node ≥ 22.21）：
  `$env:NODE_USE_ENV_PROXY=1; npm run engine:update`，或 `node --use-env-proxy scripts/setup.mjs --force`。
  公司网络做 HTTPS 中间人时，把根证书指给 Node：`$env:NODE_EXTRA_CA_CERTS="D:\corp-root.pem"`。

失败信息现在会打印**真实原因**（`ENOTFOUND` / `ECONNRESET` / 证书错误…）并给出对应修法；
装好后跑 `npm run doctor` 复检。

**3）下载成功但 probe FAILED**。Windows 包自带引擎自身的 DLL，但 **不带 MSVC 运行库**
（`VCRUNTIME140.dll` / `VCRUNTIME140_1.dll` / `MSVCP140.dll` 由系统提供）。若目标机没装过
VC++ 2015-2022 运行库，装一下 [vc_redist.x64.exe](https://aka.ms/vs/17/release/vc_redist.x64.exe)
后重跑 `npm run doctor`。Linux 侧对应的是 glibc 基线（低于构建基线请换发行版或用 Docker）。

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

