/**
 * The trust boundary every tool input/output path crosses: a path a model
 * hands the extension must resolve inside an open workspace folder, never
 * escape it with `..`, and never arrive already absolute outside one.
 */

import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

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

/** `realpath` of `p` when it exists; otherwise the real existing prefix plus the missing tail. Throws on a dangling symlink. */
function realpathExistingPrefix(p: string): string {
  let current = p
  const missing: string[] = []
  let reachedRoot = false
  while (!reachedRoot) {
    try {
      const real = realpathSync(current)
      return missing.length === 0 ? real : resolve(real, ...missing.slice().reverse())
    } catch (error) {
      // A dangling link would be followed by the write, wherever its missing target lies.
      if (lstatSync(current, { throwIfNoEntry: false }) !== undefined) {
        throw new PathEscapeError(`"${current}" is a symlink whose target does not exist`, {
          cause: error,
        })
      }
      const parent = dirname(current)
      if (parent === current) {
        reachedRoot = true
      } else {
        missing.push(basename(current))
        current = parent
      }
    }
  }
  return p
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
  const normalizedRoots = roots.map((root) => resolve(root))
  const candidates = isAbsolute(requested)
    ? [resolve(requested)]
    : normalizedRoots.map((root) => resolve(root, requested))
  let fallback: string | undefined
  for (const candidate of candidates) {
    if (!containedIn(candidate, normalizedRoots)) {
      continue
    }
    const realCandidate = realpathExistingPrefix(candidate)
    const realRoots = normalizedRoots.map((root) => realpathExistingPrefix(root))
    if (!containedIn(realCandidate, realRoots)) {
      continue
    }
    try {
      realpathSync(candidate)
      return candidate
    } catch {
      fallback ??= candidate
    }
  }
  if (fallback !== undefined) {
    return fallback
  }
  throw new PathEscapeError(`"${requested}" resolves outside every open workspace folder`)
}

/** Workspace-relative path as a confirmation dialog names it. With more than one folder, the folder name comes first so two `notes.md` files are not shown as the same path. */
export function displayWorkspacePath(roots: readonly string[], absolute: string): string {
  const normalizedRoots = roots.map((folder) => resolve(folder))
  const root = normalizedRoots.find((candidate) => isInside(absolute, candidate))
  if (root === undefined) {
    return absolute
  }
  const rel = relative(root, absolute).split(sep).join('/')
  return normalizedRoots.length > 1 ? `${basename(root)}/${rel}` : rel
}
