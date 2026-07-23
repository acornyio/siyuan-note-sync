import { fetchSyncPost } from 'siyuan'
import type { ForwardProxyResponse } from './httpProxy'
import { extractAppendedBlockId, type KernelResponse, type Notebook, type SiyuanClient } from './siyuanClientCore'

export type { Notebook, SiyuanClient } from './siyuanClientCore'
export { extractAppendedBlockId } from './siyuanClientCore'

async function post<T>(url: string, payload: unknown): Promise<T> {
  const res = (await fetchSyncPost(url, payload)) as KernelResponse<T>
  if (res.code !== 0) throw new Error(`${url} failed (code ${res.code}): ${res.msg}`)
  return res.data
}

/**
 * 真正调用思源 kernel 的客户端工厂。导入 'siyuan'，只能在插件/构建环境运行（webpack
 * externals 提供 siyuan），不参与 vitest 单测；纯逻辑见 siyuanClientCore.ts。
 * 所有 endpoint 走前端会话鉴权，无需手动传 token。
 */
export function createSiyuanClient(): SiyuanClient {
  return {
    async lsNotebooks() {
      const data = await post<{ notebooks: Notebook[] }>('/api/notebook/lsNotebooks', {})
      return data.notebooks.map((n) => ({ id: n.id, name: n.name }))
    },
    async createDocWithMd(notebook, path, markdown) {
      return post<string>('/api/filetree/createDocWithMd', { notebook, path, markdown })
    },
    async appendBlock(parentID, data) {
      const opData = await post<unknown>('/api/block/appendBlock', { parentID, dataType: 'markdown', data })
      return extractAppendedBlockId(opData)
    },
    async setBlockAttrs(id, attrs) {
      await post<unknown>('/api/attr/setBlockAttrs', { id, attrs })
    },
    async querySql<T>(stmt: string) {
      return post<T[]>('/api/query/sql', { stmt })
    },
    async forwardProxy(req): Promise<ForwardProxyResponse> {
      return post<ForwardProxyResponse>('/api/network/forwardProxy', {
        url: req.url,
        method: req.method,
        headers: req.headers,
        timeout: req.timeout ?? 15000,
        contentType: 'application/json',
      })
    },
  }
}
