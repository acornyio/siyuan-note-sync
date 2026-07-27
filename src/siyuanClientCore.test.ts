import { describe, expect, it } from 'vitest'
import { extractAppendedBlockId, parseDocSourceId, parseSyncedHighlightIds, sqlLiteral } from './siyuanClientCore'
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

describe('parseSyncedHighlightIds', () => {
  // 真机 getBlockKramdown 形态（Task 0 spike）：高亮块尾行 IAL 带 custom-acorny-id，
  // 文档根块 IAL 带 custom-acorny-source-id。
  it('extracts custom-acorny-id values from a document kramdown', () => {
    const kramdown = [
      '- {: id="20260726-a"}body one',
      '{: custom-acorny-id="hl-1" id="20260726-c" updated="1"}',
      '',
      '- {: id="20260726-d"}body two',
      '{: custom-acorny-id="hl-2" id="20260726-e"}',
      '{: custom-acorny-source-id="src-1" id="20260726-doc" type="doc"}',
    ].join('\n')
    expect([...parseSyncedHighlightIds(kramdown)].sort()).toEqual(['hl-1', 'hl-2'])
  })

  it('does NOT capture custom-acorny-source-id (the doc anchor) as a highlight id', () => {
    expect(parseSyncedHighlightIds('{: custom-acorny-source-id="src-1" id="d"}').size).toBe(0)
  })

  it('returns an empty set for empty (deleted-doc) kramdown', () => {
    expect(parseSyncedHighlightIds('').size).toBe(0)
  })
})

describe('parseDocSourceId', () => {
  // 真机形态（2026-07-26 实测）：**空文档**的 kramdown 也非空——它含文档根块 IAL。
  // 这正是能用「kramdown 为空串」判定文档已删除、又不会误伤空文档的依据。
  it('reads the anchor from a freshly created, contentless doc', () => {
    const kramdown = '{: id="20260726232811-dplm612" updated="20260726232811"}\n\n'
      + '{: custom-acorny-source-id="probe-empty" id="20260726232811-18igud2" type="doc"}'
    expect(parseDocSourceId(kramdown)).toBe('probe-empty')
  })

  it('reads the anchor from a doc that already holds highlights', () => {
    const kramdown = '- body\n{: custom-acorny-id="hl-1"}\n{: custom-acorny-source-id="src-9" type="doc"}'
    expect(parseDocSourceId(kramdown)).toBe('src-9')
  })

  it('returns null for a deleted doc (empty kramdown) and for an unanchored doc', () => {
    expect(parseDocSourceId('')).toBeNull()
    expect(parseDocSourceId('- just some user text\n{: id="x"}')).toBeNull()
  })

  it('does not mistake a highlight id for the doc anchor', () => {
    expect(parseDocSourceId('- body\n{: custom-acorny-id="hl-1"}')).toBeNull()
  })
})

describe('sqlLiteral', () => {
  it('leaves ordinary ids untouched', () => {
    expect(sqlLiteral('847a455a-7a2a-4676-b6bf-46a9538d8b5d')).toBe('847a455a-7a2a-4676-b6bf-46a9538d8b5d')
  })

  it('doubles single quotes so the value cannot terminate the literal', () => {
    expect(sqlLiteral("a'b")).toBe("a''b")
    expect(sqlLiteral("' OR 1=1 --")).toBe("'' OR 1=1 --")
  })

  it('does not treat backslash as an escape (SQLite has no backslash escapes)', () => {
    expect(sqlLiteral("a\\'b")).toBe("a\\''b")
  })
})
