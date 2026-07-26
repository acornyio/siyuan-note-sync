import { describe, expect, it } from 'vitest'
import { nextAutoDelayMs } from './scheduler'

describe('nextAutoDelayMs', () => {
  it('auth_failed → null (pause auto)', () => {
    expect(nextAutoDelayMs({ status: 'auth_failed' }, 5)).toBeNull()
  })

  it('backoff → retryAfterSeconds in ms when auto-sync enabled', () => {
    expect(nextAutoDelayMs({ status: 'backoff', retryAfterSeconds: 30 }, 5)).toBe(30_000)
  })

  it('backoff → null when auto-sync disabled (0), no background retry', () => {
    expect(nextAutoDelayMs({ status: 'backoff', retryAfterSeconds: 30 }, 0)).toBeNull()
  })

  it('completed → interval in ms when polling enabled', () => {
    expect(nextAutoDelayMs({ status: 'completed', pages: 1, added: 2 }, 5)).toBe(300_000)
  })

  it('completed → null when polling disabled', () => {
    expect(nextAutoDelayMs({ status: 'completed', pages: 1, added: 2 }, 0)).toBeNull()
  })

  it('skipped → interval (or null)', () => {
    expect(nextAutoDelayMs({ status: 'skipped' }, 0)).toBeNull()
  })

  it('index_error → null even with polling on (stop, do not retry into duplicate docs)', () => {
    // 索引不可信时重试只会继续制造重复文档，必须停到用户手动介入。
    expect(nextAutoDelayMs({ status: 'index_error', reason: 'seed_truncated' }, 60)).toBeNull()
  })
})
