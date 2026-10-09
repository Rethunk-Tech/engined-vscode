import { describe, expect, test } from 'bun:test'
import { cancellationSignal } from './cancellation.ts'

function token(cancelled: boolean) {
  const listeners: (() => void)[] = []
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested(listener: () => void) {
      listeners.push(listener)
      return { dispose() {} }
    },
    cancel() {
      for (const listener of listeners) {
        listener()
      }
    },
  }
}

describe('cancellationSignal', () => {
  test('an already-cancelled token yields an aborted signal', () => {
    expect(cancellationSignal(token(true)).aborted).toBe(true)
  })

  test('aborts when the token is cancelled later, and not before', () => {
    const t = token(false)
    const signal = cancellationSignal(t)
    expect(signal.aborted).toBe(false)
    t.cancel()
    expect(signal.aborted).toBe(true)
  })
})
