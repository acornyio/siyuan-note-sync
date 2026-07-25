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
  /** 自愈确认前的等待（默认真实 setTimeout）；注入以便测试免于真实延时。 */
  sleep?: (ms: number) => Promise<void>
}

/** attributes 表异步索引观测值约 1.5s，取 2s 留余量（见 Task 0 spike notes）。 */
const SELF_HEAL_SETTLE_MS = 2000

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
      let index = await this.deps.loadSyncedIndex()

      // 自愈：本地有游标但思源里一条已同步高亮都没有。两种可能：
      //  (a) 整库被清空/文档全删 → 该弃游标做全量重建；
      //  (b) 刚同步完 attributes 表还没索引（实测 ~1.5s 异步）→ **不该**自愈，否则会
      //      弃游标全量重取、又因索引仍空而无法去重 → 整库重复重建。
      // 用「等一下再查一次」区分：真清空则仍为空 → 自愈；只是索引滞后则会补齐 →
      // 改用补齐后的索引、保留游标、走正常增量（不重复）。
      if (cursor !== null && index.syncedHlIds.size === 0) {
        const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
        await sleep(SELF_HEAL_SETTLE_MS)
        if (aborted()) return { status: 'skipped' }
        index = await this.deps.loadSyncedIndex()
        if (index.syncedHlIds.size === 0) cursor = null
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
