/**
 * 标记抓包结果里「已经有规则」的域名。
 *
 * 抓包表里经常出现已经在内置加速、自定义域名或屏蔽清单里的域名：
 * 再默认勾上让用户点一次「加速/屏蔽」，后端只会返回 skipped，纯属白点。
 * 所以这里给它们打标并把 suggested 关掉，前端再加一列显示归类。
 *
 * 纯函数，不碰 KV：集合由路由层读好后传进来，便于单测。
 */
import type { ExistingTag, HostSummary } from './types.ts'

export interface ExistingSets {
  builtin: ReadonlySet<string>
  customAccel: ReadonlySet<string>
  blocked: ReadonlySet<string>
}

/**
 * 优先级与 /apply 的 skip 判定保持一致（内置 → 自定义 → 屏蔽），
 * 这样用户看到的标签和真去点加速时返回的 reason 是同一个。
 */
export function markExisting<T extends HostSummary>(rows: T[], sets: ExistingSets): T[] {
  for (const row of rows) {
    const host = (row.host || '').trim().toLowerCase()
    let tag: ExistingTag | null = null
    if (sets.builtin.has(host)) tag = 'builtin'
    else if (sets.customAccel.has(host)) tag = 'custom-accel'
    else if (sets.blocked.has(host)) tag = 'blocked'

    if (!tag) continue
    row.existing = tag
    // 只改「默认不勾选」，不禁止用户手动勾：比如想把一个已屏蔽域名改成加速
    row.suggested = false
  }
  return rows
}
