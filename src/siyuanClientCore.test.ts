import { describe, expect, it } from 'vitest'
import { extractAppendedBlockId } from './siyuanClientCore'

describe('extractAppendedBlockId', () => {
  it('reads data[0].doOperations[0].id', () => {
    expect(extractAppendedBlockId([{ doOperations: [{ id: '20260722-abc' }] }])).toBe('20260722-abc')
  })

  it('throws on unexpected shape', () => {
    expect(() => extractAppendedBlockId([])).toThrow()
    expect(() => extractAppendedBlockId(null)).toThrow()
    expect(() => extractAppendedBlockId([{ doOperations: [] }])).toThrow()
  })
})
