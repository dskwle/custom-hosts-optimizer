# <task-id> <任务名>

- **结论**：可合并 / 需决策 / 不可合并（一句话说清）
- **Lane / Owner**：<A|B|C|D|E> / agent-<x>
- **分支 / 基线**：`feat/<lane>-<short>` @ `<commit>`（从 `integration/capture@<commit>` 切出）
- **状态**：REPORTED
- **报告时间**：YYYY-MM-DD HH:mm

## 变更范围

| 文件 | 增/删 | 说明 |
|---|---|---|
| `path/to/file` | +00/-00 | 新增 / 修改了什么 |

> 是否触碰非本 lane 拥有的文件：**否** / 是（列出，并说明原因）

## 验收自测

```bash
$ ./scripts/check.sh
（粘贴关键输出：tsc / build / tests 结果）

$ <该 lane 的验收命令>
（粘贴输出，例如 curl 返回、单测统计、截图路径）
```

> 只贴"已验证"三个字视为未提供证据。

## 契约偏差

无。 / 有：<字段、结构或错误码与 `contracts/api-capture.md` 不一致的地方，以及处理方式>

## 待确认问题

1. <需要主 agent 或人类拍板的点>
2. …

（没有就写"无"）

## 风险与回滚

- 风险：<最坏情况>
- 回滚：<一条命令或一步操作，说明是否会丢数据>

## 合并建议

可合并 / 建议在 <其它任务> 之后合并（理由：…） / 不可合并（原因：…）

---

## 审查记录（主 agent 填写，子 agent 不动这节）

### 第 1 轮 · YYYY-MM-DD
- 结论：ACCEPTED / CHANGES_REQUESTED
- 检查项：
  - [ ] 文件边界
  - [ ] 契约一致性
  - [ ] check.sh 本地复跑
  - [ ] /host* 输出无差异
  - [ ] 验收脚本
  - [ ] 可维护性
- 问题：
  - **P0-1** `server/capture/cdp.ts:88` — 重连时未清理旧监听器，导致重复事件（复现：断开后重连，summary 请求数翻倍）
  - P1-1 `advice.ts:42` — 第三方判定漏了 `co.uk` 这类多级后缀
- 要求：修 P0，P1 登记 follow-up
