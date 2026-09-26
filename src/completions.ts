/**
 * Pure logic for inline completions (ghost text) via engined's
 * `POST /openai/v1/completions`. No `vscode` import, so this runs under
 * `bun test` with no extension host; `extension.ts` supplies the document
 * text/offset, debounce and abort wiring.
 */

import type { EnginedModelInfo } from './door.ts'

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
): CompletionsRequestBody {
  return {
    model: modelId,
    prompt: prefix,
    suffix,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    stop: STOP,
  }
}

/** The configured model if it still answers completions, else the first such row from the existing poll; `undefined` when none do. */
export function pickCompletionsModel(
  models: readonly EnginedModelInfo[],
  configuredId: string,
): EnginedModelInfo | undefined {
  const answerable = models.filter((m) => m.row.serves.includes(COMPLETIONS_PATH))
  return configuredId === '' ? answerable[0] : answerable.find((m) => m.id === configuredId)
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
