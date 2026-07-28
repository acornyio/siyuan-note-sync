import type { ExportFeedResponse } from './types'

export type HttpResponse = { status: number; json: unknown; headers: Record<string, string> }
export type HttpRequest = (req: { url: string; headers: Record<string, string> }) => Promise<HttpResponse>

export class AuthError extends Error {
  constructor() {
    super('Export token rejected (401)')
    this.name = 'AuthError'
  }
}
export class RateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Rate limited (429), retry in ${retryAfterSeconds}s`)
    this.name = 'RateLimitError'
  }
}
export class FeedRequestError extends Error {
  constructor(readonly status: number) {
    super(`Feed request failed (${status})`)
    this.name = 'FeedRequestError'
  }
}

/**
 * 这个错误值不值得重试。
 *
 * 真机遇到过：`/api/network/forwardProxy failed (code 8): ... net/http: TLS handshake timeout`。
 * 一页翻页失败就让整轮同步作废、退避 60 秒——十来页里抖一次就前功尽弃，网络稍差就可能
 * 永远同步不完。这类网络/代理层故障必须就地重试。
 *
 * 反过来，401 不会因为重试而变好，429 已经由引擎安排退避，重试只会火上浇油。
 */
export function isTransientFeedError(error: unknown): boolean {
  if (error instanceof AuthError || error instanceof RateLimitError) return false
  // 408 Request Timeout 与 5xx 是服务端侧的瞬时故障；其余 4xx 是请求本身有问题，重试无益。
  if (error instanceof FeedRequestError) return error.status >= 500 || error.status === 408
  return true // 网络/代理层失败：超时、TLS 握手失败、连接被拒……
}

export interface RetryOptions {
  /** 总尝试次数（含首次）。 */
  attempts?: number
  /** 第 n 次重试前的等待毫秒数；用完则复用最后一个。 */
  delaysMs?: number[]
  /** 注入便于单测；默认真实 setTimeout。 */
  sleep?: (ms: number) => Promise<void>
  /** 插件卸载/禁用后立即放弃，不要继续占着网络重试。 */
  isAborted?: () => boolean
}

const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000]

/** 对瞬时故障重试；非瞬时故障立即上抛，不浪费尝试次数。 */
export async function retryTransient<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4
  const delays = opts.delaysMs ?? DEFAULT_RETRY_DELAYS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      const last = attempt >= attempts
      if (last || !isTransientFeedError(error) || opts.isAborted?.()) throw error
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)])
    }
  }
}

export interface FetchFeedOptions {
  serverUrl: string
  token: string
  cursor: string | null
  limit?: number
}

/** Acorny 只有一个官方托管 API，没有需要配置的自建服务地址。 */
export const ACORNY_API_BASE_URL = 'https://api.acorny.io'

export async function fetchFeedPage(http: HttpRequest, opts: FetchFeedOptions): Promise<ExportFeedResponse> {
  const base = opts.serverUrl.replace(/\/+$/, '')
  const limit = opts.limit ?? 100
  let url = `${base}/api/v1/exports/highlights/feed?limit=${limit}`
  if (opts.cursor) url += `&cursor=${encodeURIComponent(opts.cursor)}`

  const res = await http({ url, headers: { Authorization: `Token ${opts.token}` } })

  if (res.status === 401) throw new AuthError()
  if (res.status === 429) {
    const header = res.headers['retry-after'] ?? res.headers['Retry-After']
    const body = res.json as { retryAfter?: number } | null
    const retry = Number(header ?? body?.retryAfter ?? 60)
    throw new RateLimitError(Number.isFinite(retry) ? retry : 60)
  }
  if (res.status < 200 || res.status >= 300) throw new FeedRequestError(res.status)

  return res.json as ExportFeedResponse
}
