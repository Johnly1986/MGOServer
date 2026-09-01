# MGOServer

[![Test](https://github.com/Johnly1986/MGOServer/actions/workflows/ci.yml/badge.svg)](https://github.com/Johnly1986/MGOServer/actions/workflows/ci.yml)

把 [MGO](https://github.com/Johnly1986/MGO) C++ 转换工具链包装成 Web 服务：提交六类数据处理任务——
**模型转 3D Tiles、地形切片、影像切片、GeoJSON 坐标转换、模型简化、OSGB 倾斜摄影**——
浏览器实时查看进度与成果。三维成果自动转地心坐标系，二维数据转经纬度，可直接在内置查看器（CesiumJS）上加载。

- 页面：`/console.html` 任务控制台 · `/viewer.html` 成果查看器 · `/whitelist.html` 白名单管理
- 接口：`/api/v1/jobs`（提交 / 状态 / SSE 进度 / 取消）、`/ws/{jobId}/out/**`（成果静态托管，CORS）
- 访问控制：IP 白名单，名单外一律 403；设计文档见 [docs/VISUALIZATION_SERVICE_DESIGN.md](docs/VISUALIZATION_SERVICE_DESIGN.md)

## 环境要求

- Node.js ≥ 20
- MGO 可执行文件：默认探测同级目录 `../MGO/build/bin/MGOConsole`，没有则先构建
  `git clone git@github.com:Johnly1986/MGO.git ../MGO && (cd ../MGO && make release)`，或用 `MGO_BINARY` 指定绝对路径

## 运行

```bash
git clone git@github.com:Johnly1986/MGOServer.git && cd MGOServer
npm ci
npm start          # 监听 0.0.0.0:8080
```

```bash
curl http://127.0.0.1:8080/api/v1/health    # {"status":"ok",…} 即启动成功
```

浏览器访问要求客户端 IP 在白名单内：本机 `127.0.0.1`/`::1` 恒放行；外部电脑先在**服务器本机**打开
`http://127.0.0.1:8080/whitelist.html`，把自己的公网 IP 加入并保存——立即生效，且持久化到
`workspace/whitelist.json`（重启不丢）。

## 配置

全部配置均有内置默认值，开箱即用。需覆盖时用真实环境变量（完整键位与说明见
[.env.example](.env.example)，也可将其落盘为 `.env`，三种启动路径行为一致）：

| 变量 | 默认 | 用途 |
|------|------|------|
| `MGO_HOST` / `MGO_PORT` | `0.0.0.0` / `8080` | 监听地址 |
| `MGO_BINARY` | `../MGO/build/bin/MGOConsole` | MGO 可执行文件路径 |
| `MGO_IP_WHITELIST` | `127.0.0.1`,`::1` | 启动兜底白名单，逗号分隔，支持 CIDR |
| `MGO_TRUST_PROXY` | `loopback` | 允许哪个对端用 `X-Forwarded-For` 改写客户端 IP |

走 nginx 等反向代理时：反代须部署在同机并透传
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，保持 `MGO_TRUST_PROXY=loopback`。

## 常驻部署（systemd）

```bash
sudo cp deploy/mgo-server.service /etc/systemd/system/
sudo cp deploy/mgo-server.env.example /etc/mgo-server.env    # 按需修改 IP / binary / 端口
sudo systemctl daemon-reload && sudo systemctl enable --now mgo-server
journalctl -u mgo-server -f
```

开机自启、崩溃自愈；启动日志固定打印 `url / binary / whitelist / trustProxy` 等生效值，便于核对配置。

## 离线环境（可选）

```bash
npm i cesium@1.111 --no-save && npm run sync:cesium
```

`viewer.html` 自动优先使用本地自托管的 Cesium（未同步时回退官方 CDN）；版本须锁定 1.111。
