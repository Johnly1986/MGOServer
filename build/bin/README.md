# 引擎二进制目录

本目录内容**不进 git**——引擎由安装器在 `npm ci` 时从预配置地址自动下载就位
（`scripts/setup.mjs`，清单见 `package.json` 的 `mgoEngine.downloads`）：

- `linux/`   — Linux 探测目标：`MGOConsole` + 全部依赖闭包（RUNPATH `$ORIGIN`）
              + `share/proj/`（proj.db）→ 自包含，零系统 GIS 依赖（glibc 基线除外）
- `windows/` — Windows 探测目标：`MGOConsole.exe` + DLL + `proj.db` + `gdaldata/`

服务启动按当前系统探测本目录（`src/config.js` 的 `findMgoBinary`）；
其他位置的引擎用环境变量 `MGO_BINARY` 指定绝对路径（设了就不下载）。

## 常用操作

```bash
npm ci                 # postinstall 自动下载安装（幂等：已装则跳过）
npm run engine:update  # --force 重新下载（清空本目录后装新版本，防新旧混装）
npm run doctor         # 体检：引擎/动态库闭包/proj.db/glibc 基线
```

- **离线内网**：`MGO_ENGINE_BUNDLE=/path/to/bundle.tgz npm ci`（先在联网机
  `npm run engine:pack` 产出，或直接下载 Release 资产）。
- **镜像加速**：`MGO_ENGINE_URL` / `MGO_ENGINE_MIRROR`，见 `.env.example`。

## 引擎包布局（平铺在平台目录下）

```
MGOConsole[.exe]      引擎本体（RUNPATH $ORIGIN）
*.so / *.dll          引擎侧车 + 全部 GIS 依赖闭包（libgdal/libproj/libtiff/libosg*/…）
share/proj/proj.db    PROJ 坐标数据库 → spawn 时注入 PROJ_DATA（src/engine-env.js）
share/gdal/ 或 gdaldata/   GDAL 数据 → 注入 GDAL_DATA（布局二选一，都能识别）
manifest.json         自包含包才有：{version, platform, arch, glibc, files{sha256}}
```

Linux 包另需 glibc 基线匹配 + `libstdc++6`（所有发行版自带）；`npm run doctor` 逐项体检。
