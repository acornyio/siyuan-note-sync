import { describe, expect, it } from 'vitest'
import { nextAutoDelayMs } from './scheduler'

describe('nextAutoDelayMs', () => {
  it('auth_failed → null (pause auto)', () => {
    expect(nextAutoDelayMs({ status: 'auth_failed' }, 5)).toBeNull()
  })

  it('backoff → retryAfterSeconds in ms', () => {
    expect(nextAutoDelayMs({ status: 'backoff', retryAfterSeconds: 30 }, 5)).toBe(30_000)
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
})
