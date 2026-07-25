/** 镜像 Acorny server /exports/highlights/feed 响应。 */
export interface ExportFeedSource {
  id: string
  title: string
  author: string | null
  canonicalUrl: string
  type: string
}

export interface ExportFeedHighlight {
  id: string
  quote: string
  quoteMarkdown: string | null
  note: string | null
  tags: string[]
  updatedAt: string
  source: ExportFeedSource
}

export interface ExportFeedResponse {
  highlights: ExportFeedHighlight[]
  nextCursor: string
  done: boolean
}

/** 用户设置，经思源 saveData 持久化。 */
export interface AcornySettings {
  serverUrl: string
  exportToken: string
  notebookId: string
  docFolderPath: string
  syncOnStartup: boolean
  pollIntervalMinutes: number
}

/**
 * 插件本地状态。仅存游标与连接身份——「已同步什么」以思源块属性为准（思源即真相）。
 * connectionId 变化则弃用 cursor，防跨账号游标重放漏数据。
 */
export interface PluginState {
  lastCursor: string | null
  connectionId: string | null
}

export type SyncStatus = 'idle' | 'syncing' | 'backoff' | 'auth_failed'

/** 一次同步开始时从思源 SQL 拉出的全量已同步索引。 */
export interface SyncedIndex {
  /** sourceId -> 文档根块 id。 */
  sourceDocMap: Record<string, string>
  /** 已同步高亮 id 集合。 */
  syncedHlIds: Set<string>
}
