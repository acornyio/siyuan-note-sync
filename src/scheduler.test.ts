import { describe, expect, it } from 'vitest'
import { isInteractiveTrigger, mayRunSync, nextAutoDelayMs, type SyncTrigger } from './scheduler'

describe('mayRunSync', () => {
  const AUTO: SyncTrigger[] = ['startup', 'timer', 'settings']

  it('blocks every automatic trigger until the user has confirmed the destination once', () => {
    // 目标笔记本默认就是列表第一个、文件夹默认 /Acorny——用户还没确认过这套目的地，
    // 却已经有三条路径会自动往笔记里写。首次写入必须由用户显式发起。
    for (const t of AUTO) expect(mayRunSync(t, false)).toBe(false)
  })

  it('always allows a manual sync — that is how the destination gets confirmed', () => {
    expect(mayRunSync('manual', false)).toBe(true)
    expect(mayRunSync('manual', true)).toBe(true)
  })

  it('allows every trigger once the destination is confirmed', () => {
    for (const t of AUTO) expect(mayRunSync(t, true)).toBe(true)
  })
})

describe('isInteractiveTrigger', () => {
  it('treats manual and settings-save as interactive (user is watching → give feedback)', () => {
    expect(isInteractiveTrigger('manual')).toBe(true)
    expect(isInteractiveTrigger('settings')).toBe(true)
  })

  it('treats startup and timer as silent (no toast storms in the background)', () => {
    expect(isInteractiveTrigger('startup')).toBe(false)
    expect(isInteractiveTrigger('timer')).toBe(false)
  })
})

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
