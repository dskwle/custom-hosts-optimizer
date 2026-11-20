// Cloudflare Workers 类型通过 @cloudflare/workers-types 全局提供
/// <reference types="@cloudflare/workers-types" />

export interface Bindings {
  custom_hosts: KVNamespace
  API_KEY: string
  // 静态资源绑定：Cloudflare 暴露为 Fetcher，只有 fetch()，没有 get()
  ASSETS: Fetcher
  ENABLE_OPTIMIZATION?: string
  ADMIN_USERNAME?: string
  ADMIN_PASSWORD?: string
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
