/**
 * Pure snippet selection for `/openai/v1/completions`' `extra` field
 * (engined src/completions.ts `ExtraFile`): which open/recent documents to
 * send, how much of each, and the exclusion/cap rules. No `vscode` import;
 * `extension.ts` reduces real editors/documents to `NeighbourCandidate`s in
 * caller-priority order (visible editors first, then recently active docs).
 */

export interface NeighbourCandidate {
  /** Workspace-relative path, as engined's `ExtraFile.filename` expects. */
  filename: string
  scheme: string
  text: string
  /** The live cursor offset for a currently visible editor; undefined takes the head of the file. */
  cursorOffset?: number
}

export interface ExtraFile {
  filename: string
  text: string
}

const SNIPPET_CHARS = 1500
const SNIPPET_RADIUS = SNIPPET_CHARS / 2
const MAX_FILES = 3
const TOTAL_CHAR_CAP = 4500

const GLOB_SPECIAL = /[.+^${}()|[\]\\]/g
const LEADING_ANY_DIRS = /^\.\*\//
const TRAILING_ANY_DIRS = /\/\.\*$/

/** A minimal glob -> RegExp, segment by segment: a whole `**` segment matches any number of path segments (including none); `*`/`?` stay within one segment. Enough for `files.exclude`/`search.exclude` patterns. */
function globToRegExp(pattern: string): RegExp {
  const joined = pattern
    .split('/')
    .map((segment) =>
      segment === '**'
        ? '.*'
        : segment.replace(GLOB_SPECIAL, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'),
    )
    .join('/')
    .replace(LEADING_ANY_DIRS, '(?:.*/)?')
    .replace(/\/\.\*\//g, '/(?:.*/)?')
    .replace(TRAILING_ANY_DIRS, '(?:/.*)?')
  return new RegExp(`^${joined}$`)
}

export function isExcluded(relPath: string, excludeGlobs: readonly string[]): boolean {
  return excludeGlobs.some((glob) => globToRegExp(glob).test(relPath))
}

/** ~1500 chars around `offset`, or the file's head when there is no live cursor. */
function snippetAround(text: string, offset: number | undefined): string {
  if (offset === undefined) {
    return text.slice(0, SNIPPET_CHARS)
  }
  const clamped = Math.max(0, Math.min(offset, text.length))
  const start = Math.max(0, clamped - SNIPPET_RADIUS)
  return text.slice(start, start + SNIPPET_CHARS)
}

/**
 * Up to 3 files, ~1500 chars each, 4500 chars total, in `candidates`' own
 * priority order. Drops the current document, non-`file`/`untitled`
 * schemes, duplicates, and anything `excludeGlobs` matches.
 */
export function selectSnippets(
  candidates: readonly NeighbourCandidate[],
  currentFilename: string,
  excludeGlobs: readonly string[],
): ExtraFile[] {
  const seen = new Set<string>()
  const out: ExtraFile[] = []
  let budget = TOTAL_CHAR_CAP
  for (const candidate of candidates) {
    if (out.length >= MAX_FILES || budget <= 0) {
      break
    }
    if (candidate.scheme !== 'file' && candidate.scheme !== 'untitled') {
      continue
    }
    if (candidate.filename === currentFilename || seen.has(candidate.filename)) {
      continue
    }
    if (isExcluded(candidate.filename, excludeGlobs)) {
      continue
    }
    seen.add(candidate.filename)
    const snippet = snippetAround(candidate.text, candidate.cursorOffset).slice(0, budget)
    if (snippet.length === 0) {
      continue
    }
    out.push({ filename: candidate.filename, text: snippet })
    budget -= snippet.length
  }
  return out
}

/** Moves `item` to the front of `recent` (most recent first), dropping the oldest past `cap`. */
export function trackRecent<T>(recent: T[], item: T, cap: number): void {
  const existing = recent.indexOf(item)
  if (existing !== -1) {
    recent.splice(existing, 1)
  }
  recent.unshift(item)
  if (recent.length > cap) {
    recent.length = cap
  }
}
