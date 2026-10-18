/**
 * The trust boundary every tool input/output path crosses: a path a model
 * hands the extension must resolve inside an open workspace folder, never
 * escape it with `..`, and never arrive already absolute outside one.
 */

import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'

export class PathEscapeError extends Error {}

/**
 * `requested` resolved against the first `root` it falls inside, or throws
 * `PathEscapeError` naming why. An absolute `requested` is accepted only
 * when it already resolves inside a root -- rejecting every absolute path
 * outright would also reject a workspace folder's own absolute root path.
 */
function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}

/** `realpath` of `p` when it exists; otherwise the real existing prefix plus the missing tail. */
function realpathExistingPrefix(p: string): string {
  let current = p
  const missing: string[] = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return missing.length === 0 ? real : resolve(real, ...missing.slice().reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        return p
      }
      missing.push(basename(current))
      current = parent
    }
  }
}

function containedIn(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => isInside(candidate, root))
}

export function resolveWorkspacePath(roots: readonly string[], requested: string): string {
  if (roots.length === 0) {
    throw new PathEscapeError('no workspace folder is open')
  }
  if (requested.includes('\0')) {
    throw new PathEscapeError('path contains a NUL byte')
  }
  const candidate = isAbsolute(requested)
    ? resolve(requested)
    : resolve(roots[0] as string, requested)
  const normalizedRoots = roots.map((root) => resolve(root))
  if (!containedIn(candidate, normalizedRoots)) {
    throw new PathEscapeError(`"${requested}" resolves outside every open workspace folder`)
  }
  const realCandidate = realpathExistingPrefix(candidate)
  const realRoots = normalizedRoots.map((root) => realpathExistingPrefix(root))
  if (!containedIn(realCandidate, realRoots)) {
    throw new PathEscapeError(`"${requested}" resolves outside every open workspace folder`)
  }
  return candidate
}
