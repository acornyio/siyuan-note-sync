/**
 * cyrb53 — 快速、同步、非加密的 53 位字符串哈希。够用于判断「连接是否变化」；
 * 不用于任何安全决策。
 */
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

/**
 * Acorny 连接的稳定身份：归一化 serverUrl + token 的哈希。与游标一起持久化，
 * 保证为某账号生成的游标绝不会被另一账号重放（否则可能静默漏数据）。
 * 只存哈希、不存原文，且只做相等比较。
 */
export function connectionId(serverUrl: string, token: string): string {
  const trimmed = serverUrl.trim()
  let normalizedUrl: string
  try {
    normalizedUrl = new URL(trimmed).toString().replace(/\/+$/, '')
  } catch {
    normalizedUrl = trimmed.replace(/\/+$/, '')
  }
  return cyrb53(`${normalizedUrl} ${token.trim()}`)
}
