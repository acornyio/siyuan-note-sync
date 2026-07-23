import { describe, expect, it } from 'vitest'
import { buildDocHPath } from './docPath'

describe('buildDocHPath', () => {
  it('joins folder + sanitized title + full sourceId suffix', () => {
    expect(buildDocHPath('/Acorny', 'Deep Work', 'uuid-1')).toBe('/Acorny/Deep Work-uuid-1')
  })

  it('two distinct sources sharing the SAME title get DISTINCT paths (full id, no truncation collision)', () => {
    // 关键回归：即便前若干位相同，完整 id 后缀也一定区分——slice(0,8) 方案会在此失败（Codex #1）。
    const a = buildDocHPath('/Acorny', 'Atomic Habits', '12345678-aaaa-1111')
    const b = buildDocHPath('/Acorny', 'Atomic Habits', '12345678-bbbb-2222')
    expect(a).toBe('/Acorny/Atomic Habits-12345678-aaaa-1111')
    expect(b).toBe('/Acorny/Atomic Habits-12345678-bbbb-2222')
    expect(a).not.toBe(b)
  })

  it('same sourceId is deterministic run-to-run', () => {
    expect(buildDocHPath('/Acorny', 'X', 'id-1')).toBe(buildDocHPath('/Acorny', 'X', 'id-1'))
  })

  it('replaces path-illegal chars and collapses whitespace in the title part', () => {
    // 每个非法字符各替一个 '-'（不折叠连续 '-'，与 Obsidian 版一致）：'*?' → '--'
    expect(buildDocHPath('/Acorny', 'a/b:c*?  d', 'id-1')).toBe('/Acorny/a-b-c-- d-id-1')
  })

  it('sanitizes path-illegal chars in the sourceId suffix too (defensive)', () => {
    expect(buildDocHPath('/Acorny', 'X', 'a/b:c')).toBe('/Acorny/X-a-b-c')
  })

  it('empty/whitespace title falls back to Untitled', () => {
    expect(buildDocHPath('/Acorny', '   ', 'id-1')).toBe('/Acorny/Untitled-id-1')
  })

  it('normalizes folder path (leading slash, no trailing slash)', () => {
    expect(buildDocHPath('Acorny/', 'X', 'id-1')).toBe('/Acorny/X-id-1')
  })

  it('strips control chars / newlines from title', () => {
    expect(buildDocHPath('/Acorny', 'line1\nline2', 'id-1')).toBe('/Acorny/line1 line2-id-1')
  })
})
