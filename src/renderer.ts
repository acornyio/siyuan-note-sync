import type { ExportFeedHighlight } from './types'

/** 把多行折叠为单行（列表项内容需单行）。 */
function oneLine(input: string): string {
  return input.replace(/\s*\n\s*/g, ' ').trim()
}

/** IAL 属性值转义（避免引号截断属性）。 */
function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;')
}

/** 单条高亮的去重属性 IAL 行。 */
export function ialLine(id: string): string {
  return `{: custom-acorny-id="${escapeAttr(id)}"}`
}

/**
 * 渲染高亮列表项内容（不含 id）：`* <quote> <#tag#...>`，有 note 时嵌套子项。
 * quoteMarkdown 优先，缺失回退 quote。
 */
export function renderHighlightContent(h: ExportFeedHighlight): string {
  const text = oneLine(h.quoteMarkdown ?? h.quote)
  const tags = h.tags.length > 0 ? ' ' + h.tags.map((t) => `#${t}#`).join(' ') : ''
  let item = `* ${text}${tags}`
  if (h.note && h.note.trim().length > 0) {
    item += `\n  * note: ${oneLine(h.note)}`
  }
  return item
}

/**
 * 渲染可直接交给 appendBlock 的块 markdown：内容 + 末行 IAL，使块与 custom-acorny-id
 * 一次原子落地（见 spec §5，规避 append/setAttr 之间的崩溃窗口）。
 */
export function renderHighlightBlock(h: ExportFeedHighlight): string {
  return `${renderHighlightContent(h)}\n${ialLine(h.id)}`
}
