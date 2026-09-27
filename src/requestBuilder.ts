/**
 * VS Code-shaped plain messages -> the OpenAI chat completion request body
 * engined's door accepts. Pure and vscode-free: the adapter converts real
 * `vscode.LanguageModelChatRequestMessage` values into these plain shapes
 * first, which is also what lets this file's logic run under `bun test`.
 */

import type { EnginedModelInfo, ReasoningLevel } from './door.ts'
import { reasoningLevelsFor, snapReasoningEffort } from './door.ts'

export type PlainMessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; base64: string }
  | { type: 'toolCall'; id: string; name: string; arguments: unknown }
  | { type: 'toolResult'; toolCallId: string; text: string }

export interface PlainMessage {
  role: 'user' | 'assistant'
  parts: PlainMessagePart[]
}

export interface PlainTool {
  name: string
  description: string
  inputSchema?: unknown
}

export interface ChatRequestOptions {
  tools?: PlainTool[]
  /** `true` when the caller's `toolMode` is `Required`; `false`/absent maps to no `tool_choice`. */
  toolChoiceRequired?: boolean
  reasoningEffort: ReasoningLevel
  reasoningEffortByModel: Record<string, ReasoningLevel>
}

interface OpenAiContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OpenAiMessage {
  role: 'user' | 'assistant' | 'tool'
  content?: string | OpenAiContentPart[]
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
}

export interface OpenAiChatRequestBody {
  model: string
  messages: OpenAiMessage[]
  stream: true
  stream_options: { include_usage: true }
  tools?: unknown[]
  tool_choice?: 'required'
  reasoning_effort?: ReasoningLevel
}

/** A message's non-tool-call parts as OpenAI content -- a plain string when it is text-only, otherwise the multipart array a vision model needs. */
function toOpenAiContent(parts: PlainMessagePart[]): string | OpenAiContentPart[] {
  const contentParts = parts.filter((p) => p.type === 'text' || p.type === 'image')
  if (contentParts.every((p) => p.type === 'text')) {
    return contentParts.map((p) => (p as { text: string }).text).join('')
  }
  return contentParts.map((p) =>
    p.type === 'text'
      ? { type: 'text' as const, text: p.text }
      : { type: 'image_url' as const, image_url: { url: `data:${p.mimeType};base64,${p.base64}` } },
  )
}

/**
 * One VS Code-shaped message may carry a tool result, which OpenAI expects
 * as its own `role: "tool"` message rather than folded into the turn that
 * asked for it -- so one input message can become several OpenAI ones.
 */
function toOpenAiMessages(message: PlainMessage): OpenAiMessage[] {
  const toolCalls = message.parts.filter((p) => p.type === 'toolCall') as Extract<
    PlainMessagePart,
    { type: 'toolCall' }
  >[]
  const toolResults = message.parts.filter((p) => p.type === 'toolResult') as Extract<
    PlainMessagePart,
    { type: 'toolResult' }
  >[]
  const out: OpenAiMessage[] = []
  const content = toOpenAiContent(message.parts)
  if (content.length > 0 || toolCalls.length > 0) {
    out.push({
      role: message.role,
      content: content.length > 0 ? content : undefined,
      tool_calls:
        toolCalls.length > 0
          ? toolCalls.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
            }))
          : undefined,
    })
  }
  for (const result of toolResults) {
    out.push({ role: 'tool', content: result.text, tool_call_id: result.toolCallId })
  }
  return out
}

/** The per-model override, else the global setting, snapped to a level the row actually lists; `undefined` when the row lists none. */
function resolveReasoningEffort(
  model: EnginedModelInfo,
  options: ChatRequestOptions,
): ReasoningLevel | undefined {
  const levels = reasoningLevelsFor(model.row)
  if (levels === undefined) {
    return undefined
  }
  const requested = options.reasoningEffortByModel[model.id] ?? options.reasoningEffort
  return snapReasoningEffort(requested, levels)
}

/**
 * Build the request body, or throw when the caller asked for tools/tool_choice
 * against a row that cannot forward them -- the door refuses that request
 * itself (engined src/responses.ts:133-147), so this never sends it.
 */
export function buildChatRequestBody(
  model: EnginedModelInfo,
  messages: PlainMessage[],
  options: ChatRequestOptions,
): OpenAiChatRequestBody {
  const body: OpenAiChatRequestBody = {
    model: model.id,
    messages: messages.flatMap(toOpenAiMessages),
    stream: true,
    stream_options: { include_usage: true },
  }
  if (model.row.tools && options.tools !== undefined && options.tools.length > 0) {
    body.tools = options.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }))
    if (options.toolChoiceRequired === true) {
      body.tool_choice = 'required'
    }
  }
  const reasoningEffort = resolveReasoningEffort(model, options)
  if (reasoningEffort !== undefined) {
    body.reasoning_effort = reasoningEffort
  }
  return body
}

/** `Math.ceil(chars / 3)`: deliberately an over-count, never used to load a model -- engined's own tokenizer runs the model in router mode, which this extension must not trigger just to count. */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 3)
}

/** A plain message's literal-text content: its text and tool-call-argument JSON, concatenated -- what a real tokenize call or the chars/3 estimate both count against. */
export function plainMessageContent(message: PlainMessage): string {
  let content = ''
  for (const part of message.parts) {
    if (part.type === 'text') {
      content += part.text
    } else if (part.type === 'toolCall') {
      content += JSON.stringify(part.arguments ?? {})
    } else if (part.type === 'toolResult') {
      content += part.text
    }
  }
  return content
}

/** A plain message's token estimate: its text and tool-call-argument JSON, summed. */
export function estimateMessageTokenCount(message: PlainMessage): number {
  return estimateTokenCount(plainMessageContent(message))
}
