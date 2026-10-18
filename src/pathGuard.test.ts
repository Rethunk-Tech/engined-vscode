import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

  test('a relative path that exists only in a later folder resolves there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pathGuard-multi-'))
    const first = join(dir, 'one')
    const second = join(dir, 'two')
    mkdirSync(first)
    mkdirSync(second)
    writeFileSync(join(second, 'only-here.wav'), 'x')
    try {
      expect(resolveWorkspacePath([first, second], 'only-here.wav')).toBe(
        join(second, 'only-here.wav'),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rejects an absolute path whose .. segments climb out of the root', () => {
    expect(() => resolveWorkspacePath([ROOT], `${ROOT}/../../etc/passwd`)).toThrow(PathEscapeError)
  })

  test('throws when no workspace folder is open', () => {
    expect(() => resolveWorkspacePath([], 'a.png')).toThrow(PathEscapeError)
  })

  test('rejects a NUL in the requested path', () => {
    expect(() => resolveWorkspacePath([ROOT], 'notes\0/../../etc/passwd')).toThrow(PathEscapeError)
  })

  test('rejects a symlink inside the workspace whose target is outside it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pathGuard-'))
    const root = join(dir, 'ws')
    mkdirSync(root)
    const secret = join(dir, 'secret.txt')
    writeFileSync(secret, 'x')
    symlinkSync(secret, join(root, 'link.txt'))
    try {
      expect(() => resolveWorkspacePath([root], 'link.txt')).toThrow(PathEscapeError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
