import type { ForwardProxyFn } from './httpProxy'

// 纯逻辑核心：不导入 'siyuan'（该包无运行时 JS，仅类型），因此本文件可在 vitest 下单测，
// 也可被 siyuanGateway 以 `import type` 引用而不牵入 siyuan。真正调用 kernel 的工厂在
// siyuanClient.ts。

export interface Notebook {
  id: string
  name: string
}

export interface SiyuanClient {
  lsNotebooks(): Promise<Notebook[]>
  /** 建文档，返回文档（根块）id。同 hpath 幂等，不覆盖已有内容。 */
  createDocWithMd(notebookId: string, hpath: string, markdown: string): Promise<string>
  /** 追加块（markdown 可含内联 IAL），返回新块 id。 */
  appendBlock(parentId: string, markdown: string): Promise<string>
  setBlockAttrs(blockId: string, attrs: Record<string, string>): Promise<void>
  querySql<T>(sql: string): Promise<T[]>
  forwardProxy: ForwardProxyFn
}

export interface KernelResponse<T> {
  code: number
  msg: string
  data: T
}

/** 从 appendBlock 事务响应中取新块 id：data[0].doOperations[0].id。 */
export function extractAppendedBlockId(data: unknown): string {
  const op = Array.isArray(data)
    ? (data[0] as { doOperations?: Array<{ id?: string }> } | undefined)?.doOperations?.[0]
    : undefined
  const id = op?.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`appendBlock: 无法从响应解析新块 id: ${JSON.stringify(data)}`)
  }
  return id
}
