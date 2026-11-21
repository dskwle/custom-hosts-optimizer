# A capture 运行环境（compose profile + CDP 自检 + 闲置回收）

- **结论**：可合并（镜像 tag 与"noVNC 是否反代"两个点需要主 agent 在 NAS 侧确认/拍板，不影响代码正确性）
- **Lane / Owner**：A / agent-A
- **分支 / 基线**：`feat/A-capture-env` @ `a765f37`（从 `integration/capture@a765f37` 切出）
- **状态**：REPORTED
- **报告时间**：2026-11-21 11:00

## 变更范围

| 文件 | 增/删 | 说明 |
|---|---|---|
| `docker-compose.yml` | +99/-0 | 纯追加：`capture` 网络 + `novnc`/`chromium` 两个 `profiles: ["capture"]` service。现有 `app`、`refresher` **一个字段都没动**（diff 里零删除行） |
| `server/routes/capture-env.ts` | +121/-0 | 新增 `createCaptureEnvRoutes(getCdpUrl)`，实现 `GET /env`，附 `resolveCdpUrl()` / `DEFAULT_CDP_URL` 供主 agent 挂载时用 |
| `scripts/orch/capture-idle-stop.sh` | +157/-0 | 新增闲置自动停止（CDP `/json/list` + 容器 CPU 双信号，单次/常驻两种模式） |
| `docs/deploy-capture.md` | +199/-0 | 部署与运维文档：端口表、启停命令、内存预期、鉴权、排障、回滚 |

> 是否触碰非本 lane 拥有的文件：**否**。`server/index.ts`、`Dockerfile`、`public/console.html`、`package.json`、
> `scripts/check.sh`、`src/**` 均未修改（已用 `git status --short` + `git diff --stat` 核对）。

## 实现要点

1. **profile 隔离**：两个 service 都带 `profiles: ["capture"]`，不带 profile 时 compose 根本不创建它们。
2. **CDP 不对外**：`ports: ["127.0.0.1:${CAPTURE_CDP_PORT:-9222}:9222"]`——只绑宿主 loopback。
   `app` 是 `network_mode: host`，直接 `http://127.0.0.1:9222` 可达；局域网/公网不可达。
   （容器内必须加 `--remote-debugging-address=0.0.0.0`，否则 Docker 端口映射转发不到容器内的 127.0.0.1；
   真正的隔离靠宿主侧 `127.0.0.1:` 前缀。）
3. **Chromium 启动参数**：`--remote-debugging-port=9222 --remote-debugging-address=0.0.0.0
   --remote-allow-origins=* --no-sandbox --disable-dev-shm-usage --user-data-dir=/tmp/chrome --no-first-run`
   + `--no-default-browser-check --disable-gpu --window-size=1600,968 --start-maximized about:blank`。
4. **拓扑（与设计图不同，已写进文档）**：`theasp/novnc` 镜像自带 Xvfb + x11vnc + websockify，
   它的官方用法就是"别的容器连 `novnc:0.0`"。所以 **X 显示放在 novnc 容器，chromium 只是浏览器客户端**
   （`DISPLAY=novnc:0.0`，X11 走 capture 内网 6000，不发布）。反过来让 novnc 去连外部 VNC 5900 需要改它的
   启动脚本，风险更大。
5. **资源治理**：`chromium` mem_limit/memswap_limit `1g`、`shm_size 512mb`；`novnc` `256m`；都
   `restart: unless-stopped`；闲置 10 分钟由脚本停掉 chromium（X 显示保留，`start` 1–2 秒恢复）。

## 验收自测

```bash
$ ./scripts/check.sh
== TypeScript ==
== Build (local runtime) ==
  dist-server/index.mjs  111.6kb
⚡ Done in 15ms
== Console inline JS syntax ==
script[0] 语法 OK（1328 行）
== Unit tests ==
（暂无测试文件，跳过）

全部通过
```

```bash
$ docker compose config --services
app
refresher

$ docker compose --profile capture config --services
app
novnc
chromium
refresher

$ docker compose --profile capture config > /tmp/cfg.yml ; echo exit=$?
exit=0
```

渲染后的关键字段（确认 CDP 只绑 loopback、noVNC 发布 6080）：

```yaml
# chromium.ports
- mode: ingress
  host_ip: 127.0.0.1
  target: 9222
  published: "9222"
# novnc.ports
- mode: ingress
  target: 8080
  published: "6080"
```

路由三态冒烟（临时脚本 `.tmp-smoke.ts`，未提交：起 Hono + 假 CDP，分别命中成功/拒绝/超时）：

```
CDP 正常     : 200 no-store {"cdp":true,"version":"126.0.6478.182","chromium":"Chrome/126.0.6478.182"}
CDP 不可达   : 200 no-store {"cdp":false,"error":"connect ECONNREFUSED 127.0.0.1:9399"}
CDP 超时(): 200 no-store {"cdp":false,"error":"CDP 探测超时（>2000ms）"}
超时耗时 ms: 2001
```

闲置脚本（假 `docker` + 假 CDP 注入 PATH，覆盖四条分支）：

```
--- 首次+CDP 可用（无活动，idle 0）   [capture-idle] ... 无活动：已闲置 0s / 600s（CPU 0.05%，target=188210046830）
--- 标签页变化 → 有活动              [capture-idle] ... 有活动：标签页变化(bogus→188210046830)，重置闲置计时
--- 高 CPU                           [capture-idle] ... 有活动：CPU 42.5% ≥ 5%，重置闲置计时
--- CDP 挂 + 状态回拨 → 停止          [capture-idle] ... 超过 10 分钟无活动，停止 custom-hosts-chromium（X 显示保留...）
--- 容器未运行                       [capture-idle] ... 容器 custom-hosts-chromium 未运行，无需处理
```

> **未在本机验证的部分（重要）**：本机的 docker 无法访问镜像仓库
> （`docker manifest inspect theasp/novnc:latest` → `failed to configure transport: error pinging v2 registry:
> Get "https://registry-1.docker.io/v2/": Bad Gateway`，同一网络下 Docker Hub API 与 WebFetch 也都不通），
> 因此 `--profile capture up -d` / `curl /local/capture/env` 的**真实**返回 / `docker stats` 内存实测
> **没能在本机跑**。请在 NAS 上用下面三条补验，任一不符我立刻返工：

```bash
docker compose --profile capture up -d
docker compose --profile capture ps
curl -s -u admin:$ADMIN_PASSWORD http://127.0.0.1:8788/local/capture/env   # 期望 cdp:true + version
curl -s -o /dev/null -w '%{http_code}\n' http://<NAS-IP>:6080/vnc.html      # 期望 200
docker stats --no-stream custom-hosts-chromium custom-hosts-novnc
```

## 契约偏差

1. **`CaptureEnv` 类型本地声明**：契约要求类型在 `server/capture/types.ts`（B 所有）。为避免跨 lane 依赖未合并文件，
   `server/routes/capture-env.ts` 里按契约 §1 做了一份**字段完全一致**的本地 `CaptureEnv`。
   合并后建议由主 agent 改成 `import type { CaptureEnv } from "../capture/types.js"` 并删掉本地声明（一行改动）。
2. **`/env` 探测失败返回 200 而非 5xx**：与任务书一致，契约 §2 的错误码表只约束其它接口（CDP 不可达 → 502 是给 `/start` 用的）。
   这里故意用 200 + `{cdp:false,error}`：capture profile 默认不启动属于**正常状态**，5xx 会污染前端通用错误处理。
3. **拓扑与 `dev-plan-capture-novnc.md` §1 的图不同**：图里写"chromium 容器含 Xvfb+x11vnc，novnc 只是 WebSocket 前端"，
   实际 `theasp/novnc` 自带整套 X 栈、且只支持"别人连它的 `:0`"。为落地可行性按后者实现，已在 `docs/deploy-capture.md` §1 写明。
   语义不受影响：noVNC 网页看到的就是抓包用的那个 Chromium，CDP 仍在内网。

## 待确认问题

1. **noVNC 是否要经 app 反代**（对应 F3）：当前是直连 `:6080`，镜像本身**零鉴权**，谁连上谁就能操作这个浏览器。
   文档里给了 nginx 反代 + Basic Auth 片段，也说明了为什么不适合挂在 `app` 的 `/local/*` 下（WS 握手会绕过）。
   建议：局域网直连、远程一律走反代；要不要强制 nobody-can-reach 由你拍板。
2. **镜像 tag 未在线验证**：`theasp/novnc` 上游多年只发 `latest`；`zenika/alpine-chrome:124` 的 tag 是否还在架
   我无法在本机确认（registry 不可达）。两个都做成了变量（`CAPTURE_NOVNC_IMAGE` / `CAPTURE_CHROMIUM_IMAGE`），
   文档给了"按 digest 固定"的做法。若 `pull` 失败，改 `.env` 一行即可，不用动代码。
3. **CJK 字体**：精简 chromium 镜像不带中文字体，页面中文可能显示方块（抓包请求列表不受影响）。
   要不要换成带字体的镜像（体积 +200MB）请定。
4. **X11 走 TCP**：chromium 通过 `novnc:0.0`（内网 TCP 6000）连 X。theasp 官方示例就是这么用的，
   但若某些 SELinux/网络策略环境不通，备选方案是共享 `/tmp/.X11-unix` 卷——需要实测后再定，我没在 NAS 上验证过。

## 风险与回滚

- **风险**：NAS 上 Chromium 常驻内存（300–500MB，峰值 ~800MB）在低配机型上可能影响其它服务；
  已用 `mem_limit 1g` + 闲置停止脚本兜底。另一个风险是 noVNC 零鉴权被内网误开放。
- **回滚**：两个 service 与 `capture` 网络都是纯新增，`docker compose --profile capture down` 后
  `git revert <commit>` 即可；`data/` 卷不涉及，无数据迁移。

## 合并建议

可合并。建议顺序上仍按 `E → A → B`：A 合并后 B 才有真实 CDP 可联调。
唯一前置是主 agent 在 NAS 上跑一遍上面那三条补验命令（本机 registry 不通，我无法完成 up 级验证）。
