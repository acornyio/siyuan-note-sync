import { describe, expect, it, vi } from 'vitest'
import {
  AuthError, fetchFeedPage, FeedRequestError, isTransientFeedError, RateLimitError,
  retryTransient, type HttpResponse,
} from './apiClient'

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

describe('isTransientFeedError', () => {
  it('treats proxy/network failures as transient (TLS handshake timeout is the real-world case)', () => {
    // 真机报错：/api/network/forwardProxy failed (code 8): ... net/http: TLS handshake timeout
    expect(isTransientFeedError(new Error('forwardProxy failed (code 8): net/http: TLS handshake timeout')))
      .toBe(true)
  })

  it('never retries an auth failure — the token will not fix itself', () => {
    expect(isTransientFeedError(new AuthError())).toBe(false)
  })

  it('never retries a rate limit — the engine already schedules its own backoff', () => {
    expect(isTransientFeedError(new RateLimitError(30))).toBe(false)
  })

  it('retries 5xx and 408 but not other 4xx', () => {
    expect(isTransientFeedError(new FeedRequestError(500))).toBe(true)
    expect(isTransientFeedError(new FeedRequestError(502))).toBe(true)
    expect(isTransientFeedError(new FeedRequestError(408))).toBe(true)
    expect(isTransientFeedError(new FeedRequestError(400))).toBe(false)
    expect(isTransientFeedError(new FeedRequestError(404))).toBe(false)
  })
})

describe('retryTransient', () => {
  const noSleep = async () => {}

  it('does not retry a call that succeeds first time', async () => {
    let calls = 0
    const res = await retryTransient(async () => { calls += 1; return 'ok' }, { sleep: noSleep })
    expect([res, calls]).toEqual(['ok', 1])
  })

  it('recovers from a transient failure instead of failing the whole sync', async () => {
    // 一页翻页失败就整轮同步作废、退避 60s——10 页里抖一次就前功尽弃。
    let calls = 0
    const res = await retryTransient(async () => {
      calls += 1
      if (calls < 3) throw new Error('net/http: TLS handshake timeout')
      return 'ok'
    }, { sleep: noSleep })
    expect([res, calls]).toEqual(['ok', 3])
  })

  it('gives up after the configured attempts and rethrows the last error', async () => {
    let calls = 0
    const boom = new Error('net/http: TLS handshake timeout')
    await expect(retryTransient(async () => { calls += 1; throw boom }, { attempts: 3, sleep: noSleep }))
      .rejects.toBe(boom)
    expect(calls).toBe(3)
  })

  it('rethrows a non-transient error immediately, without burning attempts', async () => {
    let calls = 0
    await expect(retryTransient(async () => { calls += 1; throw new AuthError() }, { sleep: noSleep }))
      .rejects.toBeInstanceOf(AuthError)
    expect(calls).toBe(1)
  })

  it('stops retrying once aborted (plugin unloaded mid-sync)', async () => {
    let calls = 0
    let aborted = false
    await expect(retryTransient(async () => {
      calls += 1
      aborted = true
      throw new Error('net/http: TLS handshake timeout')
    }, { sleep: noSleep, isAborted: () => aborted })).rejects.toThrow('TLS handshake')
    expect(calls).toBe(1)
  })

  it('backs off between attempts rather than hammering immediately', async () => {
    const slept: number[] = []
    await expect(retryTransient(
      async () => { throw new Error('net/http: TLS handshake timeout') },
      { attempts: 3, sleep: async (ms) => { slept.push(ms) } },
    )).rejects.toThrow()
    expect(slept).toEqual([1000, 2000]) // 每次重试前等一次，最后一次失败不再等
  })
})
