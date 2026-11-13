/**
 * Which of a workspace root's files `git check-ignore` reports ignored, so
 * `engined_search` never embeds what the repository itself keeps out of
 * version control (build output, local secrets). No `vscode` import.
 */

import { spawn } from 'node:child_process'

const NOT_IGNORED_EXIT = 1

/** Paths (relative to `root`) that git ignores. Empty when `root` is not a repository or git is missing: only the secret-name filter applies there. */
export function gitIgnored(root: string, relPaths: readonly string[]): Promise<Set<string>> {
  if (relPaths.length === 0) {
    return Promise.resolve(new Set())
  }
  return new Promise((resolve) => {
    // --no-index: with the index, one path inside a submodule aborts the whole batch (exit 128).
    const child = spawn('git', ['-C', root, 'check-ignore', '--no-index', '-z', '--stdin'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.on('error', () => resolve(new Set()))
    child.on('close', (code) => {
      if (code !== 0 && code !== NOT_IGNORED_EXIT) {
        resolve(new Set())
        return
      }
      resolve(new Set(Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean)))
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(`${relPaths.join('\0')}\0`)
  })
}
