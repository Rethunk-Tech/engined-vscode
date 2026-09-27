/**
 * Pure mapping between engined's `/openai/v1/models` rows and the plain
 * shapes the VS Code adapter turns into `LanguageModelChatInformation` and
 * OpenAI chat request bodies. No `vscode` import here, so this runs under
 * `bun test` with no extension host.
 */

/** The subset of engined's `ModelRow` (src/responses.ts) this extension reads. */
export interface EnginedModelRow {
  id: string
  engine?: string
  display_name?: string
  egress?: string
  tools: boolean
  serves: string[]
  role?: string
  vision?: string
  translate?: boolean
  state: string
  capabilities: {
    input?: string[]
    output?: string[]
    context_in?: number
    context_out?: number
    reasoning?: string[]
  }
}

interface ModelsResponse {
  data: EnginedModelRow[]
}

/** The plain shape the adapter turns into `vscode.LanguageModelChatInformation`. */
export interface EnginedModelInfo {
  id: string
  name: string
  family: string
  version: string
  detail: string
  tooltip: string
  maxInputTokens: number
  maxOutputTokens: number
  capabilities: { toolCalling: boolean; imageInput: boolean }
  /** Kept so the chat path knows what the row itself could do, beyond what LanguageModelChatCapabilities carries. */
  row: EnginedModelRow
}

const CHAT_PATH = '/openai/v1/chat/completions'
export const TOKENIZE_PATH = '/engined/v1/tokenize'

/** Whether the row advertises the vocab-only tokenize path (engined docs/http-api.md § Vocab-only tokenize). */
export function servesTokenize(row: EnginedModelRow): boolean {
  return row.serves.includes(TOKENIZE_PATH)
}

/**
 * ponytail: context_out has no analogous "minimum across chain hops" field
 * reported for undeclared llama routes the way context_in now does (see
 * engined 8e583c4); 8192 is a guess, and under-reporting only trims a
 * response early rather than overflowing anything.
 */
const FALLBACK_MAX_OUTPUT_TOKENS = 8192
const FALLBACK_MAX_INPUT_TOKENS = 32768

function tooltipFor(row: EnginedModelRow): string {
  const parts = [`serves: ${row.serves.join(', ')}`]
  if (row.role !== undefined) {
    parts.push(`role: ${row.role}`)
  }
  if (row.role === 'vision') {
    parts.push(`vision: ${row.vision ?? 'unknown'}`)
  }
  return parts.join(' · ')
}

/** One row -> the model info the provider reports, or `undefined` for a row this extension does not offer as a chat model. */
export function mapModelRow(row: EnginedModelRow): EnginedModelInfo | undefined {
  // `running` and `warming` are the same model in use; only `unavailable` cannot answer.
  // A vision row (ocr/describe) serves chat completions but only ever answers a tool's
  // image-carrying request, never a chat turn -- keep it out of the picker.
  if (!row.serves.includes(CHAT_PATH) || row.state === 'unavailable' || row.role === 'vision') {
    return undefined
  }
  return {
    id: row.id,
    name: row.display_name ?? row.id,
    family: row.engine ?? 'chain',
    version: row.id,
    detail: row.egress ?? '',
    tooltip: tooltipFor(row),
    maxInputTokens: row.capabilities.context_in ?? FALLBACK_MAX_INPUT_TOKENS,
    maxOutputTokens: row.capabilities.context_out ?? FALLBACK_MAX_OUTPUT_TOKENS,
    capabilities: {
      toolCalling: row.tools,
      imageInput: row.capabilities.input?.includes('image') ?? false,
    },
    row,
  }
}

/**
 * Every answerable row (`state !== "unavailable"`), chat or not -- what the
 * `engined_*` tools and the completions picker choose a route from. A comfy,
 * TTS or STT row never serves `/openai/v1/chat/completions`, so picking from
 * `mapModels`' chat-only list (as the chat provider itself does) would never
 * find it.
 */
export function mapAnswerableRows(body: unknown): EnginedModelRow[] {
  const data = (body as Partial<ModelsResponse> | undefined)?.data
  return Array.isArray(data) ? data.filter((row) => row.state !== 'unavailable') : []
}

/** A stable string a poll can diff `mapAnswerableRows`' output against, ignoring key order. */
export function serializeRows(rows: readonly EnginedModelRow[]): string {
  return JSON.stringify(rows.map((r) => ({ id: r.id, state: r.state, serves: r.serves })))
}

/** The full `/openai/v1/models` response body -> the models this extension exposes. */
export function mapModels(body: unknown): EnginedModelInfo[] {
  const data = (body as Partial<ModelsResponse> | undefined)?.data
  if (!Array.isArray(data)) {
    return []
  }
  const mapped: EnginedModelInfo[] = []
  for (const row of data) {
    const info = mapModelRow(row)
    if (info !== undefined) {
      mapped.push(info)
    }
  }
  return mapped
}

/** A stable string a poll can diff against the previous one, ignoring key order. */
export function serializeModels(models: EnginedModelInfo[]): string {
  return JSON.stringify(
    models.map((m) => ({
      id: m.id,
      name: m.name,
      family: m.family,
      detail: m.detail,
      maxInputTokens: m.maxInputTokens,
      maxOutputTokens: m.maxOutputTokens,
      capabilities: m.capabilities,
    })),
  )
}

export const REASONING_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

/** The row's own reasoning levels, ordered by `REASONING_LEVELS`, or `undefined` when it does not support any. */
export function reasoningLevelsFor(row: EnginedModelRow): ReasoningLevel[] | undefined {
  const declared = row.capabilities.reasoning
  if (declared === undefined || declared.length === 0) {
    return undefined
  }
  const ordered = REASONING_LEVELS.filter((level) => declared.includes(level))
  return ordered.length > 0 ? ordered : undefined
}

/** The closest level the row lists to a requested one, walking outward on the shared ordering. */
export function snapReasoningEffort(
  requested: ReasoningLevel,
  available: readonly ReasoningLevel[],
): ReasoningLevel {
  const requestedIndex = REASONING_LEVELS.indexOf(requested)
  let best: ReasoningLevel = available[0] ?? requested
  let bestDistance = Number.POSITIVE_INFINITY
  for (const level of available) {
    const distance = Math.abs(REASONING_LEVELS.indexOf(level) - requestedIndex)
    if (distance < bestDistance) {
      bestDistance = distance
      best = level
    }
  }
  return best
}
