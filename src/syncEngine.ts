import type {
  AcornySettings, ExportFeedHighlight, ExportFeedResponse, ExportFeedSource, SyncedIndex, SyncStatus,
} from './types'
import { AuthError, RateLimitError } from './apiClient'
import { SyncIndexError } from './siyuanGateway'

export type SyncResult =
  | { status: 'completed'; pages: number; added: number }
  | { status: 'skipped' }
  | { status: 'auth_failed' }
  | { status: 'backoff'; retryAfterSeconds: number }
  /** 已同步索引不可信（截断/熔断）。**不重试**——重试只会继续制造重复文档。 */
  | { status: 'index_error'; reason: string }

export interface SyncEngineDeps {
  getSettings: () => AcornySettings
  /** 一次同步开始时拉取思源 SQL 的全量已同步索引（思源即真相）。 */
  loadSyncedIndex: () => Promise<SyncedIndex>
  fetchPage: (req: { serverUrl: string; token: string; cursor: string | null }) => Promise<ExportFeedResponse>
  writeSource: (
    source: ExportFeedSource,
    highlights: ExportFeedHighlight[],
    index: SyncedIndex,
  ) => Promise<{ docId: string; added: number }>
  onStatus: (status: SyncStatus, detail?: string) => void
  /** 返回 true（插件被禁用/重载）时，drain 在下次 fetch/write 前停止。 */
  isAborted?: () => boolean
}

const MAX_PAGES = 10_000 // 防服务端 bug 无限翻页的安全阀

export class SyncEngine {
  private running = false
  constructor(private readonly deps: SyncEngineDeps) {}

  /**
   * 全量对账同步：每次都从头（cursor=null）拉完整 feed，按思源 SQL 索引去重——
   * 已存在的高亮跳过、索引里缺失的（例如用户删了文档）重新建。故删除可自愈，
   * 且没有需要持久化的游标。cursor 仅作本次分页游标，不跨同步保存。
   */
  async sync(): Promise<SyncResult> {
    if (this.running) return { status: 'skipped' }
    this.running = true
    this.deps.onStatus('syncing')
    try {
      // 同步开始时快照连接，保证本次 drain 每页都用同一 server/token，即使中途改设置。
      const { serverUrl, exportToken: token } = this.deps.getSettings()
      const aborted = this.deps.isAborted ?? (() => false)

      // 去重索引一律来自思源 SQL（块属性即真相），不依赖任何本地缓存。
      const index = await this.deps.loadSyncedIndex()

      let cursor: string | null = null // 每次都从头全量对账
      let pages = 0
      let added = 0

      for (;;) {
        if (aborted()) return { status: 'skipped' }
        const page = await this.deps.fetchPage({ serverUrl, token, cursor })
        pages += 1
        for (const [, group] of groupBySource(page.highlights)) {
          if (aborted()) return { status: 'skipped' }
          const result = await this.deps.writeSource(group.source, group.highlights, index)
          added += result.added
        }
        cursor = page.nextCursor
        if (page.done) break
        if (pages >= MAX_PAGES) break
      }

      if (aborted()) return { status: 'skipped' }
      this.deps.onStatus('idle')
      return { status: 'completed', pages, added }
    } catch (error) {
      // 索引类错误必须先于通用 backoff 判断：它不是"稍后重试就能好"的瞬时故障，
      // 继续重试等于继续重复建档，只能停下来让用户看到。
      if (error instanceof SyncIndexError) {
        console.error('[Acorny] Sync aborted, synced index not trustworthy:', error)
        this.deps.onStatus('index_error', error.message)
        return { status: 'index_error', reason: error.message }
      }
      if (error instanceof AuthError) {
        this.deps.onStatus('auth_failed', 'Export token rejected — check Settings.')
        return { status: 'auth_failed' }
      }
      if (error instanceof RateLimitError) {
        this.deps.onStatus('backoff', `Rate limited, retry in ${error.retryAfterSeconds}s`)
        return { status: 'backoff', retryAfterSeconds: error.retryAfterSeconds }
      }
      console.error('[Acorny] Unexpected sync error:', error)
      this.deps.onStatus('backoff', error instanceof Error ? error.message : 'Sync failed')
      return { status: 'backoff', retryAfterSeconds: 60 }
    } finally {
      this.running = false
    }
  }
}

function groupBySource(
  highlights: ExportFeedHighlight[],
): Map<string, { source: ExportFeedSource; highlights: ExportFeedHighlight[] }> {
  const groups = new Map<string, { source: ExportFeedSource; highlights: ExportFeedHighlight[] }>()
  for (const h of highlights) {
    const existing = groups.get(h.source.id)
    if (existing) existing.highlights.push(h)
    else groups.set(h.source.id, { source: h.source, highlights: [h] })
  }
  return groups
}
