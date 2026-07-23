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
  })
})
