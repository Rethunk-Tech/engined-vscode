/**
 * Pure logic for inline completions (ghost text) via engined's
 * `POST /openai/v1/completions`. No `vscode` import, so this runs under
 * `bun test` with no extension host; `extension.ts` supplies the document
 * text/offset, debounce and abort wiring. `completionWaitingBehind` is the
 * engines-list check that skips requests while the completion model is queued.
 */

import type { ExtraFile } from './neighbourContext.ts'

export const COMPLETIONS_PATH = '/openai/v1/completions'

/**
 * A `DocumentFilter[]` for `registerInlineCompletionItemProvider`. A
 * `pattern`-only filter with no `scheme` is not guaranteed to score a
 * `vscode-notebook-cell` or `untitled` document -- VS Code's own selector
 * scoring (`vs/editor/common/languageSelector.ts`) treats an unscoped
 * `pattern` filter as `file`/`untitled` only, so a notebook cell (which
 * never carries a `file` URI) is invisible to it. Listed explicitly instead
 * of relying on that default. `vscode-remote` is not needed: this
 * extension's `extensionKind` is `workspace`, so it always sees `file` URIs
 * even under Remote-SSH.
 */
export const COMPLETIONS_DOCUMENT_SELECTOR_SCHEMES = [
  'file',
  'untitled',
  'vscode-notebook-cell',
] as const

/**
 * ponytail: fixed single-line budget rather than something configurable --
 * ornith measurements back the numbers in the spec, and a knob nobody has
 * asked to turn is a setting nobody needed.
 */
const PREFIX_LIMIT = 6000
const SUFFIX_LIMIT = 2000
const MAX_TOKENS = 64
const STOP = ['\n']

export interface CompletionsRequestBody {
  model: string
  prompt: string
  suffix: string
  max_tokens: number
  temperature: number
  stop: string[]
  extra?: ExtraFile[]
}

/** The cursor-anchored slice of `text` a completions request sends, trimmed to the door's single-line budget. */
export function sliceContext(text: string, offset: number): { prefix: string; suffix: string } {
  return {
    prefix: text.slice(Math.max(0, offset - PREFIX_LIMIT), offset),
    suffix: text.slice(offset, offset + SUFFIX_LIMIT),
  }
}

export function buildCompletionsRequestBody(
  modelId: string,
  prefix: string,
  suffix: string,
  extra?: ExtraFile[],
): CompletionsRequestBody {
  return {
    model: modelId,
    prompt: prefix,
    suffix,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    stop: STOP,
    ...(extra !== undefined && extra.length > 0 ? { extra } : {}),
  }
}

/** `choices[0].text` from a completions reply, trailing whitespace trimmed; `undefined` for empty or malformed. */
export function extractCompletionText(reply: unknown): string | undefined {
  const choices = (reply as { choices?: unknown } | undefined)?.choices
  const text = Array.isArray(choices)
    ? (choices[0] as { text?: unknown } | undefined)?.text
    : undefined
  if (typeof text !== 'string') {
    return undefined
  }
  const trimmed = text.trimEnd()
  return trimmed === '' ? undefined : trimmed
}

export interface CompletionUsage {
  promptTokens?: number
  completionTokens?: number
}

/**
 * One engines-list row's id and `roles`, enough to tell whether the
 * completion model is queued behind another job.
 */
export interface CompletionEngineContention {
  id: string
  roles?: readonly { active: number; waiting: number; model?: string }[]
}

function roleNamesRoute(model: string | undefined, routeId: string): boolean {
  if (model === undefined || model.length === 0) {
    return false
  }
  if (model === routeId || routeId.endsWith(`/${model}`)) {
    return true
  }
  const stem = model.endsWith('.gguf') ? model.slice(0, -'.gguf'.length) : model
  if (stem !== model && (routeId === stem || routeId.endsWith(`/${stem}`))) {
    return true
  }
  const last = routeId.split('/').at(-1)
  return last === model || last === stem
}

/**
 * True when the engines list shows the completion model waiting behind
 * another job (or queued as the GGUF head with nothing active yet). False
 * when that engine has nobody waiting, or when the completion model itself
 * is already active.
 */
export function completionWaitingBehind(
  engines: readonly CompletionEngineContention[],
  completion: { engine?: string; routeId: string },
): boolean {
  const engine =
    completion.engine === undefined
      ? engines.find((row) =>
          row.roles?.some((role) => roleNamesRoute(role.model, completion.routeId)),
        )
      : engines.find((row) => row.id === completion.engine)
  if (engine?.roles === undefined) {
    return false
  }
  let waiting = 0
  let weAreActive = false
  for (const role of engine.roles) {
    if (role.waiting > 0) {
      waiting += role.waiting
    }
    if (role.active > 0 && roleNamesRoute(role.model, completion.routeId)) {
      weAreActive = true
    }
  }
  return waiting > 0 && !weAreActive
}

const COMMON_LINE_COMMENT_PREFIXES = ['//', '--', '#', ';'] as const

/** Line and block tokens from a VS Code language configuration, when the host found one. */
export interface CompletionCommentTokens {
  lineComment?: string
  blockComment?: readonly [string, string]
}

function linePrefixBefore(text: string, offset: number): string {
  const from = text.lastIndexOf('\n', offset - 1) + 1
  return text.slice(from, offset)
}

function cursorInComment(
  text: string,
  offset: number,
  commentTokens: CompletionCommentTokens | undefined,
): boolean {
  const line = linePrefixBefore(text, offset)
  const trimmed = line.trimStart()
  const configured =
    commentTokens !== undefined &&
    (commentTokens.lineComment !== undefined || commentTokens.blockComment !== undefined)
  if (configured) {
    if (
      commentTokens.lineComment !== undefined &&
      commentTokens.lineComment !== '' &&
      trimmed.startsWith(commentTokens.lineComment)
    ) {
      return true
    }
    const pair = commentTokens.blockComment
    if (pair !== undefined) {
      const [start, end] = pair
      if (start !== '' && end !== '') {
        const before = text.slice(0, offset)
        const lastStart = before.lastIndexOf(start)
        if (lastStart >= 0 && before.lastIndexOf(end) < lastStart) {
          return true
        }
      }
    }
    return false
  }
  return COMMON_LINE_COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

/**
 * Whether an inline-completion request may go to the door: skip disabled
 * language ids, and when `inComments` is off, skip a cursor inside a comment.
 */
export function completionRequestAllowed(input: {
  languageId: string
  disabledLanguages: readonly string[]
  inComments: boolean
  text: string
  offset: number
  commentTokens?: CompletionCommentTokens
}): boolean {
  if (input.disabledLanguages.includes(input.languageId)) {
    return false
  }
  if (input.inComments) {
    return true
  }
  return !cursorInComment(input.text, input.offset, input.commentTokens)
}

/** `usage.{prompt_tokens,completion_tokens}` from a completions reply, when it carried one. */
export function extractCompletionUsage(reply: unknown): CompletionUsage | undefined {
  const usage = (reply as { usage?: unknown } | undefined)?.usage
  if (typeof usage !== 'object' || usage === null) {
    return undefined
  }
  const { prompt_tokens: promptTokens, completion_tokens: completionTokens } = usage as {
    prompt_tokens?: unknown
    completion_tokens?: unknown
  }
  if (typeof promptTokens !== 'number' && typeof completionTokens !== 'number') {
    return undefined
  }
  return {
    promptTokens: typeof promptTokens === 'number' ? promptTokens : undefined,
    completionTokens: typeof completionTokens === 'number' ? completionTokens : undefined,
  }
}
