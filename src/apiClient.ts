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

export interface FetchFeedOptions {
  serverUrl: string
  token: string
  cursor: string | null
  limit?: number
}

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
