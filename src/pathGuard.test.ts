import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { PathEscapeError, resolveWorkspacePath } from './pathGuard.ts'

const ROOT = '/workspace/project'

describe('resolveWorkspacePath', () => {
  test('resolves a relative path inside the root', () => {
    expect(resolveWorkspacePath([ROOT], 'notes/todo.md')).toBe(join(ROOT, 'notes/todo.md'))
  })

  test('rejects a .. escape', () => {
    expect(() => resolveWorkspacePath([ROOT], '../outside.txt')).toThrow(PathEscapeError)
  })

  test('rejects an absolute path outside every root', () => {
    expect(() => resolveWorkspacePath([ROOT], '/etc/passwd')).toThrow(PathEscapeError)
  })

  test('accepts an absolute path that resolves inside a root', () => {
    expect(resolveWorkspacePath([ROOT], join(ROOT, 'a.png'))).toBe(join(ROOT, 'a.png'))
  })

  test('falls through to a second workspace root', () => {
    const second = '/workspace/other'
    expect(resolveWorkspacePath([ROOT, second], join(second, 'file.wav'))).toBe(
      join(second, 'file.wav'),
    )
  })

  test('throws when no workspace folder is open', () => {
    expect(() => resolveWorkspacePath([], 'a.png')).toThrow(PathEscapeError)
  })
})
