import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  mapAnswerableRows,
  mapModelRow,
  mapModels,
  reasoningLevelsFor,
  snapReasoningEffort,
} from './door.ts'
import { pickRoute } from './toolRequests.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const models = JSON.parse(readFileSync(join(FIXTURES, 'models.json'), 'utf8'))

describe('mapModels', () => {
  test('keeps every answerable chat-completions row, running ones included', () => {
    const mapped = mapModels(models)
    expect(mapped.length).toBeGreaterThan(0)
    for (const m of mapped) {
      expect(m.row.serves).toContain('/openai/v1/chat/completions')
      expect(m.row.state).not.toBe('unavailable')
    }
    // A model in use reports `running`; dropping it made the selected model vanish mid-session.
    expect(mapped.find((m) => m.id === '@/llama/ornith')?.row.state).toBe('running')
    const unavailable = {
      ...models.data.find((r: { id: string }) => r.id === '@/llama/ornith'),
      state: 'unavailable',
    }
    expect(mapModels({ data: [unavailable] })).toEqual([])
  })

  test('falls back to id for display name and reports egress as detail', () => {
    const mapped = mapModels(models)
    const opus = mapped.find((m) => m.id === '@/claude/opus-5-5')
    expect(opus?.name).toBe('Claude Opus 5.5')
    expect(opus?.detail).toBe('remote')

    const noDisplayName = mapped.find((m) => m.id === '@/opencode/ornith')
    expect(noDisplayName?.name).toBe('@/opencode/ornith')
  })

  test('maps toolCalling and imageInput from row capabilities', () => {
    const mapped = mapModels(models)
    const sonnet = mapped.find((m) => m.id === '@/claude/sonnet-5')
    expect(sonnet?.capabilities.toolCalling).toBe(false)
    expect(sonnet?.capabilities.imageInput).toBe(true)
  })

  test('falls back to default context windows when the row reports none', () => {
    const mapped = mapModels(models)
    const opus = mapped.find((m) => m.id === '@/claude/opus-5-5')
    expect(opus?.maxInputTokens).toBe(32768)
    expect(opus?.maxOutputTokens).toBe(8192)

    const sonnet = mapped.find((m) => m.id === '@/claude/sonnet-5')
    expect(sonnet?.maxInputTokens).toBe(200000)
    expect(sonnet?.maxOutputTokens).toBe(64000)
  })

  test('malformed body maps to an empty list rather than throwing', () => {
    expect(mapModels(undefined)).toEqual([])
    expect(mapModels({})).toEqual([])
  })
})

describe('mapAnswerableRows', () => {
  test('keeps every non-unavailable row, chat or not -- what a tool picks a route from', () => {
    const rows = mapAnswerableRows(models)
    expect(rows.length).toBeGreaterThan(mapModels(models).length)
    expect(pickRoute(rows, '/openai/v1/images/generations', 'image generation').id).toBe(
      '@/comfy/local',
    )
    expect(pickRoute(rows, '/openai/v1/audio/speech', 'text-to-speech').id).toBe(
      '@/chatterbox-multi/local',
    )
    expect(pickRoute(rows, '/openai/v1/audio/transcriptions', 'audio transcription').id).toBe(
      '@/whisper/medium.en',
    )

    // The chat provider's own list must still exclude these -- comfy/TTS/STT never serve chat.
    const chatIds = new Set(mapModels(models).map((m) => m.id))
    expect(chatIds.has('@/comfy/local')).toBe(false)
    expect(chatIds.has('@/chatterbox-multi/local')).toBe(false)
    expect(chatIds.has('@/whisper/medium.en')).toBe(false)
  })

  test('excludes unavailable rows the same way mapModels does', () => {
    const unavailable = { ...models.data[0], state: 'unavailable' }
    expect(mapAnswerableRows({ data: [unavailable] })).toEqual([])
  })
})

describe('mapModelRow', () => {
  test('excludes a row that does not serve chat completions', () => {
    expect(
      mapModelRow({
        id: '@/whisper/small.en',
        tools: false,
        serves: ['/openai/v1/audio/transcriptions'],
        state: 'installed',
        capabilities: {},
      }),
    ).toBeUndefined()
  })
})

describe('reasoning effort', () => {
  test('reasoningLevelsFor is undefined when the row declares none', () => {
    expect(
      reasoningLevelsFor({
        id: 'x',
        tools: false,
        serves: [],
        state: 'installed',
        capabilities: {},
      }),
    ).toBeUndefined()
  })

  test('sonnet-5 declares reasoning; snapping picks the nearest listed level', () => {
    const mapped = mapModels(models)
    const sonnet = mapped.find((m) => m.id === '@/claude/sonnet-5')
    const levels = reasoningLevelsFor(sonnet!.row)
    expect(levels).toEqual(['none', 'low', 'high'])
    expect(snapReasoningEffort('medium', levels!)).toBe('low')
    expect(snapReasoningEffort('xhigh', levels!)).toBe('high')
    expect(snapReasoningEffort('none', levels!)).toBe('none')
  })
})
