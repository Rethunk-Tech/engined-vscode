import { flushSseRest, parseSseChunk } from './engineEvents.ts'

/**
 * The SSE reader for `/openai/v1/chat/completions`, ported from the SSE reader
 * in Rethunk-Tech/engined: tool-call deltas arrive indexed and have to be
 * stitched back together before they mean anything. Pure and vscode-free so
 * `bun test` can replay a recorded stream without an extension host.
 */

interface ToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface ChatChunk {
  choices?: {
    delta?: {
      content?: string
      tool_calls?: ToolCallDelta[]
    }
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  /** An agentic hop's own cost, known only once its process exits -- carried on the final chunk since it comes too late for the `x-engined-cost-usd` header (see engined's HTTP API reference, "Answering-route headers"). */
  engined?: { cost_usd?: number }
}

export interface StitchedToolCall {
  id: string
  name: string
  /** Parsed from the stitched JSON string; `{}` when the stream sent no arguments. Invalid JSON is dropped, not returned. */
  arguments: Record<string, unknown> | undefined
}

export interface ChatUsage {
  promptTokens?: number
  completionTokens?: number
  costUsd?: number
  /** `prompt_tokens_details.cached_tokens`, when the engine (llama) reported one. */
  cachedTokens?: number
}

export interface StreamSink {
  text: (delta: string) => void
  /** The final chunk's `usage` (from `stream_options.include_usage`), when the stream carried one. */
  usage?: (usage: ChatUsage) => void
  /** A named tool call whose arguments JSON never parsed -- dropped rather than reported as `{}`. */
  invalidToolCall?: (name: string) => void
}

interface ToolCallSlot {
  id: string
  name: string
  args: string
}

/** A frame's JSON object payloads. A frame whose `data:` lines are not one JSON value (the door ended each line with a single newline) is read line by line; `[DONE]` and scalars yield nothing. */
function frameChunks(data: unknown): ChatChunk[] {
  if (typeof data === 'string') {
    return data.split('\n').flatMap((line) => frameChunks(parseJson(line)))
  }
  return data !== null && typeof data === 'object' ? [data as ChatChunk] : []
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// A Map, not an array: the door picks `index`, and "__proto__" or 2e9 must not reach Array.prototype or a sparse length.
function stitchToolCalls(calls: Map<number, ToolCallSlot>, parts: ToolCallDelta[]): void {
  for (const part of parts) {
    const at = typeof part.index === 'number' ? part.index : 0
    const slot = calls.get(at) ?? { id: '', name: '', args: '' }
    calls.set(at, slot)
    slot.id = part.id ?? slot.id
    slot.name = part.function?.name ?? slot.name
    slot.args += part.function?.arguments ?? ''
  }
}

function parseArgs(json: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** The OpenAI usage shape Copilot's extension-model endpoint reads off a `LanguageModelDataPart` with mimeType `'usage'` (`CustomDataPartMimeTypes.Usage`). */
export interface CopilotUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details: { cached_tokens: number }
}

/** `undefined` when the door never reported prompt/completion tokens at all -- reporting nothing then is honest, not a fabricated 0/0. */
export function buildCopilotUsage(usage: ChatUsage): CopilotUsage | undefined {
  if (usage.promptTokens === undefined && usage.completionTokens === undefined) {
    return undefined
  }
  const promptTokens = usage.promptTokens ?? 0
  const completionTokens = usage.completionTokens ?? 0
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: usage.cachedTokens ?? 0 },
  }
}

function takeFrame(
  data: unknown,
  sink: StreamSink,
  calls: Map<number, ToolCallSlot>,
  usage: ChatUsage,
): void {
  for (const chunk of frameChunks(data)) {
    takeChunk(chunk, sink, calls, usage)
  }
}

function takeChunk(
  chunk: ChatChunk,
  sink: StreamSink,
  calls: Map<number, ToolCallSlot>,
  usage: ChatUsage,
): void {
  const delta = chunk.choices?.[0]?.delta
  if (delta?.content) {
    sink.text(delta.content)
  }
  stitchToolCalls(calls, delta?.tool_calls ?? [])
  if (chunk.usage !== undefined) {
    usage.promptTokens = chunk.usage.prompt_tokens
    usage.completionTokens = chunk.usage.completion_tokens
    usage.cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens
  }
  if (chunk.engined?.cost_usd !== undefined) {
    usage.costUsd = chunk.engined.cost_usd
  }
  if (chunk.usage !== undefined || chunk.engined?.cost_usd !== undefined) {
    sink.usage?.({ ...usage })
  }
}

/**
 * Read an OpenAI-shaped SSE completion, emitting text deltas as they arrive
 * via `sink.text` and returning the stitched tool calls once the stream ends.
 */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  sink: StreamSink,
): Promise<StitchedToolCall[]> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const calls = new Map<number, ToolCallSlot>()
  const usage: ChatUsage = {}
  let buffer = ''
  try {
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      buffer += decoder.decode(r.value, { stream: true })
      const parsed = parseSseChunk(buffer)
      buffer = parsed.rest
      for (const frame of parsed.frames) {
        takeFrame(frame.data, sink, calls, usage)
      }
    }
    buffer += decoder.decode()
    for (const frame of flushSseRest(buffer).frames) {
      takeFrame(frame.data, sink, calls, usage)
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Already closed or cancelled.
    }
    try {
      reader.releaseLock()
    } catch {
      // The stream was already cancelled.
    }
  }
  return [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, c]) => c)
    .filter((c) => c.name.length > 0)
    .flatMap((c, i) => {
      const parsed = c.args === '' ? {} : parseArgs(c.args)
      if (parsed === undefined) {
        sink.invalidToolCall?.(c.name)
        return []
      }
      return [{ id: c.id || `call_${i}`, name: c.name, arguments: parsed }]
    })
}
