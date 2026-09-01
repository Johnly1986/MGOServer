# 引擎二进制目录

服务启动时按当前系统探测本目录（顺序见 `src/config.js` 的 `findMgoBinary`）：

- `linux/`   — Linux 探测：`MGOConsole` 与全部 `.so` 侧车库同放此目录（RUNPATH 为 `$ORIGIN`，目录可整体搬移）。仓库已内置 Ubuntu 24.04 / x86-64 构建。
- `windows/` — Windows 探测：放入 `MGOConsole.exe` 及其依赖 `.dll`（自行构建，方法见根 README「安装」）。

其他位置的引擎用环境变量 `MGO_BINARY` 指定绝对路径。
