import { describe, expect, it } from 'vitest'
import { extractAppendedBlockId } from './siyuanClientCore'
import appendBlockFixture from './__fixtures__/kernel/appendBlock.json'

describe('extractAppendedBlockId', () => {
  it('reads data[0].doOperations[0].id', () => {
    expect(extractAppendedBlockId([{ doOperations: [{ id: '20260722-abc' }] }])).toBe('20260722-abc')
  })

  it('throws on unexpected shape', () => {
    expect(() => extractAppendedBlockId([])).toThrow()
    expect(() => extractAppendedBlockId(null)).toThrow()
    expect(() => extractAppendedBlockId([{ doOperations: [] }])).toThrow()
  })

  it('extracts the block id from the REAL Task 0 appendBlock response (IAL on NodeList)', () => {
    const id = extractAppendedBlockId(appendBlockFixture.data)
    expect(id).toBe('20260723221941-y0cgfsy')
    // 断言 fixture 确实是"IAL 落在 NodeList 上"的真实形态，防它退化成不含 IAL 的普通块而仍通过
    const opHtml = (appendBlockFixture.data as Array<{ doOperations: Array<{ data: string }> }>)[0].doOperations[0].data
    expect(opHtml).toContain('data-type="NodeList"')
    expect(opHtml).toContain('custom-acorny-id="probe-1"')
  })
})
