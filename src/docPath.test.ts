import { describe, expect, it } from 'vitest'
import { buildDocHPath } from './docPath'

describe('buildDocHPath', () => {
  it('joins folder + sanitized title (clean, no suffix)', () => {
    expect(buildDocHPath('/Acorny', 'Deep Work')).toBe('/Acorny/Deep Work')
  })

  it('replaces path-illegal chars and collapses whitespace in the title', () => {
    // 每个非法字符各替一个 '-'（不折叠连续 '-'，与 Obsidian 版一致）：'*?' → '--'
    expect(buildDocHPath('/Acorny', 'a/b:c*?  d')).toBe('/Acorny/a-b-c-- d')
  })

  it('empty/whitespace title falls back to Untitled', () => {
    expect(buildDocHPath('/Acorny', '   ')).toBe('/Acorny/Untitled')
  })

  it('normalizes folder path (leading slash, no trailing slash)', () => {
    expect(buildDocHPath('Acorny/', 'X')).toBe('/Acorny/X')
  })

  it('strips control chars / newlines from title', () => {
    expect(buildDocHPath('/Acorny', 'line1\nline2')).toBe('/Acorny/line1 line2')
  })

  it('is deterministic run-to-run', () => {
    expect(buildDocHPath('/Acorny', 'Same Title')).toBe(buildDocHPath('/Acorny', 'Same Title'))
  })
})
