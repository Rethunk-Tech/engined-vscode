/**
 * Pure logic for inline completions (ghost text) via engined's
 * `POST /openai/v1/completions`. No `vscode` import, so this runs under
 * `bun test` with no extension host; `extension.ts` supplies the document
 * text/offset, debounce and abort wiring.
 */

import type { ExtraFile } from './neighbourContext.ts'

export const COMPLETIONS_PATH = '/openai/v1/completions'

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
