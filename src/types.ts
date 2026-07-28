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
  exportToken: string
  notebookId: string
  docFolderPath: string
  syncOnStartup: boolean
  pollIntervalMinutes: number
}

export type SyncStatus = 'idle' | 'syncing' | 'backoff' | 'auth_failed' | 'index_error'

/**
 * source→文档根块 id 的映射。跨同步存活在插件内存里，供 writeSource 无延迟解析文档；
 * 高亮级去重不在这里——它靠每文档实时 getBlockKramdown（见 siyuanGateway）。
 */
export interface SyncedIndex {
  /** sourceId -> 文档根块 id。 */
  sourceDocMap: Record<string, string>
}
