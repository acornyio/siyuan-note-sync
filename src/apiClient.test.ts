import { describe, expect, it, vi } from 'vitest'
import { AuthError, fetchFeedPage, FeedRequestError, type HttpResponse } from './apiClient'

const ok = (json: unknown): HttpResponse => ({ status: 200, json, headers: {} })

describe('fetchFeedPage', () => {
  it('builds feed URL with limit and encoded cursor', async () => {
    const http = vi.fn(async () => ok({ highlights: [], nextCursor: '', done: true }))
    await fetchFeedPage(http, { serverUrl: 'https://api.acorny.io/', token: 'tk', cursor: 'a b/c' })
    expect(http).toHaveBeenCalledWith({
      url: 'https://api.acorny.io/api/v1/exports/highlights/feed?limit=100&cursor=a%20b%2Fc',
      headers: { Authorization: 'Token tk' },
    })
  })

  it('401 → AuthError', async () => {
    const http = vi.fn(async (): Promise<HttpResponse> => ({ status: 401, json: null, headers: {} }))
    await expect(fetchFeedPage(http, { serverUrl: 'x', token: 't', cursor: null })).rejects.toBeInstanceOf(AuthError)
  })

  it('429 reads Retry-After header', async () => {
    const http = vi.fn(async (): Promise<HttpResponse> => ({ status: 429, json: null, headers: { 'retry-after': '42' } }))
    await expect(fetchFeedPage(http, { serverUrl: 'x', token: 't', cursor: null }))
      .rejects.toMatchObject({ retryAfterSeconds: 42 })
  })

  it('429 falls back to body.retryAfter then 60', async () => {
    const http = vi.fn(async (): Promise<HttpResponse> => ({ status: 429, json: { retryAfter: 7 }, headers: {} }))
    await expect(fetchFeedPage(http, { serverUrl: 'x', token: 't', cursor: null }))
      .rejects.toMatchObject({ retryAfterSeconds: 7 })
  })

  it('other non-2xx → FeedRequestError', async () => {
    const http = vi.fn(async (): Promise<HttpResponse> => ({ status: 500, json: null, headers: {} }))
    await expect(fetchFeedPage(http, { serverUrl: 'x', token: 't', cursor: null })).rejects.toBeInstanceOf(FeedRequestError)
  })
})
