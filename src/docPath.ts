// 路径非法字符（Windows/macOS/Linux）。空格不非法，尾部空格单独裁掉。
const ILLEGAL = /[/\\:*?"<>|]/g

const MAX_LEN = 120
// 多数文件系统按字节限长（255 bytes）。120 个中日文 ≈ 360 字节会溢出，用保守字节预算。
const MAX_BYTES = 180
const encoder = new TextEncoder()

/** 把控制字符（C0 0x00–0x1F 与 DEL 0x7F，含换行/回车/制表）替换为空格。 */
function stripControlChars(input: string): string {
  let out = ''
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0
    out += code <= 0x1f || code === 0x7f ? ' ' : ch
  }
  return out
}

/** 不超字节预算、不切断码点地截断。 */
function truncate(input: string, maxChars: number, maxBytes: number): string {
  if (input.length <= maxChars && encoder.encode(input).length <= maxBytes) return input
  let out = ''
  let chars = 0
  let bytes = 0
  for (const ch of input) {
    const chBytes = encoder.encode(ch).length
    if (chars + 1 > maxChars || bytes + chBytes > maxBytes) break
    out += ch
    chars += 1
    bytes += chBytes
  }
  return out
}

/** 标题 → 合法文档段名（无路径、无扩展）。 */
function sanitizeTitle(title: string | null): string {
  const cleaned = stripControlChars((title ?? '').normalize('NFC'))
    .replace(ILLEGAL, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[-. ]+$/g, '')
    .trim()
  if (cleaned.length === 0) return 'Untitled'
  const truncated = truncate(cleaned, MAX_LEN, MAX_BYTES)
  return truncated.length < cleaned.length ? truncated.replace(/[-. ]+$/g, '') : truncated
}

/**
 * 构造文档 hpath：`/<folder>/<sanitizedTitle>`（干净标题，无后缀）。
 * 实测 `createDocWithMd` **非** hpath 幂等：同一 path 每次都新建文档、返回不同 id
 * （见 docs/superpowers/notes/2026-07-23-kernel-contract-fixtures.md）。因此：
 *  - 同一 source 的复用靠 SQL 查 `custom-acorny-source-id`，不依赖 path 唯一；
 *  - 两个同名但不同 source 各自得到独立文档（思源允许同名），不会串数据。
 * 故不再加 source-id 后缀，避免污染可见文档标题。
 */
export function buildDocHPath(folderPath: string, title: string | null): string {
  const folder = `/${folderPath.replace(/^\/+/, '').replace(/\/+$/, '')}`
  return `${folder}/${sanitizeTitle(title)}`
}
