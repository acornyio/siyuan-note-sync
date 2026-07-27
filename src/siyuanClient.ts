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
    async getIDsByHPath(notebook, path) {
      return (await post<string[] | null>('/api/filetree/getIDsByHPath', { notebook, path })) ?? []
    },
    async getHPathByID(id) {
      return (await post<string | null>('/api/filetree/getHPathByID', { id })) ?? ''
    },
    async getDocNotebookId(id) {
      // 块不存在时内核返回 code:-1，post 会抛——迁移中止、下次同步重试，不静默走错分支。
      return (await post<{ box?: string }>('/api/block/getBlockInfo', { id })).box ?? ''
    },
    async moveDocsByID(fromIDs, toID) {
      await post<unknown>('/api/filetree/moveDocsByID', { fromIDs, toID })
    },
    async removeDocByID(id) {
      await post<unknown>('/api/filetree/removeDocByID', { id })
    },
    async appendBlock(parentID, data) {
      const opData = await post<unknown>('/api/block/appendBlock', { parentID, dataType: 'markdown', data })
      return extractAppendedBlockId(opData)
    },
    async setBlockAttrs(id, attrs) {
      await post<unknown>('/api/attr/setBlockAttrs', { id, attrs })
    },
    async getBlockKramdown(id) {
      // 已删除/不存在的块返回 code:0 + data.kramdown:""（真机实测），不抛错。
      const data = await post<{ kramdown?: string }>('/api/block/getBlockKramdown', { id })
      return data?.kramdown ?? ''
    },
    async querySql<T>(stmt: string) {
      return post<T[]>('/api/query/sql', { stmt })
    },
    async forwardProxy(req): Promise<ForwardProxyResponse> {
      return post<ForwardProxyResponse>('/api/network/forwardProxy', {
        url: req.url,
        method: req.method,
        headers: req.headers,
        // 30s 而非 15s：真机在走代理时出现过 TLS 握手都来不及完成就超时。
        // 上层 retryTransient 还会重试，但先给单次请求足够的握手时间，少走冤枉路。
        timeout: req.timeout ?? 30000,
        contentType: 'application/json',
      })
    },
  }
}
