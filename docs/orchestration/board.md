# 任务看板（唯一事实来源）

> 只有主 agent 能改这张表。状态定义见 `multi-agent-workflow.md` §5。
> 最后更新：2026-11-21 11:05 · 阶段：并行开发中（4 条 lane 已启动）

## 状态图例

`TODO` 未定义 / `READY` 可认领 / `CLAIMED` 已认领 / `IN_PROGRESS` 开发中 / `REPORTED` 待审 / `IN_REVIEW` 审查中 / `CHANGES_REQUESTED` 返工 / `ACCEPTED` 验收通过 / `MERGED` 已合入 / `BLOCKED` 阻塞 / `CANCELLED` 取消

## 准备期

| ID | 任务 | Lane | Owner | 分支 | 状态 | 轮次 | 备注 |
|---|---|---|---|---|---|---|---|
| T0-1 | 冻结契约 `contracts/api-capture.md` | — | main | — | MERGED | 0 | 阻塞所有 lane |
| T0-2 | 质量门禁 `scripts/check.sh` | — | main | — | MERGED | 0 | 基线必须绿 |
| T0-3 | 集成分支 `integration/capture` | — | main | — | MERGED | 0 | 从 local-runtime 切 |
| T0-4 | worktree 引导脚本 `scripts/orch/new-worktree.sh` | — | main | — | MERGED | 0 | — |

## Lane E（Clash 输出，无依赖，优先合入）

| ID | 任务 | Owner | 分支 | 状态 | 轮次 |
|---|---|---|---|---|---|
| E1 | `/clash/hosts.yaml` | agent-E | feat/E-clash | IN_PROGRESS | 0 |
| E2 | `/clash/block.yaml` + `/clash/ads.yaml` | agent-E | feat/E-clash | IN_PROGRESS | 0 |
| E3 | `/clash/proxy.yaml`（SNI 阻断清单） | agent-E | feat/E-clash | IN_PROGRESS | 0 |
| E4 | `/clash/snippet.yaml` 合并片段 | agent-E | feat/E-clash | IN_PROGRESS | 0 |
| E5 | 完整配置模板 | agent-E | feat/E-clash | IN_PROGRESS | 0 |
| E7 | `scripts/verify-clash.sh` 自动断言 | agent-E | feat/E-clash | IN_PROGRESS | 0 |

## Lane A（运行环境）

| ID | 任务 | Owner | 分支 | 状态 | 轮次 |
|---|---|---|---|---|---|
| A1 | compose `capture` profile（chromium + novnc） | agent-A | feat/A-capture-env | IN_PROGRESS | 0 |
| A2 | Chromium 启动参数 | agent-A | feat/A-capture-env | IN_PROGRESS | 0 |
| A3 | `/local/capture/env` 自检接口 | agent-A | feat/A-capture-env | IN_PROGRESS | 0 |
| A5 | 资源治理（内存上限、闲置自停） | agent-A | feat/A-capture-env | IN_PROGRESS | 0 |

## Lane B（抓包后端）

| ID | 任务 | Owner | 分支 | 状态 | 轮次 | 依赖 |
|---|---|---|---|---|---|---|
| B1 | CDP 客户端封装 | agent-B | feat/B-capture | BLOCKED | 0 | T0-1 |
| B2 | target attach + navigate | agent-B | feat/B-capture | BLOCKED | 0 | B1 |
| B3 | 事件采集与耗时计算 | agent-B | feat/B-capture | BLOCKED | 0 | B2 |
| B4 | 会话管理与落盘 | agent-B | feat/B-capture | BLOCKED | 0 | B2 |
| B5 | SSE 推送 | agent-B | feat/B-capture | BLOCKED | 0 | B3 |
| B7 | `/local/capture/apply` | agent-B | feat/B-capture | BLOCKED | 0 | T0-1 |

## Lane C（聚合与判定）

| ID | 任务 | Owner | 分支 | 状态 | 轮次 | 依赖 |
|---|---|---|---|---|---|---|
| C1 | 按 host 聚合 | agent-C | feat/C-aggregate | IN_PROGRESS | 0 | T0-1 |
| C2 | 第一方/第三方判定 | agent-C | feat/C-aggregate | IN_PROGRESS | 0 | C1 |
| C3 | 建议引擎 | agent-C | feat/C-aggregate | IN_PROGRESS | 0 | C1, C2 |
| C5 | fixture 单测 | agent-C | feat/C-aggregate | IN_PROGRESS | 0 | C1–C3 |

## Lane D（控制台 UI）

| ID | 任务 | Owner | 分支 | 状态 | 轮次 | 依赖 |
|---|---|---|---|---|---|---|
| D1 | 「网页诊断」标签页骨架 | agent-D | feat/D-capture-ui | IN_PROGRESS | 0 | T0-1 |
| D2 | noVNC iframe 区域 | agent-D | feat/D-capture-ui | IN_PROGRESS | 0 | A1 |
| D3 | 请求表格（筛选/排序/全选） | agent-D | feat/D-capture-ui | IN_PROGRESS | 0 | T0-1 |
| D4 | SSE 增量渲染 | agent-D | feat/D-capture-ui | IN_PROGRESS | 0 | B5 |
| D5 | 应用动作（加速/屏蔽） | agent-D | feat/D-capture-ui | IN_PROGRESS | 0 | B7 |
| D6 | 会话历史 | agent-D | feat/D-capture-ui | IN_PROGRESS | 0 | B4 |
| D7 | 「规则输出」卡片 | agent-D | feat/D-capture-ui | IN_PROGRESS | 0 | E4 |

## 集成验收

| ID | 任务 | Owner | 状态 | 备注 |
|---|---|---|---|---|
| F1 | 端到端（抓包→勾选→加速→双端生效） | main | TODO | 依赖 A–E |
| F2 | 误伤回归（5 个真实站点） | main | TODO | — |
| F3 | 安全复核（CDP 不对外、公开端点范围） | main | TODO | — |
| F4 | 资源与性能 | main | TODO | — |
| F5 | 文档回填 | main | TODO | — |

## 变更记录

| 时间 | 变更 |
|---|---|
| 2026-11-21 10:47 | 建板，进入准备期 |
| 2026-11-21 11:02 | T0 完成并合入 local-runtime（a765f37），集成分支建立 |
| 2026-11-21 11:05 | 建 worktree：wt-A/wt-C/wt-D/wt-E；E/A/C/D 四条 lane 并行启动；B 因依赖 A3 暂缓 |
| 2026-11-21 11:05 | 抓取合并前基线：`baseline/host.txt`(2215) / `host_fast.txt`(226) / `host_block.txt`(1988) |
