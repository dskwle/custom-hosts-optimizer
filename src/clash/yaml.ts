/**
 * 手写 YAML 的最小工具集。
 *
 * 为什么不引 yaml 库：本项目不增加依赖（package.json 由主 agent 管），
 * 而我们输出的结构极其固定——只有「键: 值」「键: [列表]」两种形态，
 * 自己拼字符串比引一个库更可控，也不会因为上游库的格式化策略变化而改动输出。
 *
 * 统一约定：
 * - 键一律用双引号（域名里可能有 `-`、`*` 之类会被 YAML 当语法的字符）
 * - 值一律用单引号（单引号内只有 `'` 需要转义成 `''`，比双引号的反斜杠规则省心）
 */
export function doubleQuoted(value: string): string {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

export function singleQuoted(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** 注释行；多行文本按行拆成多条注释，避免拼出非法 YAML */
export function comment(lines: string | string[]): string {
  const arr = Array.isArray(lines) ? lines : String(lines).split("\n")
  return arr.map((l) => (l ? `# ${l}` : "#")).join("\n")
}

/** 缩进版列表项，如 listItem("github.com", 2) → `  - 'github.com'` */
export function listItem(value: string, indent: number): string {
  return `${" ".repeat(indent)}- ${singleQuoted(value)}`
}
