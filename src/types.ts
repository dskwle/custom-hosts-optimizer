/**
 * 业务代码用到的存储接口。
 * 本地实现见 server/kv.ts 的 FileKV（落盘到 data/kv），签名保持一致。
 */
export interface KVStore {
  get(key: string, options?: { type?: "text" | "json" } | "text" | "json"): Promise<any>
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list?(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }>
}

export interface Bindings {
  custom_hosts: KVStore
}

export interface CustomDomain {
  domain: string
  description?: string
  addedAt: string
  lastUpdated?: string
  ip?: string
}

export interface CustomDomainList {
  [key: string]: CustomDomain
}

export interface OptimizationResult {
  domain: string
  bestIp: string
  responseTime: number
  testTime: string
}
