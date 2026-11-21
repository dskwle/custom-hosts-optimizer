# 多 Agent 并行协作流程（custom-hosts 抓包 + Clash 项目）

> 适用：`docs/dev-plan-capture-novnc.md` 里的 22 个任务，由 1 个主 agent 编排、最多 4 个子 agent 并行执行。
> 目标：并行不等于失控——每个子任务**边界清晰、可独立验收、可回滚**，主 agent 是唯一的合并与验收入口。

---

## 1. 前置条件（不满足就不许开工）

并行开发最容易翻车的不是写代码，而是**改同一个文件**和**接口对不上**。所以开工前必须完成三件事：

| 前置 | 产出 | 谁负责 | 完成标志 |
|---|---|---|---|
| 契约冻结 | `docs/orchestration/contracts/api-capture.md` | 主 agent | 前端与后端能各自对着它开发，不需要互相问 |
| 质量门禁脚本 | `scripts/check.sh`（tsc + build + 内嵌 JS 语法 + 单测） | 主 agent | 任何 worktree 里一条命令能跑全套检查 |
| 集成分支 | `integration/capture`（从 `local-runtime` 切出） | 主 agent | 所有 lane 都从它切分支，不直接动 `local-runtime` |

---

## 2. 角色与职责

### 2.1 主 agent（Orchestrator）

只做编排、审查、合并，**不写业务代码**（否则会和子 agent 抢文件）。

- 拆任务、写验收标准、分配 worktree 与分支
- 维护看板 `docs/orchestration/board.md`（唯一有权改状态的人）
- 审查子 agent 的汇报，判定 PASS / CHANGES_REQUESTED
- 合并到 `integration/capture`，冲突一律由它解决
- 合并后统一构建、部署到 NAS、跑端到端验证
- 决定返工、拆分、降级或叫停

### 2.2 子 agent（Worker）

一条泳道一个 agent，**只在自己的 worktree 里写自己拥有的文件**。

- 按契约实现，不擅自改契约（要改先提「契约变更请求」）
- 自测通过后写报告（`docs/orchestration/reports/<task-id>.md`）并上报
- 收到 CHANGES_REQUESTED 后在同一分支追加 commit（禁止 force-push）
- 不部署、不合并、不动别人的 worktree

### 2.3 人类（你）

- 决策 §6 里那 4 个产品问题（noVNC 反代、会话并发、URL 记录、PROXY 组名）
- 处理 agent 之间无法自决的取舍（例如"要不要为性能牺牲建议准确率"）
- 最终验收（看 NAS 上的实际效果）

---

## 3. 工作区隔离

### 3.1 拓扑

```
custom-hosts-optimizer/                 ← 主工作区（local-runtime，只读参考，不在此开发）
  ├─ .git/                              ← 所有 worktree 共享同一份对象库
  └─ docs/orchestration/                ← 看板与报告（主 agent 维护）

../wt-E-clash/        feat/E-clash             ← E 泳道
../wt-A-env/          feat/A-capture-env       ← A 泳道
../wt-C-aggregate/    feat/C-aggregate         ← C 泳道
../wt-D-console/      feat/D-capture-ui        ← D 泳道
```

### 3.2 命名与生命周期

| 项 | 规则 |
|---|---|
| 分支 | `feat/<lane>-<short>`，如 `feat/E-clash`、`feat/D-capture-ui` |
| 基线 | 一律从 `integration/capture` 切出，**不从 `local-runtime` 切** |
| 目录 | 仓库外 `../wt-<lane>/`，避免 IDE 索引互相干扰 |
| 依赖 | 每个 worktree 首次 `npm ci` 一次（约 1 分钟），之后复用 |
| 销毁 | 合并成功后 `git worktree remove ../wt-<lane>` + 删分支 |

### 3.3 创建命令（主 agent 执行，子 agent 不自己建）

```bash
cd custom-hosts-optimizer
git fetch . local-runtime:integration/capture        # 首次
git worktree add -b feat/E-clash ../wt-E-clash integration/capture
cd ../wt-E-clash && npm ci && ./scripts/check.sh      # 基线必须绿
```

> 基线不绿（check.sh 失败）说明 `integration/capture` 本身坏了，**停止分配**，先修主干。

### 3.4 并发上限

最多 **4 个并行**。原因不是 token，是机器资源：`tsc` + `esbuild` + 单测同时在 4 个 worktree 里跑，8 核机器已经吃满；再多会让彼此的验证结果互相干扰（超时被误判成失败）。

---

## 4. 任务拆解与文件所有权

### 4.1 拆解原则

一个子任务必须同时满足四条，否则继续拆：

1. **单一验收点**：能用一条命令或一个界面操作判定"过没过"
2. **文件封闭**：只改自己拥有的文件（见 4.2）
3. **不依赖未完成的 lane**：依赖用契约 + mock 顶住
4. **可独立合并**：合进集成分支后，其它 lane 不会因此变红

### 4.2 文件所有权（防冲突的核心）

| 路径 | 所有者 | 说明 |
|---|---|---|
| `docker-compose.yml`、`Dockerfile`、`.dockerignore` | **A** | 只加 `capture` profile，不动现有 service |
| `server/capture/cdp.ts`、`session.ts`、`store.ts`、`stream.ts` | **B** | 抓包核心 |
| `server/capture/aggregate.ts`、`advice.ts`、`fixtures/` | **C** | 纯函数 + 测试，零 IO |
| `src/clash/*.ts` | **E** | 规则生成，纯函数优先 |
| `public/console.html` | **D 独占** | 见下方"冲突热点" |
| `server/index.ts` | **主 agent** | 子 agent 只提交 `server/routes/<lane>.ts`，挂载行由主 agent 加 |
| `src/constants.ts` | **主 agent** | 涉及内置清单，容易和 E 的规则输出打架 |
| `docs/orchestration/**` | 主 agent | 子 agent 只写自己的 `reports/<task-id>.md` |
| `scripts/check.sh` | 主 agent | 门禁脚本不能被子 agent 改（否则等于自己给自己判卷） |

**三个冲突热点及处理**：

1. `public/console.html`（近 2000 行单文件）
   → D 独占。E 只交付 YAML 端点，**不做 UI**；控制台里的「规则输出」卡片由 D 在 B7 之后作为独立小任务加，输入是 E 的端点地址（契约里已定）。
2. `server/index.ts`（所有路由都在这）
   → 每个 lane 一个 `server/routes/<lane>.ts`，导出 `Hono` 实例；`server/index.ts` 只允许主 agent 加一行 `root.route("/local/capture", captureRoutes)`。
3. `src/constants.ts`（内置域名/屏蔽清单）
   → 本期不动。E 只读不写。

---

## 5. 任务状态机

```
                    ┌──────────── 主 agent 拆分 + 写验收标准
                    ▼
   TODO ──▶ READY ──▶ CLAIMED ──▶ IN_PROGRESS ──▶ REPORTED ──▶ IN_REVIEW
             │            │            ▲                │            │
             │            │            │                │            ├─ PASS ──▶ ACCEPTED ──▶ MERGED
             │            │            └──── CHANGES_REQUESTED ◀──────┘
             │            │                          （返工，同一分支追加 commit）
             │            └─▶ BLOCKED（依赖未就绪/环境坏了）──▶ READY
             └─▶ CANCELLED（需求取消或拆分合并）
```

| 状态 | 含义 | 谁能进入 | 谁能离开 | 进入条件 |
|---|---|---|---|---|
| TODO | 已识别未定义 | 主 | 主 | — |
| READY | 验收标准已写、有 worktree、无人占用 | 主 | 主/子 | `check.sh` 在基线通过 |
| CLAIMED | 子 agent 已认领 | 子 | 子 | 必须先回一条"我接了" |
| IN_PROGRESS | 开发中 | 子 | 子 | — |
| REPORTED | 已提交报告，等审查 | 子 | 主 | 报告文件已写、分支已 push 到本地 remote（见 9.2） |
| IN_REVIEW | 主 agent 正在审 | 主 | 主 | — |
| CHANGES_REQUESTED | 打回返工 | 主 | 子 | 报告里有 P0 问题，或验收命令不过 |
| ACCEPTED | 验收通过，待合并 | 主 | 主 | — |
| MERGED | 已合入集成分支并回归通过 | 主 | — | 合并后 `check.sh` + 该 lane 验收脚本绿 |
| BLOCKED | 被外部阻塞 | 子/主 | 主 | 报告里写明阻塞点与解阻条件 |
| CANCELLED | 取消 | 主 | — | — |

**硬规则**：

- 状态只能单向推进，**唯一例外是 `IN_REVIEW → CHANGES_REQUESTED → IN_PROGRESS`**（返工回路）。
- 子 agent 无权把任务标成 ACCEPTED/MERGED，也无权自行 CANCELLED。
- 同一时刻一个任务只能有一个 owner；换人要显式转移。

---

## 6. 汇报格式

报告是**唯一的事实来源**，聊天里的口头汇报只作提醒。文件：`docs/orchestration/reports/<task-id>.md`，模板见附录 B。

### 6.1 必填项（缺一项直接打回，不看内容）

| 段 | 要求 |
|---|---|
| 一句话结论 | 完成了什么，是"可合并"还是"需要决策" |
| 基线 | 从哪个 commit 切出（`git rev-parse --short HEAD`），避免审错版本 |
| 变更范围 | 文件清单 + 增删行数 + **是否碰了非自己拥有的文件**（碰了直接 P0） |
| 验收自测 | 命令 + 关键输出（原样粘贴，不要"已验证"三个字） |
| 契约偏差 | 有偏差必须列出；没有就写"无" |
| 待确认问题 | 需要主 agent/人类拍板的点，编号列出 |
| 风险与回滚 | 最坏情况是什么，怎么退 |
| 合并建议 | `可合并 / 需先合并 X / 不可合并` + 理由 |

### 6.2 验收自测的最低要求

| Lane | 必须贴出的证据 |
|---|---|
| A | `docker compose --profile capture up -d` 成功；`curl /local/capture/env` 返回 CDP 可达；`docker stats` 内存占用 |
| B | 抓一个真实站点，`/summary` 的 host 数与浏览器 DevTools 面板数量同量级；SSE 有增量输出 |
| C | 单测通过数；fixture 输入 → 期望输出的差异为 0 |
| D | 截图（mock 数据下的完整流程）；控制台无 JS 报错 |
| E | `curl /clash/*` 四个端点 200 + 片段粘进 mihomo 后 `E7` 断言通过 |

---

## 7. 审查与验收

主 agent 按固定清单审，**先看边界，再看质量**：

1. **边界**：`git diff --name-only` 是否越界（只改了 4.2 表里属于自己的文件）
2. **契约**：返回结构、字段名、错误码是否与 `api-capture.md` 一致
3. **回归**：`./scripts/check.sh` 在自己机器上重跑一遍（不信子 agent 的"我这儿是绿的"）
4. **既有功能**：`/host`、`/host_fast`、`/host_block` 输出与合并前**逐字节对比**（除时间戳行）
5. **验收脚本**：跑该 lane 对应的验收命令
6. **可维护性**：有没有为了过验收写死数据、注释掉的断言、`any` 满天飞

判定：

- 六项全过 → `ACCEPTED`
- 任一项不过且属于 P0 → `CHANGES_REQUESTED`，指出**具体文件行号 + 复现命令**
- 只有 P1/P2 → 记 backlog，允许合并（在报告里标注 follow-up）

---

## 8. 返工规则

### 8.1 严重度

| 级别 | 定义 | 处理 |
|---|---|---|
| **P0** 阻塞 | 验收不过 / 破坏契约 / 动了他人的文件 / 让 `check.sh` 变红 / 影响 `/host*` 既有输出 | 必须修，不合并 |
| **P1** 应修 | 边界情况（空会话、超长域名、SSE 断线）、文案错误、缺日志 | 可先合并，登记 follow-up 任务，下一轮修 |
| **P2** 建议 | 命名、注释、可读性 | 记 backlog，不阻塞 |

### 8.2 轮次与升级

- 同一任务最多 **3 轮返工**。
- 第 1 轮：主 agent 给出问题清单（编号 + 文件:行 + 复现命令），子 agent 在**原分支**追加 commit。
- 第 2 轮仍不过：主 agent 缩小范围（把任务拆成"能过的部分"和"过不了的部分"），先合并前者。
- 第 3 轮仍不过：**换人**或主 agent 亲自实现剩余部分，原任务标记 `CANCELLED` 并在看板记录原因。

### 8.3 返工的纪律

- 只允许追加 commit，**禁止 force-push / rebase 已上报的分支**（否则主 agent 无法对比两次审查之间的差异）。
- 返工必须只改被点名的文件；顺手改别的文件视为新增风险，需要重新审查全量 diff。
- 如果返工原因是"契约本身有问题"，**不走返工流程**：先改契约（主 agent 批），再同步通知所有受影响 lane。

### 8.4 阻塞处理

子 agent 遇到以下情况立即 `BLOCKED` 并说明解阻条件，不许自己造轮子绕过：

- 依赖的端点还没合并（例如 D 需要 B7，但 B 未 ACCEPTED）
- 契约有歧义（字段语义不明）
- 环境问题（端口冲突、镜像拉不下来）

主 agent 的处理顺序：**降级（用 mock 继续）> 调整依赖顺序 > 拆任务 > 亲自补**。

---

## 9. 合并策略

### 9.1 顺序

```
E（Clash 端点） → A（capture profile） → B（抓包后端） → C（聚合） → D（UI）
```

- E 无依赖，先合先收益
- A 合完 B 才有环境联调
- C 只改纯函数文件，合入风险最低
- D 最后合，因为它依赖所有接口就绪

### 9.2 合并方式

```bash
cd custom-hosts-optimizer                      # 主工作区
git checkout integration/capture
git merge --no-ff feat/E-clash -m "merge(E): Clash 规则端点"
./scripts/check.sh && ./scripts/verify-clash.sh
git checkout local-runtime && git merge --ff-only integration/capture   # 全部验收后才快进
```

- 一律 `--no-ff`，保留"一次任务一个合并点"，将来出问题能整块回滚。
- **冲突只有主 agent 能解**；子 agent 遇到冲突应停下来上报，不许自己拍。
- 合并后立刻跑全量检查 + 部署到 NAS 冒烟；任何一项红 → `git revert -m 1 <merge-commit>`，任务退回 `CHANGES_REQUESTED`。

### 9.3 回归门禁（每次合并都要过）

| 门禁 | 命令 | 通过标准 |
|---|---|---|
| 类型 | `npx tsc --noEmit` | 0 error |
| 构建 | `npm run local:build` | 产物生成 |
| 内嵌 JS | `node --check` 提取脚本 | 0 语法错误 |
| 单测 | `node --test server/**/*.test.ts` | 全绿 |
| hosts 回归 | 合并前后 diff `/host` | 除首行时间戳外无差异 |
| 部署冒烟 | `curl /host` `/host_block` `/local/health` | 200 / 401 符合预期 |

---

## 10. 看板与迭代闭环

`docs/orchestration/board.md` 是唯一看板，主 agent 每次状态变化都改它：

```
| ID | 任务 | Lane | Owner | 分支 | 状态 | 轮次 | 备注 |
|----|------|------|-------|------|------|------|------|
| T0 | 契约冻结 | — | main | — | MERGED | 0 | — |
| E1 | /clash/hosts.yaml | E | agent-E | feat/E-clash | ACCEPTED | 0 | 待合并 |
| B3 | 事件采集 | B | agent-B | feat/B-capture | IN_PROGRESS | 0 | — |
| D1 | 诊断页骨架 | D | agent-D | feat/D-capture-ui | CHANGES_REQUESTED | 1 | 见 reports/D1.md#P0-1 |
```

闭环的判定标准不是"任务都 MERGED"，而是：

1. 集成分支上的端到端验收脚本全绿（抓包 → 勾选 → 加速 → hosts + Clash 双端生效）
2. 误伤回归（5 个真实站点）通过
3. 所有 P1 都转成了明确 backlog 条目，没有"口头答应后面修"
4. 看板上没有停在 IN_REVIEW / CHANGES_REQUESTED 超过 1 天的任务

---

## 11. 反模式（明令禁止）

| 反模式 | 后果 | 替代做法 |
|---|---|---|
| 两个 agent 同时改 `console.html` | 大面积冲突，合并时互相覆盖 | D 独占；其他 lane 提交后端/脚本 |
| 子 agent 自己改 `server/index.ts` 挂路由 | 每次都冲突 | 提交 `server/routes/<lane>.ts`，主 agent 挂载 |
| 子 agent 自行部署到 NAS | 线上状态与看板不一致，无法回滚 | 只有主 agent 部署，部署前记 commit |
| "我这儿是绿的" 但不贴输出 | 审查无法复核 | 必须贴命令与输出 |
| 改契约不通知 | 其他 lane 编译失败 | 契约变更走单独流程 + 广播 |
| 为了过验收注释掉断言 | 假绿 | 发现即 P0，按破坏质量门禁处理 |
| 长时间不开工也不报 BLOCKED | 看板失真 | 认领后 30 分钟无进展必须上报 |

---

## 附录 A：首轮任务与验收标准（节选）

| ID | 任务 | Lane | 验收标准（可执行） |
|---|---|---|---|
| T0 | 契约 + 门禁脚本 + 集成分支 | 主 | 契约文档评审通过；`scripts/check.sh` 在干净 worktree 通过 |
| A1 | compose capture profile | A | `docker compose --profile capture up -d` 成功；不加 profile 时 `docker ps` 无 chromium |
| A3 | CDP 自检接口 | A | `curl /local/capture/env` → `{cdp:true, version:"..."}`；停掉 chromium → `{cdp:false}` |
| E1–E3 | 三个 YAML 端点 | E | 四个 `curl` 全 200；`block.yaml` payload 条数 = 内置屏蔽 + 手动屏蔽 + 广告规则（去重后） |
| E4 | 合并片段 | E | 粘进 mihomo 后：加速域名解析到指定 IP、屏蔽域名返回 REJECT（E7 断言） |
| B3 | 事件采集 | B | 抓 `github.com` 得到的 host 数 ∈ [20, 120]；缓存请求被标记并排除 |
| B5 | SSE | B | `curl -N /stream` 能看到 ≥10 条增量；断开后重连不重复推送 |
| C1–C3 | 聚合与建议 | C | fixture 单测全绿；对"广告多的资讯站"fixture，第三方慢域名 `suggested=true` |
| D3 | 请求表格 | D | mock 数据下：筛选/排序/全选/反选可用；1000 行渲染 < 200ms |
| D5 | 应用动作 | D | 勾选 3 个 → 加速后 `/host` 出现 3 条；再勾 2 个屏蔽 → `/host_block` 出现 4 行（v4+v6） |

## 附录 B：报告模板

```markdown
# <task-id> <任务名>

- **结论**：可合并 / 需决策 / 不可合并（一句话）
- **Lane / Owner**：E / agent-E
- **分支 / 基线**：feat/E-clash @ a1b2c3d（从 integration/capture@9f8e7d6 切出）
- **状态**：REPORTED

## 变更范围
| 文件 | 增/删 | 说明 |
|---|---|---|
| src/clash/hosts.ts | +86/-0 | 新增 |
| server/routes/clash.ts | +54/-0 | 新增 |

> 是否触碰非本 lane 文件：否

## 验收自测
```bash
$ ./scripts/check.sh
tsc: 0 error
build: dist-server/index.mjs 102.4kb
tests: 12 passed, 0 failed

$ curl -s localhost:8788/clash/hosts.yaml | head -3
hosts:
  "github.com": ["public-ip-xxxx"]
```
（原样粘贴关键输出）

## 契约偏差
无。（如有：字段 `p95TtfbMs` 在超时场景返回 null 而非 0，已同步契约）

## 待确认问题
1. `/clash/ads.yaml` 是否也要公开？当前按"公开"实现。

## 风险与回滚
- 风险：hosts 条目过多导致 YAML 体积 300KB+
- 回滚：删除 `server/routes/clash.ts` 的挂载行即可，无数据迁移

## 合并建议
可合并，建议在 A 之后（无依赖，顺序无所谓）
```
