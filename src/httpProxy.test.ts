import { describe, expect, it, vi } from 'vitest'
import { createForwardProxyHttp, type ForwardProxyResponse } from './httpProxy'

describe('createForwardProxyHttp', () => {
  it('maps request headers to forwardProxy [{K:V}] array and GET method', async () => {
    const fp = vi.fn(async (): Promise<ForwardProxyResponse> => ({ status: 200, body: '{}', headers: {} }))
    const http = createForwardProxyHttp(fp)
    await http({ url: 'https://api.acorny.io/x', headers: { Authorization: 'Token tk' } })
    expect(fp).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.acorny.io/x',
      method: 'GET',
      headers: [{ Authorization: 'Token tk' }],
    }))
  })

  it('parses JSON body and lowercases response header keys', async () => {
    const fp = async (): Promise<ForwardProxyResponse> => ({ status: 200, body: '{"a":1}', headers: { 'Retry-After': '9' } })
    const res = await createForwardProxyHttp(fp)({ url: 'u', headers: {} })
    expect(res).toEqual({ status: 200, json: { a: 1 }, headers: { 'retry-after': '9' } })
  })

  it('passes non-2xx status through with json=null on unparseable body', async () => {
    const fp = async (): Promise<ForwardProxyResponse> => ({ status: 429, body: 'rate limited', headers: {} })
    const res = await createForwardProxyHttp(fp)({ url: 'u', headers: {} })
    expect(res).toEqual({ status: 429, json: null, headers: {} })
  })
})
