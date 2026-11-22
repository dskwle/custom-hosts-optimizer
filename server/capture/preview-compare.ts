/**
 * 预览前后对比（纯函数，零 IO）。
 *
 * 「先在抓包浏览器里验证，再决定要不要写」的关键一步：
 * 把同一域名在预览前（原始解析）和预览后（映射到候选 IP）的耗时并排比，
 * 让用户看到实际数字，而不是靠预估。
 *
 * 为什么只比 p95 总耗时：单个请求受瞬时抖动影响大，p95 能反映常态。
 * 请求数太少时直接标"样本不足"，避免拿一两个请求下结论——这正是
 * 之前把 baidu 全判成"快 380ms"那类错误的根源。
 */

export interface HostTiming {
  host: string
  requests: number
  p95TotalMs?: number
  failures: number
}

export interface CompareRow {
  host: string
  /** 预览前（原始解析） */
  before: HostTiming | null
  /** 预览后（应用映射） */
  after: HostTiming | null
  /** 耗时变化：负数表示变快。无对照时为 null */
  deltaMs: number | null
  /** 相对变化百分比 */
  deltaPct: number | null
  verdict: 'faster' | 'slower' | 'same' | 'failed' | 'insufficient'
  /** 一句话结论，中文 */
  note: string
}

/** 少于这个请求数就不下结论 */
export const MIN_SAMPLES = 3

/** 变化小于这个比例算"基本持平"，避免把噪声当收益 */
const NOISE_PCT = 10

function index(rows: readonly HostTiming[]): Map<string, HostTiming> {
  const m = new Map<string, HostTiming>()
  for (const r of rows) m.set(r.host.toLowerCase(), r)
  return m
}

/**
 * 对比两组采样。
 *
 * 只输出「被映射的域名」——没映射的域名前后没区别，混进来只会让表变长。
 */
export function comparePreview(
  before: readonly HostTiming[],
  after: readonly HostTiming[],
  mappedHosts: readonly string[],
): CompareRow[] {
  const b = index(before)
  const a = index(after)
  const rows: CompareRow[] = []

  for (const raw of mappedHosts) {
    const host = raw.toLowerCase()
    const bRow = b.get(host) ?? null
    const aRow = a.get(host) ?? null

    // 预览后完全没请求：可能页面这次没加载它，不能算"变快"
    if (!aRow || aRow.requests === 0) {
      rows.push({
        host,
        before: bRow,
        after: aRow,
        deltaMs: null,
        deltaPct: null,
        verdict: 'insufficient',
        note: '预览后未观察到该域名的请求，无法比较（可刷新页面重试）',
      })
      continue
    }

    // 预览前就没数据：没有基线，只能说"这次通了/没通"
    if (!bRow || bRow.requests === 0) {
      rows.push({
        host,
        before: bRow,
        after: aRow,
        deltaMs: null,
        deltaPct: null,
        verdict: aRow.failures === 0 ? 'insufficient' : 'failed',
        note: '预览前没有采样，无基线可比；预览后请求' + (aRow.failures === 0 ? '正常' : '有失败'),
      })
      continue
    }

    // 样本太少：给出现状但不判优劣
    if (bRow.requests < MIN_SAMPLES || aRow.requests < MIN_SAMPLES) {
      rows.push({
        host,
        before: bRow,
        after: aRow,
        deltaMs: null,
        deltaPct: null,
        verdict: 'insufficient',
        note: `样本不足（前 ${bRow.requests} / 后 ${aRow.requests} 次，至少需 ${MIN_SAMPLES} 次）`,
      })
      continue
    }

    // 预览后出现失败：这是最需要警惕的情况，映射的 IP 反而不能用
    if (aRow.failures > 0 && bRow.failures === 0) {
      rows.push({
        host,
        before: bRow,
        after: aRow,
        deltaMs: null,
        deltaPct: null,
        verdict: 'failed',
        note: `映射后出现 ${aRow.failures} 次失败（预览前无失败），该 IP 不可用，不要写入`,
      })
      continue
    }

    const bMs = bRow.p95TotalMs
    const aMs = aRow.p95TotalMs
    if (bMs == null || aMs == null) {
      rows.push({
        host,
        before: bRow,
        after: aRow,
        deltaMs: null,
        deltaPct: null,
        verdict: 'insufficient',
        note: '缺少耗时数据，无法比较',
      })
      continue
    }

    const delta = aMs - bMs
    const pct = bMs > 0 ? Math.round((delta / bMs) * 100) : null
    let verdict: CompareRow['verdict']
    let note: string
    if (pct != null && Math.abs(pct) <= NOISE_PCT) {
      verdict = 'same'
      note = `基本持平（${bMs}ms → ${aMs}ms），差异在 ${NOISE_PCT}% 噪声范围内，不值得改写 hosts`
    } else if (delta < 0) {
      verdict = 'faster'
      note = `变快 ${Math.abs(delta)}ms（${Math.abs(pct ?? 0)}%）：${bMs}ms → ${aMs}ms`
    } else {
      verdict = 'slower'
      note = `变慢 ${delta}ms（${pct ?? 0}%）：${bMs}ms → ${aMs}ms，说明该 IP 不如当前解析`
    }

    rows.push({
      host,
      before: bRow,
      after: aRow,
      deltaMs: delta,
      deltaPct: pct,
      verdict,
      note,
    })
  }

  // 变快的排前面，最需要用户决策的（faster/slower）优先
  const order: Record<CompareRow['verdict'], number> = {
    faster: 0,
    slower: 1,
    failed: 2,
    insufficient: 3,
    same: 4,
  }
  rows.sort((x, y) => order[x.verdict] - order[y.verdict] || x.host.localeCompare(y.host))
  return rows
}
