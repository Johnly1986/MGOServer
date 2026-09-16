# 安装体验统一化设计：npm 生命周期作为多平台唯一入口

> 目标一句话：用户在任意平台只执行 `git clone → npm ci → npm start`，
> 引擎、GIS 运行库（含 proj.db）全部由 Node 侧安装器自动就位；`npm run doctor` 一条命令诊断一切。

> **已定决策（v1 落地）**：客户机**零构建**——安装器只做"按预配置地址下载 → sha256 校验 →
> 解压 → probe 自检"，绝不在客户端编译。预配置地址清单在 `package.json mgoEngine.downloads`
> （url + mirrors + sha256），环境变量 `MGO_ENGINE_URL / MGO_ENGINE_MIRROR / MGO_ENGINE_BUNDLE`
> 覆盖。已实现：`scripts/setup.mjs`（postinstall）、`scripts/doctor.mjs`、`scripts/pack-engine.mjs`
> （构建机打包）、`src/engine-env.js`（PROJ_DATA/GDAL_DATA 注入），端到端验证记录见 §11。

## 1. 现状差距（为什么现在不算开箱即用）

| 痛点 | 根因 | 现状表现 |
|------|------|----------|
| Linux 需手动 apt 装 GIS 库 | 引擎动态链接 `libgdal.so.34 / libproj.so.25 / libgeotiff.so.5 / libtiff.so.6 / libosg*.so.161 / libOpenThreads.so.21`，且 proj.db、GDAL 数据依赖系统包 `proj-data`、`gdal-data` | 漏装则引擎起不来或 EPSG/WKT 解析失败；仅 Ubuntu 24.04 的包名可用 |
| Windows 完全不可用 | `build/bin/windows/` 为空，要求用户自建 MSVC 工程 | README 的"Windows 开箱即用"名不副实 |
| 失败不直观 | 库缺失发生在 spawn 期/转换期 | 启动日志有 warn（`src/server.js:141`），但用户需要懂日志 |
| 安装动作分散 | Node 一条命令、apt 一条命令、引擎手动放置 | 三套入口，无统一自检 |

关键判断：**两个根治手段指向同一个载体**——
1. 系统 GIS 库问题 ≠ 写脚本去 sudo apt（发行版差异 + CI 无 sudo + 版本漂移），而是把库和数据**随引擎一起打包**（自包含引擎包，运行时注入 `PROJ_DATA` / `GDAL_DATA`）；
2. Windows 引擎问题 ≠ 写安装器凭空变出二进制，而是**CI 产出平台包**。

因此方案核心是：**平台化引擎分发包 + npm 生命周期安装器 + doctor 诊断**。

## 2. 方案空间对比

| 方案 | 思路 | 优点 | 缺点 | 结论 |
|------|------|------|------|------|
| **A. postinstall 下载 + 自包含引擎包**（推荐 v1） | `npm ci` 触发 `scripts/setup.mjs`：按平台从 Release/本地渠道取自包含包，解压到 `build/bin/<plat>/`，注入数据目录 env，probe 验证 | 一条命令；无 sudo；离线可装（本地包路径）；失败信息可控 | 需要建 Release 流水线；国内访问 GitHub Release 资产可能不稳（用镜像变量兜底） | ✅ 采纳 |
| B. npm 平台包（esbuild 模式） | 主包 `optionalDependencies` 引 `@mgo/engine-linux-x64` / `@mgo/engine-win-x64`，包内声明 `os/cpu/libc`，npm 自动选装 | 与 npm 安装天然合一，**自动吃国内 registry 镜像**（npmmirror 同步快），lockfile 可复现 | 需要 npm 发布账号 + CI token + 双渠道维护 | ✅ 作为 A 的 v2 升级（同一打包物，换分发渠道） |
| C. Docker 镜像 | `docker run ghcr.io/johnly1986/mgoserver` | 环境绝对一致；服务器部署友好 | 要求 Docker；不贴合"Node 服务 + 自带 systemd"的现有形态 | 🔄 补充项，不替代 |
| D. Node SEA / pkg 单可执行 | 服务端打成单文件，消灭"装 Node" | 分发极简 | C++ 侧动态库 + proj.db 仍要分发，收益有限；SEA 还在实验期 | ❌ 现阶段不做 |
| E. 安装脚本代跑 apt/yum | postinstall 里 `sudo apt install …` | 看似直接 | CI 无 sudo；包名随发行版漂移（libgdal34t64 仅 24.04）；静改系统不可接受 | ❌ 仅作为 doctor 的**提示文案** |

esbuild 的 `optionalDependencies` 平台包先例见 [esbuild PR #1621](https://github.com/evanw/esbuild/pull/1621)：npm 按 `os/cpu/libc` 字段自动选装对应包、其余跳过，lockfile 全平台锁定。

## 3. 自包含引擎包（方案 A/B 的共同载体）

### 3.1 目录布局

```
mgo-engine-<platform>-<arch>/
├── manifest.json          # { version, platform, arch, glibcBaseline, mgoBinary, sha256Files }
├── bin/MGOConsole[.exe]   # RUNPATH: $ORIGIN/../lib（Windows 同目录找 DLL）
├── lib/                   # 全部非 glibc 依赖闭包（ldd 递归收集）：
│   ├── libgdal.so.34 …    #   引擎自有 8 个 .so + libgdal/libproj/libgeotiff/
│   └── …                  #   libtiff/libosg*/libOpenThreads 及其传递依赖
│                          #   （libcurl、libsqlite3、libjpeg、libpng、libzstd、libssl…）
└── share/
    ├── proj/proj.db       # proj-data 内容 → PROJ_DATA 指这里
    └── gdal/              # gdal-data 内容 → GDAL_DATA 指这里
```

Linux 侧用 `patchelf --set-rpath '$ORIGIN/../lib'` 处理全部拷入的 .so；
体积估算：当前 `build/bin/linux` 16 MB（libassimp 占 14 MB）+ GDAL/OSG 闭包 ≈ **解压 120–150 MB，压缩 50–70 MB**，Release 资产与 npm 包都装得下。

### 3.2 两个必须写进文档的兼容性事实

- **glibc 基线**：glibc 不打包。包在哪条基线上构建，就只支持 ≥ 该 glibc 的发行版。建议把引擎构建容器降到 **Ubuntu 22.04（glibc 2.35）** 以扩大覆盖面；Alpine/musl 不支持（doctor 明确报"请用 Docker"）。
- **MSVC 运行库**（Windows）：引擎改 `/MT` 静态 CRT，或包内带 `vc_redist` 静默安装——二选一，写死在打包脚本里。

### 3.3 spawn 层改造（唯一的服务端代码改动）

`src/mgo.js` 的 `probeMgo()` 与 `src/jobs/runner.js` 的 `spawn()` 补一个统一的 env 组装：

```js
// src/engine-env.js（新增）
export function engineEnv(binaryDir) {
  const projData = path.join(binaryDir, 'share/proj');
  const gdalData = path.join(binaryDir, 'share/gdal');
  return {
    ...(fs.existsSync(projData) ? { PROJ_DATA: projData, PROJ_LIB: projData } : {}),
    ...(fs.existsSync(gdalData) ? { GDAL_DATA: gdalData } : {}),
  };
}
```

目录存在才注入，因此**系统装了 proj-data 的老环境行为不变**（自包含目录优先级靠 env 覆盖系统默认，`PROJ_DATA` 是 PROJ 9.x 官方变量，`PROJ_LIB` 为旧名一并设置兜底）。

## 4. 安装器：`scripts/setup.mjs`（postinstall）

`package.json` 增加：

```jsonc
"mgoEngine": { "version": "1.0.0" },            // 期望引擎版本，URL/校验都由它派生
"scripts": {
  "postinstall": "node scripts/setup.mjs",
  "doctor":       "node scripts/doctor.mjs",
  "engine:update": "node scripts/setup.mjs --force"
}
```

解析顺序（**本地优先，逐级回退，全程幂等**）：

1. `MGO_BINARY` 已设 → 直接用，跳过一切（现行为不变）；
2. `build/bin/<plat>/` 已有引擎且 `manifest.json` 版本 ≥ 期望 → 跳过（**现状 clone 即用路径，老用户零感知**）；
3. `MGO_ENGINE_BUNDLE=/path/to.tgz` → 离线安装（内网/无外网）；
4. `MGO_ENGINE_MIRROR` 镜像 URL（国内兜底）；
5. GitHub Release：`https://github.com/Johnly1986/MGOServer/releases/download/engine-v<mgoEngine.version>/mgo-engine-<plat>-<arch>.tgz`。

下载后：sha256 校验 → 解压到 `build/bin/<plat>/` → `probeMgo()` 实测 → 打印结果表（引擎版本 / hasOsgb / hasBim / proj.db 就位 / 缺失项）。
**绝不 sudo、绝不改系统**；失败时输出 doctor 的提示文案并返回非零（postinstall 失败会让 `npm ci` 红掉，问题前置暴露）。

## 5. 诊断：`scripts/doctor.mjs`

一条命令回答"这台机器为什么跑不了"：

- Node ≥ 20、npm registry 可达性；
- 引擎：路径、版本、probe 结果、`hasOsgb/hasBim`；
- **动态库闭包体检**：Linux 上跑 `ldd` 收集 `not found`，逐个列出并给出"自包含包可解决 / 建议升 glibc / 建议用 Docker"三选一结论；musl 直接判不支持；
- 数据文件：`PROJ_DATA` 注入是否生效（引擎 micro-conversion 探针：EPSG:4547 → WGS84 一个点）；
- 磁盘、端口、whitelist 文件、Cesium 同步状态（复用 `verify-deployment.sh` 已有检查项的只读版）。

## 6. CI：`release.yml`（引擎包的唯一生产者）

```
on: push tag engine-v*
jobs (matrix):
  linux-x64:  ubuntu 容器(glibc 基线) 构建 MGO → ldd 闭包收集 + patchelf + 收集 proj-data/gdal-data
              → 打包 tgz + sha256 → 上传 Release
  win-x64:    windows-2022 + MSVC + vcpkg(缓存) 构建 MGO → 收集 DLL + proj.db + gdal-data
              → 打包 zip + sha256 → 上传 Release
冒烟: 两个产物各起一个 job，用 setup.mjs 装包 → npm test → doctor
```

现有 `ci.yml` 不动（它跑桩引擎，与真实引擎解耦的设计正好复用）。

## 7. 用户体验 Before / After

| | 现在 | 方案 A 落地后 |
|---|------|---------------|
| Ubuntu 24.04 | clone + npm ci + **apt 一行** + 祈祷 | `git clone && npm ci && npm start` |
| 其他 Linux 发行版 | 包名对不上，手工折腾 | 同上（受 glibc 基线约束，doctor 给明确结论） |
| Windows | 自建 MSVC 工程 | `git clone && npm ci && npm start` |
| 内网环境 | 全靠手工 | `MGO_ENGINE_BUNDLE=` 离线包 + `npm run doctor` |
| 出问题时 | 读日志猜 | `npm run doctor` 直接给结论 |

## 8. 工作量与风险

| 项 | 估时 | 风险 | 缓解 |
|----|------|------|------|
| 引擎打包脚本（闭包收集 + patchelf + manifest） | 1–2 天 | 传递依赖漏收（如 libcurl 的 TLS 插件） | 用 `ldd` 递归闭包而非手抄清单；冒烟 job 实跑转换 |
| spawn 层 env 注入 + 单测 | 0.5 天 | 老环境被 env 意外覆盖 | 目录存在才注入；单测断言系统库环境不受影响 |
| setup.mjs + doctor.mjs | 2 天 | 下载渠道不稳 | 本地/离线/镜像三级回退 + 幂等 |
| Windows CI 构建 MGO（vcpkg 缓存） | 2–4 天（依赖 MGO 仓库可命令行构建） | MSVC/vcpkg 版本漂移 | 锁 vcpkg baseline；冒烟 job 兜底 |
| glibc 基线容器重建引擎 | 1 天 | 与现 Ubuntu 24.04 产物行为差异 | 现有 test:bim/test:ui 回归 |

风险总评：**唯一硬依赖是 MGO 引擎能在 CI 上无人值守构建**。这一步通了，其余全是 Node 侧纯 JS 工作。

## 9. 分期

- **v1（建议立即做）**：自包含 linux-x64 包 + setup.mjs + doctor.mjs + release.yml(linux) + README 两命令化；现有 git 内置引擎保留为渠道 2（老用户零感知）。
- **v2**：windows-x64 CI 产物接入同一安装器；可选 npm 平台包 `@mgo/engine-*` 上架（吃国内镜像，替代下载脚本主渠道）；linux-arm64 视需求。
- **v3（可选）**：ghcr Docker 镜像（服务器部署形态）；Node SEA 单可执行重新评估。

## 10. 明确不推荐

- postinstall 里 sudo 装系统包（方案 E 的理由）；
- 把 120 MB 库文件全部塞进 git 仓库（单文件 100 MB 限制 + 克隆变慢；Release/npm 才是正解，git 里只留现有 16 MB Linux 引擎）；
- 静态链接一切（GDAL/OSG 的 LGPL/插件机制使静态化得不偿失）；
- 现阶段 Node SEA（见方案 D）。

## 11. 实现与验证记录（2026-09-15）

代码：`scripts/setup.mjs`（安装器）、`scripts/doctor.mjs`（诊断）、`scripts/pack-engine.mjs`（构建机打包）、
`src/engine-env.js` + `src/mgo.js` / `src/jobs/runner.js`（spawn 层注入）、`package.json`（mgoEngine 清单 +
postinstall/doctor/engine:update/engine:pack）、`test/setup.test.js`（11 个用例）。

端到端验证（真实引擎，本仓库 build/bin/linux）：

1. `npm run engine:pack` → 72 MB tgz，129 文件，ldd 闭包**零缺失**（含 libgdal/libproj/libosg/krb5/nss 全链 + proj.db + gdal-data）；
2. `setup.mjs` 离线安装到空目录 → probe `MGO 1.0.0, osgb=✓ bim=✓`；
3. 安装后 `ldd` 逐项核对：引擎全部依赖解析到**包内副本**（`$ORIGIN` 优先于系统目录）——无系统库的机器同链路可解析；
4. 仅设包内 `PROJ_DATA` 跑真实转换 `EPSG:4547 → EPSG:4326`：`(500000, 3300000) → (114.0000, 29.8186)` ✓ 包内 proj.db 独立可用；
5. `npm test` 全量 118/118 通过（含新增 11 例）；doctor 在本机输出 5 pass / 0 fail。

过程中发现的既有缺陷（打包器已顺带修复）：**引擎侧车 .so 的 RUNPATH 是构建机绝对路径**
（`/root/coding/MGO/build…`），并非 README 声称的 `$ORIGIN`——libgdal 等由它们请求，
绝对路径失效后静默回落系统库，掩盖了可移植性问题。pack-engine 对全部 staged ELF 统一
`patchelf --set-rpath $ORIGIN` 规范化。**建议在 MGO 引擎仓库的 CMake 里同步修正**
（`set(CMAKE_BUILD_RPATH_USE_ORIGIN TRUE)` 或安装时 patchelf），让 git 内置的那份引擎同样可搬移。

发布流水线（已由 MGO 仓库自己的 CI 承担，MGOServer 无需再建）：每个 tag（当前 **v0.8.0**）
自动产出 `MGO-<ver>-linux-x64.tar.gz`（引擎本体，RUNPATH `$ORIGIN`，需系统 GIS 库）与
`MGO-<ver>-win-x64.zip`（自包含：gdal.dll/proj.db/gdaldata）。MGOServer 侧只需把新 tag 的
url/sha256 回填 `package.json mgoEngine.downloads`，并核对 `reportsVersion`（二进制
`version` 子命令实际打印值——v0.8.0 仍报 `MGO v1.0.0`，上游版本串未同步 bump）。

已核验（2026-09-15，v0.8.0 资产）：sha256 与 GitHub API digest 一致；linux 包安装后 probe
通过、真实 EPSG:4547→4326 转换正确；win 包 224 文件含 proj.db 于根目录、gdaldata/ 子目录，
`src/engine-env.js` 两种布局（share/… 与 vcpkg 平铺）均已覆盖并有单测。遗留提醒：win 包
混入了 debug 版 DLL（gdald.dll 等，~50 MB）与 vcpkg cmake 残留文件，建议 MGO 打包脚本排除。

## 12. 测试审查记录（2026-09-15）

全量 `npm test` 130/130（审查前 118），总体行覆盖 96.1%。审查发现并已修复：

- **产品缺陷 3 处**（安装器健壮性）：`--dest` 缺参会以 TypeError 崩掉 postinstall → 现在干净报错；
  `--force` 对误配置的 `--dest`（`/`、`$HOME`、仓库根、或无 MGOConsole 的非引擎目录）会盲删 →
  现在拒绝执行；解包遇到恶意/损坏档案（如 zip-slip 条目）会以裸栈崩溃 → 现在转成退出码 1 + 提示。
- **测试补强 12 例**：`parseLdd` DST 回归（`$LIB/…` → basename，真实踩过的 bug）、
  `expectedSha256` 三分支（manifest/sidecar/垃圾 sidecar）、sidecar 完整安装流、下载全败 fail-closed、
  zip-slip 拒收（测试内手写最小 ZIP，yazl 拒绝写恶意路径）、`--dest` 缺参、`--force` 拒删非引擎目录、
  `sha256File` 错误路径、runner 把 PROJ_DATA/GDAL_DATA 真实传进引擎进程、doctor 子进程冒烟
  （断言报告结构而非本机健康度）。
- `scripts/setup.mjs` 语句覆盖 89.1% → 93.4%（其余为 CLI 入口与极难触发的流错误分支）。

遗留建议（未实施）：CI 目前只跑 `npm test`（ubuntu），建议补 windows-latest 跑纯 JS 子集
（setup/engine-env 用例在 Windows 上 `t.skip`，纯函数用例可跑）；`test:ui`/`test:bim`/
`verify-deployment.sh` 仍是本机手动项（本机 31/31 通过）；pack-engine 的真实闭包依赖
patchelf + 系统 GIS 库，保持手动验证（本机已验证：129 文件零缺失）。

## 13. 决策 A 落地：引擎二进制全面退出 git（2026-09-16）

上游 v0.8.0 第三次重发后，linux 资产已自包含（98MB：268 个 .so 全闭包 + `share/proj/proj.db`，
拷入库均 `$ORIGIN` 规范化），chroot 零 GIS 库环境实测通过（version / EPSG 转换 / 地形切片 19/19）。
据此执行决策 A：

- `build/bin/linux/` 从 git 移除（`.gitignore` 加 `build/bin/linux/`、`build/bin/windows/`），
  仓库瘦身 16MB；所有平台统一走 postinstall 下载（幂等），离线用 `MGO_ENGINE_BUNDLE`。
- `ci.yml` 新增 **Real engine smoke** 步骤：每次 PR 都对真实 Release 资产做 probe + 真实
  EPSG:4547→4326 转换（曾经资产带坏 RUNPATH / 缺 proj.db，桩测试看不见，此步兜住）。
- chroot 验证备注：`$ORIGIN` 展开依赖 `/proc/self/exe`，chroot 测试须挂 proc——测试环境事项，
  非包缺陷。

上游遗留（不阻塞）：资产未含 `libstdc++.so.6`/`libgcc_s.so.1`（发行版皆有，chroot 补齐后全通）、
无 GDAL 数据目录（实测地形/坐标链路不需要）。
