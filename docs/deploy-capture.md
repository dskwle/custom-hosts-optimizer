# 部署：内嵌浏览器抓包环境（capture profile）

抓包功能需要一个**真实的 Chromium**（CDP 端口 + 可被人操作的画面）。这套东西默认**不启动**，
只有显式带 `--profile capture` 才会创建容器，现有部署（`app` + `refresher`）零影响。

- 相关文件：`docker-compose.yml`（`novnc` / `chromium` 两个 service + `capture` 网络）
- 自检接口：`GET /local/capture/env`（实现见 `server/routes/capture-env.ts`）
- 闲置回收：`scripts/orch/capture-idle-stop.sh`

---

## 1. 架构与端口

```
宿主机（app / refresher / chromium 都在宿主网络栈里）
├─ app 容器 :8788 ────────────────┐
├─ chromium（host 网络）── CDP 127.0.0.1:9223 ◀─┘
│      └── DISPLAY=127.0.0.1:0（X11，经宿主 loopback :6000）
└─ novnc 容器（bridge）
       ├─ Xvfb :0 + x11vnc + noVNC :8080
       ├─ 宿主 127.0.0.1:6000 ── X11（只发布到 loopback，给 chromium 用）
       └─ 宿主 0.0.0.0:6080   ── noVNC 网页（局域网可见）
```

**X 显示在 `novnc` 容器里，`chromium` 容器只是连上去的浏览器客户端。**
这是 `theasp/novnc` 的官方用法（它自带 Xvfb + x11vnc + websockify，示例就是让别的容器连 `novnc:0.0`）；
反过来让 novnc 去连外部 VNC 5900 反而要改它的启动脚本，不划算。

| 端口 | 谁监听 | 绑定方式 | 用途 | 谁能访问 |
|---|---|---|---|---|
| `9223` | chromium | 容器内 `127.0.0.1:9223`（可改 `CAPTURE_CDP_PORT`） | CDP | **只有宿主机本地**（host 网络 + Chrome 强制 loopback） |
| `8080` → `6080` | novnc | `0.0.0.0:6080`（可改 `CAPTURE_NOVNC_PORT`） | noVNC 网页 | 局域网可见，**无内置鉴权**，见 §4 |
| `6000` | novnc | `127.0.0.1:6000`（可改 `CAPTURE_X11_PORT`） | X11，给 chromium 用 | **只有宿主机本地** |
| `5900` | — | 不存在 | — | 本方案不用裸 VNC 端口 |

> **为什么 chromium 必须用 `network_mode: host`（踩过的坑，别改回去）**
> 带界面的 Chrome 会**忽略 `--remote-debugging-address`**，强制只监听容器内的 `127.0.0.1`
> （容器内 `/proc/net/tcp` 是 `0100007F:2407`）。而 `ports: "127.0.0.1:9223:9223"` 的流量是
> docker-proxy 从**容器 IP** 发起的，连不到容器 loopback —— 所以那种写法永远打不通，`curl` 返回 000。
> 让 chromium 和 app 共享宿主网络栈后，Chrome 监听的 loopback 就是宿主 loopback，
> `app` 直接访问 `http://127.0.0.1:9223` 即可；同时因为只在 loopback 上，局域网照样连不到。
> `--headless` 模式下 `--remote-debugging-address` 才是有效的，但 headless 就没画面了，不是我们要的。

---

## 2. 启动 / 停止

```bash
# 启动抓包环境（含 CDP 与 noVNC）
docker compose --profile capture up -d

# 只启动浏览器，不重建镜像
docker compose --profile capture start chromium

# 停掉浏览器（X 显示保留，下次 start 秒开）
docker compose --profile capture stop chromium

# 全部停掉并释放内存（novnc 一起停）
docker compose --profile capture stop
docker compose --profile capture rm -f chromium novnc   # 删容器（不要用 down：会连 app 一起停）

# 查看状态
docker compose --profile capture ps
curl -s http://127.0.0.1:9223/json/version   # 有输出 = CDP 活着
curl -s -u admin:$ADMIN_PASSWORD http://127.0.0.1:8788/local/capture/env
```

不带 profile 的日常运维完全不受影响：

```bash
$ docker compose config --services
app
refresher

$ docker compose --profile capture config --services
app
novnc
chromium
refresher
```

### 镜像与固定 tag

两个镜像都可通过环境变量覆盖，默认值写在 compose 里：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CAPTURE_NOVNC_IMAGE` | `theasp/novnc:latest` | 上游多年未再发版，只有 `latest`。**建议在 NAS 上按 digest 固定**（见下） |
| `CAPTURE_CHROMIUM_IMAGE` | `zenika/alpine-chrome:124` | 只含浏览器的精简镜像；若该 tag 已下架，改成 `docker pull` 得到的任意 chromium 镜像即可 |

按 digest 固定（推荐，可复现部署）：

```bash
docker pull theasp/novnc:latest
docker inspect --format '{{index .RepoDigests 0}}' theasp/novnc:latest
# 形如 theasp/novnc@sha256:xxxx，写进 .env：
# CAPTURE_NOVNC_IMAGE=theasp/novnc@sha256:xxxx
```

### 必须清空 entrypoint（否则是 headless，noVNC 里看不见浏览器）

`zenika/alpine-chrome` 的镜像 entrypoint 是 `["chromium-browser", "--headless"]`。
只写 `command:` 只会把参数**追加**在 `--headless` 后面，结果容器起得来、CDP 也通，
但 `/json/version` 返回 `HeadlessChrome/...`，noVNC 画面里什么都没有。compose 里是这样绕过的：

```yaml
entrypoint: []
command:
  - "/bin/sh"
  - "-c"
  - >-
    until nc -z -w1 novnc 6000; do sleep 1; done;
    exec /usr/lib/chromium/chromium --remote-debugging-port=9223 ...
```

两处关键：`entrypoint: []` 清掉镜像自带的 `--headless`；`until nc -z novnc 6000` 等 X 就绪
（否则 chromium 可能比 Xvfb 先起来，报 `cannot open display` 后反复重启）。

**改完/换镜像后一定要跑冒烟脚本**，它把"必须有头"固化成断言：

```bash
./scripts/orch/capture-smoke.sh          # 起容器 → 验 noVNC 200 → 断言不是 HeadlessChrome → 清理
./scripts/orch/capture-smoke.sh --keep   # 跑完保留容器，方便人工看画面
```

输出示例：

```
· 启动 novnc + chromium
✓ 容器已创建
✓ noVNC 网页 200（:6080/vnc.html）
· CDP "Browser": "Chrome/124.0.6367.78"
✓ CDP 返回 Chrome 系浏览器
✓ 不是 headless 模式

冒烟通过
```

> 脚本只清理 `chromium`/`novnc` 两个容器，**不会**执行 `docker compose down`——那条命令会把
> `app` 一起停掉，在 NAS 上等同于短暂宕机。

---

## 3. 内存与资源

| 容器 | 常态 | 峰值 | `mem_limit` | 说明 |
|---|---|---|---|---|
| `chromium` | 300–500MB | ~800MB（大页面 / 视频） | `1g` + `memswap_limit: 1g` | 超限被 OOM kill，由 `restart: unless-stopped` 拉起 |
| `novnc` | 80–120MB | ~200MB | `256m` | 只做 X + 画面转发 |

- `shm_size: 512mb` 配合 Chromium 的 `--disable-dev-shm-usage`，避免 `/dev/shm` 太小导致渲染崩溃。
- 两个容器都是 `restart: unless-stopped`：`up -d` 之后会自动恢复，`stop` 之后不会自己回来。
- 单实例：一套 compose 只跑一个 Chromium，**不支持并发抓包会话**（多会话要多套容器，不划算）。

---

## 4. noVNC 的访问与鉴权（同源内嵌）

**架构**：noVNC 的静态前端（约 1 MB，精简掉了测试与 IE polyfill）放在 `public/novnc/`，
由 `app` 的 `/novnc/*` 直接托管；`novnc` 容器只保留 Xvfb / x11vnc / websockify，
8080 只发布到宿主 `127.0.0.1:6080`。

```
浏览器 ── HTTP ──> app:8788/novnc/vnc.html        （Basic Auth）
       ── WS   ──> app:8788/novnc/websockify       （Basic Auth，握手单独校验）
                        │ 原始字节转发
                        v
                 127.0.0.1:6080/websockify  → x11vnc → Xvfb → Chromium
```

- 控制台里的 iframe 是**同源相对路径** `/novnc/vnc.html?path=novnc/websockify&...`，
  不再有 `vncPort` 覆盖，也不再有"文档写 8888 / 代码写 6080"的口径分歧。
- 对外只有一个端口 8788；静态页、WebSocket 数据都经过同一套登录校验。
- `server/index.ts` 里 `serve()` 返回的 Node server 注册了 `upgrade` 监听：
  校验 `Authorization` 后把握手字节原样转发到 loopback，**不解析 RFB、不引 WS 库**。
  注意 Hono 的中间件只作用于 HTTP 请求，WS 握手必须自己校验，否则会绕过鉴权。
- `?vnc=<完整地址>` 仍保留，仅用于临时连外部 noVNC 排障。

**升级 noVNC 前端**：资源是从运行中的镜像复制的精简集，版本与
`CAPTURE_NOVNC_IMAGE` 对齐。升级镜像后执行：

```bash
./scripts/orch/vendor-novnc.sh       # 从容器重新同步 public/novnc/
```

本地不用 Docker 直接 `npm run local` 时，若 `public/novnc/` 不存在，
`/novnc/*` 会返回 404 提示——这是预期的，抓包本来就需要容器。

---

## 5. 闲置自动停止（NAS 内存回收）

`scripts/orch/capture-idle-stop.sh` 在确认没人用之后停掉 `chromium`，把 300–500MB 还给系统。

判定"有人在用"的两个信号，任一命中就重置 10 分钟倒计时：

1. 容器 CPU ≥ `CPU_THRESHOLD`（默认 5%）
2. CDP `/json/list` 的标签页集合发生变化（新开页面、导航到别的站点）

CDP 探测失败（`sig=down`）**不算**活动，否则浏览器崩溃时会永远无法回收。

```bash
# 单次检查（cron 用这个）
./scripts/orch/capture-idle-stop.sh

# 只看判定依据，不停容器
./scripts/orch/capture-idle-stop.sh --status

# 常驻（每 60s 一次）
IDLE_MINUTES=10 ./scripts/orch/capture-idle-stop.sh --loop
```

cron 示例（群晖/威联通的任务计划里加一条）：

```cron
*/5 * * * * cd /volume1/docker/custom-hosts && ./scripts/orch/capture-idle-stop.sh >> data/capture-idle.log 2>&1
```

可调环境变量：`CAPTURE_CDP_URL`、`CAPTURE_CONTAINER`、`IDLE_MINUTES`、`CPU_THRESHOLD`、`INTERVAL`、`STATE_FILE`。

> 停掉后前端 iframe 会显示"连接断开"，用户点"开始抓包"时由 `app` 负责
> `docker compose --profile capture start chromium`（或人工执行），恢复在 1–2 秒内。

---

## 6. 故障排查

| 现象 | 检查 | 处理 |
|---|---|---|
| `/local/capture/env` 返回 `{cdp:false,error:"connect ECONNREFUSED..."}` | `docker compose --profile capture ps` | 没带 profile 启动，或 chromium 正在重启；`up -d` 后重试 |
| 同上，`error` 是 `CDP 探测超时` | `docker logs custom-hosts-chromium \| tail -30` | 容器内 Chromium 卡死/在等 X；重启 chromium |
| noVNC 页面能打开但黑屏 | `docker logs custom-hosts-novnc` | X 未起来；`docker compose --profile capture restart novnc` |
| 宿主 `curl 127.0.0.1:9223/json/version` 返回 `000`，但容器在跑 | `docker inspect custom-hosts-chromium --format '{{.HostConfig.NetworkMode}}'` | 必须是 `host`。带界面的 Chrome 只监听容器内 loopback（`/proc/net/tcp` 里的 `0100007F:2407` 是正常现象），非 host 网络下端口映射连不到它——不要试图用 `ports` 修，改回 `network_mode: host` |
| noVNC 打开是黑屏/空桌面，且 `/json/version` 返回 `HeadlessChrome/...` | `docker inspect custom-hosts-chromium --format '{{json .Config.Entrypoint}}'` | entrypoint 又带上了 `--headless`；见 §2「必须清空 entrypoint」，跑 `./scripts/orch/capture-smoke.sh` 复验 |
| 浏览器里没有窗口 | `docker logs custom-hosts-chromium` 里找 `cannot open display` | chromium 比 novnc 先起来导致；`restart chromium` |
| 页面中文变方块 | — | 精简 chromium 镜像不带 CJK 字体，抓包（请求列表）不受影响；需要看中文就换带字体的镜像 |
| 内存持续 > 900MB | `docker stats custom-hosts-chromium` | 关掉不用的标签页；或调小 `IDLE_MINUTES` |
| 9223 端口被占用 | `lsof -iTCP:9223 -sTCP:LISTEN` | 换端口：`CAPTURE_CDP_PORT=9333`，同时给 `app` 设 `CAPTURE_CDP_URL=http://127.0.0.1:9333` |

---

## 7. 回滚

这两个 service 与 `capture` 网络都是**纯新增**，删掉即可，不涉及任何数据迁移：

```bash
docker compose --profile capture rm -f chromium novnc   # 先清理 capture 容器（别用 down，会停 app）
# 然后回退 commit，或在 .env 里保持默认（不带 profile 就完全不启动）
git revert --no-edit <本次 commit>
```

`data/` 卷不受影响（抓包数据由 B 写在 `data/capture/`，与运行时容器无关）。
