import { describe, expect, it, vi } from 'vitest'
import { createForwardProxyHttp, type ForwardProxyResponse } from './httpProxy'
import forwardProxyFixture from './__fixtures__/kernel/forwardProxy.json'

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

  it('parses JSON body and lowercases + flattens array-valued response header keys', async () => {
    // 真机形态：headers 是数组值（Record<string, string[]>），取首值扁平化
    const fp = async (): Promise<ForwardProxyResponse> => ({ status: 200, body: '{"a":1}', headers: { 'Retry-After': ['9'] } })
    const res = await createForwardProxyHttp(fp)({ url: 'u', headers: {} })
    expect(res).toEqual({ status: 200, json: { a: 1 }, headers: { 'retry-after': '9' } })
  })

  it('passes non-2xx status through with json=null on unparseable body', async () => {
    const fp = async (): Promise<ForwardProxyResponse> => ({ status: 429, body: 'rate limited', headers: {} })
    const res = await createForwardProxyHttp(fp)({ url: 'u', headers: {} })
    expect(res).toEqual({ status: 429, json: null, headers: {} })
  })
})

describe('createForwardProxyHttp (real Task 0 fixture)', () => {
  it('maps the REAL forwardProxy data shape: status passthrough + lowercased flattened header keys', async () => {
    const data = forwardProxyFixture.data as ForwardProxyResponse
    const res = await createForwardProxyHttp(async () => data)({ url: 'u', headers: {} })
    expect(res.status).toBe(503)
    // 键全小写、值扁平为 string（真机为数组）
    for (const [k, v] of Object.entries(res.headers)) {
      expect(k).toBe(k.toLowerCase())
      expect(typeof v).toBe('string')
    }
    expect(res.headers['content-type']).toBe('text/html')
    // body 是 HTML，非 JSON → json 为 null
    expect(res.json).toBeNull()
  })
})
