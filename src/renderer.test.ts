import { describe, expect, it } from 'vitest'
import { ialLine, renderHighlightBlock, renderHighlightContent } from './renderer'
import type { ExportFeedHighlight } from './types'

const base: ExportFeedHighlight = {
  id: 'hl1',
  quote: 'the quote',
  quoteMarkdown: null,
  note: null,
  tags: [],
  updatedAt: '2026-07-22T00:00:00Z',
  source: { id: 's1', title: 'T', author: null, canonicalUrl: '', type: 'article' },
}

describe('renderer', () => {
  it('renders a list item from quote', () => {
    expect(renderHighlightContent(base)).toBe('* the quote')
  })

  it('prefers quoteMarkdown and collapses internal newlines', () => {
    expect(renderHighlightContent({ ...base, quote: 'x', quoteMarkdown: 'a\n  b' })).toBe('* a b')
  })

  it('appends tags as #tag#', () => {
    expect(renderHighlightContent({ ...base, tags: ['foo', 'bar baz'] })).toBe('* the quote #foo# #bar baz#')
  })

  it('nests note as a sub-item', () => {
    expect(renderHighlightContent({ ...base, note: 'my note' })).toBe('* the quote\n  * note: my note')
  })

  it('ialLine escapes embedded quotes', () => {
    expect(ialLine('a"b')).toBe('{: custom-acorny-id="a&quot;b"}')
  })

  it('renderHighlightBlock appends the IAL line last', () => {
    expect(renderHighlightBlock(base)).toBe('* the quote\n{: custom-acorny-id="hl1"}')
  })
})
