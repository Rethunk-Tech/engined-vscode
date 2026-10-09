/**
 * The trust boundary every tool input/output path crosses: a path a model
 * hands the extension must resolve inside an open workspace folder, never
 * escape it with `..`, and never arrive already absolute outside one.
 */

import { isAbsolute, resolve, sep } from 'node:path'

export class PathEscapeError extends Error {}

/**
 * `requested` resolved against the first `root` it falls inside, or throws
 * `PathEscapeError` naming why. An absolute `requested` is accepted only
 * when it already resolves inside a root -- rejecting every absolute path
 * outright would also reject a workspace folder's own absolute root path.
 */
export function resolveWorkspacePath(roots: readonly string[], requested: string): string {
  if (roots.length === 0) {
    throw new PathEscapeError('no workspace folder is open')
  }
  const candidate = isAbsolute(requested)
    ? resolve(requested)
    : resolve(roots[0] as string, requested)
  for (const root of roots) {
    const normalizedRoot = resolve(root)
    if (candidate === normalizedRoot || candidate.startsWith(normalizedRoot + sep)) {
      return candidate
    }
  }
  throw new PathEscapeError(`"${requested}" resolves outside every open workspace folder`)
}
