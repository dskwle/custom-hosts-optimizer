# 部署：内嵌浏览器抓包环境（capture profile）

抓包功能需要一个**真实的 Chromium**（CDP 端口 + 可被人操作的画面）。这套东西默认**不启动**，
只有显式带 `--profile capture` 才会创建容器，现有部署（`app` + `refresher`）零影响。

- 相关文件：`docker-compose.yml`（`novnc` / `chromium` 两个 service + `capture` 网络）
- 自检接口：`GET /local/capture/env`（实现见 `server/routes/capture-env.ts`）
- 闲置回收：`scripts/orch/capture-idle-stop.sh`

---

## 1. 架构与端口

```
宿主机
├─ app 容器（host 网络，:8788）──── 127.0.0.1:9222 ──┐
│                                                   │ (端口映射，只绑 loopback)
└─ capture 网络（bridge，custom-hosts-capture）       │
   ├─ chromium ── CDP :9222 ◀────────────────────────┘
   │      │ DISPLAY=novnc:0.0（X11 TCP :6000，仅内网）
   │   novnc ─ Xvfb :0 + x11vnc + noVNC :8080
   └─ 宿主机 :6080 ── noVNC 网页（局域网可见）
```

**X 显示在 `novnc` 容器里，`chromium` 容器只是连上去的浏览器客户端。**
这是 `theasp/novnc` 的官方用法（它自带 Xvfb + x11vnc + websockify，示例就是让别的容器连 `novnc:0.0`）；
反过来让 novnc 去连外部 VNC 5900 反而要改它的启动脚本，不划算。

| 端口 | 谁监听 | 绑定方式 | 用途 | 谁能访问 |
|---|---|---|---|---|
| `9222` | chromium | `127.0.0.1:9222`（可改 `CAPTURE_CDP_PORT`） | CDP | **只有宿主机本地**，局域网/公网不可达 |
| `8080` → `6080` | novnc | `0.0.0.0:6080`（可改 `CAPTURE_NOVNC_PORT`） | noVNC 网页 | 局域网可见，**无内置鉴权**，见 §4 |
| `6000` | novnc | 不发布 | X11（给 chromium 用） | 仅 `capture` 内网 |
| `5900` | — | 不存在 | — | 本方案不用裸 VNC 端口 |

> **CDP 为什么绑 `127.0.0.1` 而不是 compose 内网 IP**
> `app` 用的是 `network_mode: host`（为了宿主机 IPv6 出口），它进不了 bridge 网络，
> 所以用"宿主 loopback + 端口映射"这条确定性最好的路径：`app` 访问 `http://127.0.0.1:9222`，
> 而 loopback 之外的任何来源都连不上。**绝对不要改成 `"9222:9222"` 或 `"0.0.0.0:9222:9222"`**——
> 拿到 CDP 等于拿到这个浏览器的全部能力（读页面、执行 JS、读 cookie）。

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
docker compose --profile capture down        # 连容器一起删

# 查看状态
docker compose --profile capture ps
curl -s http://127.0.0.1:9222/json/version   # 有输出 = CDP 活着
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
    exec /usr/lib/chromium/chromium --remote-debugging-port=9222 ...
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

## 4. noVNC 的访问与鉴权（重要）

- 浏览器打开：`http://<NAS-IP>:6080/vnc.html?autoconnect=1&resize=scale&reconnect=1`
- 该镜像**没有任何登录校验**。谁能连上 6080，谁就能操作这个 Chromium（等于在 NAS 内网里有一个
  "能上网的浏览器"），也能通过浏览器下载/上传文件。
- 因此：**只在可信局域网使用**；要远程访问，前面必须加一层带认证的反代。反代需要处理 WebSocket 升级：

```nginx
# nginx 片段：/vnc/ 反代到 noVNC，外面套 Basic Auth
location /vnc/ {
    auth_basic           "capture";
    auth_basic_user_file /etc/nginx/.htpasswd;
    proxy_pass           http://127.0.0.1:6080/;
    proxy_http_version   1.1;
    proxy_set_header     Upgrade $http_upgrade;   # noVNC 走 WebSocket
    proxy_set_header     Connection "upgrade";
    proxy_set_header     Host $host;
    proxy_read_timeout   3600s;
}
```

- 不要把 noVNC 挂在 `app` 的 `/local/*` 下面省鉴权：`app` 的 Basic Auth 只管 HTTP 请求，
  noVNC 的 WebSocket 握手会绕过它，而且要在 Hono 里做 WS 升级代理，成本比在反代上加两行高得多。
  **待主 agent 拍板**（见报告"待确认问题"）。

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
| noVNC 打开是黑屏/空桌面，且 `/json/version` 返回 `HeadlessChrome/...` | `docker inspect custom-hosts-chromium --format '{{json .Config.Entrypoint}}'` | entrypoint 又带上了 `--headless`；见 §2「必须清空 entrypoint」，跑 `./scripts/orch/capture-smoke.sh` 复验 |
| 浏览器里没有窗口 | `docker logs custom-hosts-chromium` 里找 `cannot open display` | chromium 比 novnc 先起来导致；`restart chromium` |
| 页面中文变方块 | — | 精简 chromium 镜像不带 CJK 字体，抓包（请求列表）不受影响；需要看中文就换带字体的镜像 |
| 内存持续 > 900MB | `docker stats custom-hosts-chromium` | 关掉不用的标签页；或调小 `IDLE_MINUTES` |
| 9222 端口被占用 | `lsof -iTCP:9222 -sTCP:LISTEN` | 换端口：`CAPTURE_CDP_PORT=9223`，同时给 `app` 设 `CAPTURE_CDP_URL=http://127.0.0.1:9223` |

---

## 7. 回滚

这两个 service 与 `capture` 网络都是**纯新增**，删掉即可，不涉及任何数据迁移：

```bash
docker compose --profile capture down          # 先清理容器
# 然后回退 commit，或在 .env 里保持默认（不带 profile 就完全不启动）
git revert --no-edit <本次 commit>
```

`data/` 卷不受影响（抓包数据由 B 写在 `data/capture/`，与运行时容器无关）。
