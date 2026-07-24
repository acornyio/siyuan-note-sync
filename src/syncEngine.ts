import type {
  AcornySettings, ExportFeedHighlight, ExportFeedResponse, ExportFeedSource, PluginState, SyncedIndex, SyncStatus,
} from './types'
import { AuthError, RateLimitError } from './apiClient'
import { connectionId } from './connection'

export type SyncResult =
  | { status: 'completed'; pages: number; added: number }
  | { status: 'skipped' }
  | { status: 'auth_failed' }
  | { status: 'backoff'; retryAfterSeconds: number }

export interface SyncEngineDeps {
  getSettings: () => AcornySettings
  loadState: () => Promise<PluginState>
  saveState: (state: PluginState) => Promise<void>
  /** 一次同步开始时拉取思源 SQL 的全量已同步索引（思源即真相）。 */
  loadSyncedIndex: () => Promise<SyncedIndex>
  fetchPage: (req: { serverUrl: string; token: string; cursor: string | null }) => Promise<ExportFeedResponse>
  writeSource: (
    source: ExportFeedSource,
    highlights: ExportFeedHighlight[],
    index: SyncedIndex,
  ) => Promise<{ docId: string; added: number }>
  onStatus: (status: SyncStatus, detail?: string) => void
  /** 返回 true（插件被禁用/重载）时，drain 在下次 fetch/write 前停止且不持久化状态。 */
  isAborted?: () => boolean
}

const MAX_PAGES = 10_000 // 防服务端 bug 无限翻页的安全阀

export class SyncEngine {
  private running = false
  constructor(private readonly deps: SyncEngineDeps) {}

  async sync(): Promise<SyncResult> {
    if (this.running) return { status: 'skipped' }
    this.running = true
    this.deps.onStatus('syncing')
    try {
      // 同步开始时快照连接，保证本次 drain 每页都用同一 server/token，
      // 即使用户中途改了设置。
      const settings = this.deps.getSettings()
      const { serverUrl, exportToken: token } = settings
      const conn = connectionId(serverUrl, token)

      const aborted = this.deps.isAborted ?? (() => false)

      const state = await this.deps.loadState()
      // 持久化游标属于另一 server/账号时弃用——重放外来游标可能静默漏数据。
      const sameConnection = state.connectionId === conn
      let cursor = sameConnection ? state.lastCursor : null

      // 去重索引一律来自思源 SQL（不依赖本地缓存）：跨账号也安全，因为块属性即真相。
      const index = await this.deps.loadSyncedIndex()

      // 自愈：本地有游标（声称同步过）但思源里一条已同步高亮都没有（文档被删 / 库被清），
      // 说明游标已与实际脱节。弃用游标做全量重取，避免「删文档后再同步什么都不回来」。
      // 已存在的块仍由 SQL 去重跳过，不会重复。
      if (cursor !== null && index.syncedHlIds.size === 0) {
        cursor = null
      }

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

      // 绝不代表已废弃实例持久化——那会用陈旧快照覆盖活实例的状态。
      if (aborted()) return { status: 'skipped' }
      await this.deps.saveState({ lastCursor: cursor, connectionId: conn })
      this.deps.onStatus('idle')
      return { status: 'completed', pages, added }
    } catch (error) {
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
