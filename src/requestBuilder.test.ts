import { describe, expect, test } from 'bun:test'
import type { EnginedModelInfo } from './door.ts'
import { buildChatRequestBody } from './requestBuilder.ts'

function modelInfo(overrides: Partial<EnginedModelInfo['row']> = {}): EnginedModelInfo {
  const row = {
    id: '@/test/model',
    routeId: '@/test/model',
    door: { name: 'local', url: 'http://127.0.0.1:29200' },
    tools: true,
    serves: ['/openai/v1/chat/completions'],
    state: 'installed',
    capabilities: {},
    ...overrides,
  }
  return {
    id: row.id,
    name: row.id,
    family: 'test',
    version: row.id,
    detail: '',
    tooltip: '',
    maxInputTokens: 32768,
    maxOutputTokens: 8192,
    capabilities: { toolCalling: row.tools, imageInput: false },
    row,
  }
}

describe('buildChatRequestBody', () => {
  test('sends the door-owned routeId, not the qualified model id, as the request model', () => {
    const model = modelInfo({ id: 'gpu-box/@/llama/ornith', routeId: '@/llama/ornith' })
    const body = buildChatRequestBody(
      model,
      [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      { reasoningEffort: 'medium', reasoningEffortByModel: {} },
    )
    expect(body.model).toBe('@/llama/ornith')
  })

  test('drops tools entirely for a row with tools: false', () => {
    const model = modelInfo({ tools: false })
    const body = buildChatRequestBody(
      model,
      [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      {
        tools: [{ name: 'get_weather', description: 'weather', inputSchema: {} }],
        toolChoiceRequired: true,
        reasoningEffort: 'medium',
        reasoningEffortByModel: {},
      },
    )
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
  })

  test('maps Required tool mode to tool_choice: required', () => {
    const model = modelInfo()
    const body = buildChatRequestBody(
      model,
      [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      {
        tools: [{ name: 'get_weather', description: 'weather', inputSchema: {} }],
        toolChoiceRequired: true,
        reasoningEffort: 'medium',
        reasoningEffortByModel: {},
      },
    )
    expect(body.tool_choice).toBe('required')
    expect(body.tools).toHaveLength(1)
  })

  test('sends no reasoning_effort when the row declares no reasoning levels', () => {
    const model = modelInfo()
    const body = buildChatRequestBody(
      model,
      [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      {
        reasoningEffort: 'high',
        reasoningEffortByModel: {},
      },
    )
    expect(body.reasoning_effort).toBeUndefined()
  })

  test('snaps reasoning_effort to the row-listed level, preferring a per-model override', () => {
    const model = modelInfo({ capabilities: { reasoning: ['none', 'low', 'high'] } })
    const body = buildChatRequestBody(
      model,
      [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      {
        reasoningEffort: 'medium',
        reasoningEffortByModel: { [model.id]: 'xhigh' },
      },
    )
    expect(body.reasoning_effort).toBe('high')
  })

  test('a tool call/result pair becomes an assistant tool_calls message and a tool message', () => {
    const model = modelInfo()
    const body = buildChatRequestBody(
      model,
      [
        {
          role: 'assistant',
          parts: [
            {
              type: 'toolCall',
              id: 'call_1',
              name: 'get_weather',
              arguments: { city: 'Vancouver' },
            },
          ],
        },
        { role: 'user', parts: [{ type: 'toolResult', toolCallId: 'call_1', text: '10C' }] },
      ],
      { reasoningEffort: 'medium', reasoningEffortByModel: {} },
    )
    expect(body.messages).toEqual([
      {
        role: 'assistant',
        content: undefined,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Vancouver"}' },
          },
        ],
      },
      { role: 'tool', content: '10C', tool_call_id: 'call_1' },
    ])
  })
})
