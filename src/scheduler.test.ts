import { describe, expect, it } from 'vitest'
import {
  isInteractiveTrigger, mayRunSync, nextAutoDelayMs, pickNotebookValue, readInitedFlag, type SyncTrigger,
} from './scheduler'

describe('mayRunSync', () => {
  const AUTO: SyncTrigger[] = ['startup', 'timer', 'settings']

  it('blocks every automatic trigger until initial setup is complete', () => {
    // 目标笔记本默认就是列表第一个、文件夹默认 /Acorny——用户还没确认过这套目的地，
    // 却已经有三条路径会自动往笔记里写。首次写入必须由用户显式发起。
    // 注意 syncOnStartup 本身仍默认 true：它是"用户想不想开机同步"的偏好，
    // 而 inited 是"初始化完没完"的事实，两者不该混成一个开关。
    for (const t of AUTO) expect(mayRunSync(t, false)).toBe(false)
  })

  it('always allows a manual sync — that is how initialization completes', () => {
    expect(mayRunSync('manual', false)).toBe(true)
    expect(mayRunSync('manual', true)).toBe(true)
  })

  it('allows every trigger once initialization is complete', () => {
    for (const t of AUTO) expect(mayRunSync(t, true)).toBe(true)
  })
})

describe('pickNotebookValue', () => {
  it('keeps the persisted选择 while the notebook list has not loaded yet', () => {
    // 设置面板会先用空缓存渲染一次，再等 lsNotebooks 回来重渲染。第一次渲染时
    // <select> 里只有占位项，若此刻按「所见即所存」回写，就会把持久化的笔记本清成空——
    // 界面显示"未选择"，而用户一点保存就真的丢了配置。
    expect(pickNotebookValue([], 'nb-1')).toBe('nb-1')
  })

  it('keeps the selection when it is present in the loaded list', () => {
    expect(pickNotebookValue(['nb-1', 'nb-2'], 'nb-2')).toBe('nb-2')
  })

  it('clears a selection whose notebook no longer exists (what is shown is what gets saved)', () => {
    expect(pickNotebookValue(['nb-1'], 'gone')).toBe('')
  })

  it('stays empty when nothing was selected — the placeholder must not be replaced by the first notebook', () => {
    expect(pickNotebookValue(['nb-1', 'nb-2'], '')).toBe('')
  })
})

describe('readInitedFlag', () => {
  it('is false on a fresh install (nothing persisted yet)', () => {
    expect(readInitedFlag({})).toBe(false)
    expect(readInitedFlag(null)).toBe(false)
  })

  it('reads the persisted flag', () => {
    expect(readInitedFlag({ inited: true })).toBe(true)
    expect(readInitedFlag({ inited: false })).toBe(false)
  })

  it('accepts the previous field name so upgrading users are not locked out again', () => {
    // 该标记先前叫 destinationConfirmed。若升级后读不到，已经在正常同步的老用户
    // 会被重新上锁、自动同步静默停摆——属于升级即回归。
    expect(readInitedFlag({ destinationConfirmed: true })).toBe(true)
  })

  it('prefers the new field when both are present', () => {
    expect(readInitedFlag({ inited: false, destinationConfirmed: true })).toBe(false)
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
