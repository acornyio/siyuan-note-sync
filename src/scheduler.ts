import type { SyncResult } from './syncEngine'

/**
 * 决定下次「自动」同步的延迟：
 * - auth_failed → null（暂停自动，直到一次手动同步重新启用）
 * - backoff     → retryAfterSeconds（近端重试；成功后恢复常规节奏）
 * - completed/skipped → 常规 interval（interval 关闭则 null）
 */
export function nextAutoDelayMs(result: SyncResult, pollIntervalMinutes: number): number | null {
  const interval = pollIntervalMinutes > 0 ? pollIntervalMinutes * 60_000 : null
  switch (result.status) {
    case 'auth_failed':
      return null
    case 'backoff':
      // 自动同步关闭（0=关闭，interval 为 null）时不做任何后台重试，尊重设置语义；
      // 仅在自动同步开启时才安排 429/异常后的近端重试。
      return interval === null ? null : result.retryAfterSeconds * 1000
    case 'completed':
    case 'skipped':
      return interval
  }
}
