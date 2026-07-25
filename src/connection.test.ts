import { describe, expect, it } from 'vitest'
import { connectionId } from './connection'

describe('connectionId', () => {
  it('same server+token → same id', () => {
    expect(connectionId('https://api.acorny.io', 't1')).toBe(connectionId('https://api.acorny.io', 't1'))
  })

  it('trailing slash and casing of host normalized to same id', () => {
    expect(connectionId('https://API.acorny.io/', 't1')).toBe(connectionId('https://api.acorny.io', 't1'))
  })

  it('different token → different id', () => {
    expect(connectionId('https://api.acorny.io', 't1')).not.toBe(connectionId('https://api.acorny.io', 't2'))
  })

  it('non-URL input stays stable run-to-run', () => {
    expect(connectionId('not a url', 't1')).toBe(connectionId('not a url', 't1'))
  })
})
