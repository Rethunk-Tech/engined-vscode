import { expect, test } from 'bun:test'
import fc from 'fast-check'
import { copyFixText, isAllowedDoorUrl } from './door'

const ASCII_C0_MAX = 0x1f
const ASCII_DEL = 0x7f
const ctlChar = fc.integer({ min: 0, max: ASCII_C0_MAX }).map((c) => String.fromCharCode(c))
const delOrCtl = fc.oneof(ctlChar, fc.constant(String.fromCharCode(ASCII_DEL)))
const commandArg = fc.stringMatching(/^[A-Za-z0-9._-]{1,64}$/)

function hasCtl(s: string): boolean {
  for (const ch of s) {
    const code = ch.charCodeAt(0)
    if (code <= ASCII_C0_MAX || code === ASCII_DEL) {
      return true
    }
  }
  return false
}

test('isAllowedDoorUrl never throws and agrees with URL parse', () => {
  fc.assert(
    fc.property(fc.string(), (url) => {
      let allowed = false
      try {
        const { protocol } = new URL(url)
        allowed = protocol === 'http:' || protocol === 'https:'
      } catch {
        allowed = false
      }
      expect(isAllowedDoorUrl(url)).toBe(allowed)
    }),
  )
})

test('isAllowedDoorUrl accepts http(s) web URLs', () => {
  fc.assert(
    fc.property(fc.webUrl({ validSchemes: ['http', 'https'] }), (url) => {
      expect(isAllowedDoorUrl(url)).toBe(true)
    }),
  )
})

test('copyFixText never throws and is idempotent on a defined result', () => {
  fc.assert(
    fc.property(fc.option(fc.string(), { nil: undefined }), (fix) => {
      const out = copyFixText(fix)
      if (out === undefined) {
        return
      }
      expect(out.startsWith('engined ')).toBe(true)
      expect(hasCtl(out)).toBe(false)
      expect(out).toBe(fix!.trim())
      expect(copyFixText(out)).toBe(out)
    }),
  )
})

test('copyFixText rejects any string that contains a C0 or DEL byte', () => {
  fc.assert(
    fc.property(fc.string(), delOrCtl, fc.string(), (left, ctl, right) => {
      expect(copyFixText(left + ctl + right)).toBeUndefined()
    }),
  )
})

test('copyFixText keeps a trimmed engined command with a non-space argument', () => {
  fc.assert(
    fc.property(
      fc.nat({ max: 4 }).map((n) => ' '.repeat(n)),
      commandArg,
      (pad, arg) => {
        const requested = `${pad}engined ${arg}`
        expect(copyFixText(requested)).toBe(requested.trim())
      },
    ),
  )
})
