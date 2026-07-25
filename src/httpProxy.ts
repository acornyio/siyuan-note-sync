import type { HttpRequest, HttpResponse } from './apiClient'

/** 思源 forwardProxy 响应（data 字段）。 */
export interface ForwardProxyResponse {
  status: number
  body: string
  // 思源 forwardProxy 的 headers 是**数组值**（真机实测 `{"Content-Type":["text/html"]}`）；
  // 防御性兼容 string，扁平化时取首个值。
  headers: Record<string, string[] | string>
}

export type ForwardProxyFn = (req: {
  url: string
  method: string
  headers: { [k: string]: string }[]
  timeout?: number
}) => Promise<ForwardProxyResponse>

/**
 * header 键统一小写 + 值扁平化，供 apiClient 一致读取（如 retry-after）。
 * 思源 forwardProxy 返回数组值（`{"Retry-After":["42"]}`），取首个；兼容 string。
 */
function normalizeHeaders(headers: Record<string, string[] | string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? (v[0] ?? '') : v
  }
  return out
}

/**
 * 用思源 forwardProxy 实现 apiClient 的 HttpRequest（全平台绕 CORS）。
 * - 请求 headers {K:V} → forwardProxy 的 [{K:V}] 数组
 * - 响应 data.status 透传；JSON.parse(data.body) → json（失败则 null）；headers 小写化
 */
export function createForwardProxyHttp(forwardProxy: ForwardProxyFn): HttpRequest {
  return async ({ url, headers }): Promise<HttpResponse> => {
    const headerArray = Object.entries(headers).map(([k, v]) => ({ [k]: v }))
    const resp = await forwardProxy({ url, method: 'GET', headers: headerArray })
    let json: unknown = null
    try {
      json = resp.body ? JSON.parse(resp.body) : null
    } catch {
      // body 非 JSON（如上游 429 返回纯文本）：保持 json = null
    }
    return { status: resp.status, json, headers: normalizeHeaders(resp.headers ?? {}) }
  }
}
