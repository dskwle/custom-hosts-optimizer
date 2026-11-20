// Cloudflare Workers 类型通过 @cloudflare/workers-types 全局提供
/// <reference types="@cloudflare/workers-types" />

export interface Bindings {
  custom_hosts: KVNamespace
  API_KEY: string
  // cron 分片刷新时用于回调自身
  WORKER_URL?: string
  INTERNAL_TOKEN?: string
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
