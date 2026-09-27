/**
 * The SSE reader for `/openai/v1/chat/completions`, ported from engined's own
 * `src/cursorChat.ts`: tool-call deltas arrive indexed and have to be
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
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  /** An agentic hop's own cost, known only once its process exits -- carried on the final chunk since it comes too late for the `x-engined-cost-usd` header (`docs/http-api.md` "Answering-route headers"). */
  engined?: { cost_usd?: number }
}

export interface StitchedToolCall {
  id: string
  name: string
  /** Parsed from the stitched JSON string; `undefined` when it never parsed as an object. */
  arguments: Record<string, unknown> | undefined
}

export interface ChatUsage {
  promptTokens?: number
  completionTokens?: number
  costUsd?: number
}

export interface StreamSink {
  text(delta: string): void
  /** The final chunk's `usage` (from `stream_options.include_usage`), when the stream carried one. */
  usage?(usage: ChatUsage): void
}

interface ToolCallSlot {
  id: string
  name: string
  args: string
}

/** One SSE line's JSON payload, or `undefined` for anything that is not a data frame carrying JSON. */
function parseDataLine(line: string): ChatChunk | undefined {
  if (!line.startsWith('data:')) {
    return undefined
  }
  const payload = line.slice(5).trim()
  if (payload.length === 0 || payload === '[DONE]') {
    return undefined
  }
  try {
    return JSON.parse(payload) as ChatChunk
  } catch {
    return undefined
  }
}

function stitchToolCalls(calls: ToolCallSlot[], parts: ToolCallDelta[]): void {
  for (const part of parts) {
    const at = part.index ?? 0
    calls[at] ??= { id: '', name: '', args: '' }
    const slot = calls[at]
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

/** Split on newlines, holding back a trailing partial line for the next chunk. */
function splitLines(buffer: string): [string[], string] {
  const lines = buffer.split('\n')
  const rest = lines.pop() ?? ''
  return [lines, rest]
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
  const calls: ToolCallSlot[] = []
  const usage: ChatUsage = {}
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    buffer += decoder.decode(value, { stream: true })
    const [lines, rest] = splitLines(buffer)
    buffer = rest
    for (const line of lines) {
      const chunk = parseDataLine(line)
      if (chunk === undefined) {
        continue
      }
      const delta = chunk.choices?.[0]?.delta
      if (delta?.content) {
        sink.text(delta.content)
      }
      stitchToolCalls(calls, delta?.tool_calls ?? [])
      if (chunk.usage !== undefined) {
        usage.promptTokens = chunk.usage.prompt_tokens
        usage.completionTokens = chunk.usage.completion_tokens
      }
      if (chunk.engined?.cost_usd !== undefined) {
        usage.costUsd = chunk.engined.cost_usd
      }
      if (chunk.usage !== undefined || chunk.engined?.cost_usd !== undefined) {
        sink.usage?.({ ...usage })
      }
    }
  }
  return calls
    .filter((c) => c.name.length > 0)
    .map((c, i) => ({
      id: c.id || `call_${i}`,
      name: c.name,
      arguments: parseArgs(c.args),
    }))
}
