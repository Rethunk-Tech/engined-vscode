import { describe, expect, test } from 'bun:test'
import { describeFingerprint, fingerprint } from './promptFingerprint.ts'

describe('fingerprint', () => {
  test('locates the first differing message and character', () => {
    const prev = { messages: ['instructions v1', 'hello'], tools: '[a,b]' }
    const cur = { messages: ['instructions v2', 'hello'], tools: '[a,b]' }
    expect(fingerprint(cur, prev).firstDifference).toEqual({
      message: 0,
      charInMessage: 14,
      charOverall: 14,
    })
  })

  test('counts earlier identical messages into the overall offset', () => {
    const prev = { messages: ['same', 'abc'], tools: '[]' }
    const cur = { messages: ['same', 'abd'], tools: '[]' }
    expect(fingerprint(cur, prev).firstDifference).toEqual({
      message: 1,
      charInMessage: 2,
      charOverall: 6,
    })
  })

  test('reports no difference and flags a changed tool set without exposing content', () => {
    const a = { messages: ['secret prompt'], tools: '[x]' }
    const line = describeFingerprint(
      fingerprint(a, a),
      fingerprint({ ...a, tools: '[y]' }).toolsHash,
    )
    expect(line).toContain('no difference')
    expect(line).toContain('CHANGED')
    expect(line).not.toContain('secret')
  })
})
