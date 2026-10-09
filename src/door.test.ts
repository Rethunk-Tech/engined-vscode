import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDefaultModel } from './defaultModels.ts'
import type { Door, EnginedModelRow } from './door.ts'
import {
  doorByName,
  mapAnswerableRows,
  mapModelRow,
  mapModels,
  qualifiedEngineIds,
  qualifyId,
  reasoningLevelsFor,
  snapReasoningEffort,
  splitQualifiedId,
} from './door.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const models = JSON.parse(readFileSync(join(FIXTURES, 'models.json'), 'utf8'))
const DOOR: Door = { name: 'local', url: 'http://127.0.0.1:29200' }

describe('mapModels', () => {
  test('keeps every answerable chat-completions row, running ones included', () => {
    const mapped = mapModels(models, DOOR, 1)
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
    expect(mapModels({ data: [unavailable] }, DOOR, 1)).toEqual([])
  })

  test('falls back to id for display name and reports egress as detail', () => {
    const mapped = mapModels(models, DOOR, 1)
    const opus = mapped.find((m) => m.id === '@/claude/opus-5-5')
    expect(opus?.name).toBe('Claude Opus 5.5')
    expect(opus?.detail).toBe('remote')

    const noDisplayName = mapped.find((m) => m.id === '@/opencode/ornith')
    expect(noDisplayName?.name).toBe('@/opencode/ornith')
  })

  test('maps toolCalling and imageInput from row capabilities', () => {
    const mapped = mapModels(models, DOOR, 1)
    const sonnet = mapped.find((m) => m.id === '@/claude/sonnet-5')
    expect(sonnet?.capabilities.toolCalling).toBe(false)
    expect(sonnet?.capabilities.imageInput).toBe(true)
  })

  test('falls back to default context windows when the row reports none', () => {
    const mapped = mapModels(models, DOOR, 1)
    const opus = mapped.find((m) => m.id === '@/claude/opus-5-5')
    expect(opus?.maxInputTokens).toBe(32_768)
    expect(opus?.maxOutputTokens).toBe(8192)

    const sonnet = mapped.find((m) => m.id === '@/claude/sonnet-5')
    expect(sonnet?.maxInputTokens).toBe(200_000)
    expect(sonnet?.maxOutputTokens).toBe(64_000)
  })

  test('malformed body maps to an empty list rather than throwing', () => {
    expect(mapModels(undefined, DOOR, 1)).toEqual([])
    expect(mapModels({}, DOOR, 1)).toEqual([])
  })

  test('keeps vision rows out of the chat picker even though they serve chat completions', () => {
    const chatIds = new Set(mapModels(models, DOOR, 1).map((m) => m.id))
    expect(chatIds.has('@/llama/vision')).toBe(false)
    expect(chatIds.has('@/llama/ocr')).toBe(false)
    // Tools and defaults still see them -- only the chat picker excludes them.
    const rows = mapAnswerableRows(models, DOOR, 1)
    expect(rows.some((r) => r.id === '@/llama/vision')).toBe(true)
    expect(rows.some((r) => r.id === '@/llama/ocr')).toBe(true)
  })
})

describe('mapAnswerableRows', () => {
  test('keeps every non-unavailable row, chat or not -- what a tool picks a route from', () => {
    const rows = mapAnswerableRows(models, DOOR, 1)
    expect(rows.length).toBeGreaterThan(mapModels(models, DOOR, 1).length)
    expect(resolveDefaultModel(rows, 'image', '').row?.id).toBe('@/comfy/local')
    expect(resolveDefaultModel(rows, 'speech', '').row?.id).toBe('@/chatterbox-multi/local')
    expect(resolveDefaultModel(rows, 'transcription', '').row?.id).toBe('@/whisper/medium.en')

    // The chat provider's own list must still exclude these -- comfy/TTS/STT never serve chat.
    const chatIds = new Set(mapModels(models, DOOR, 1).map((m) => m.id))
    expect(chatIds.has('@/comfy/local')).toBe(false)
    expect(chatIds.has('@/chatterbox-multi/local')).toBe(false)
    expect(chatIds.has('@/whisper/medium.en')).toBe(false)
  })

  test('excludes unavailable rows the same way mapModels does', () => {
    const unavailable = { ...models.data[0], state: 'unavailable' }
    expect(mapAnswerableRows({ data: [unavailable] }, DOOR, 1)).toEqual([])
  })
})

describe('mapModelRow', () => {
  test('excludes a row that does not serve chat completions', () => {
    expect(
      mapModelRow({
        id: '@/whisper/small.en',
        routeId: '@/whisper/small.en',
        door: DOOR,
        tools: false,
        serves: ['/openai/v1/audio/transcriptions'],
        state: 'installed',
        capabilities: {},
      }),
    ).toBeUndefined()
  })

  test('one door: id stays the row id, and detail carries no door name', () => {
    const mapped = mapModels(models, DOOR, 1)
    const sonnet = mapped.find((m) => m.row.routeId === '@/claude/sonnet-5')
    expect(sonnet?.id).toBe('@/claude/sonnet-5')
    expect(sonnet?.row.id).toBe(sonnet?.row.routeId)
    expect(sonnet?.detail).not.toContain(DOOR.name)
  })

  test('more than one door: id is qualified, and detail names the door', () => {
    const mapped = mapModels(models, DOOR, 2)
    const sonnet = mapped.find((m) => m.row.routeId === '@/claude/sonnet-5')
    expect(sonnet?.id).toBe(`${DOOR.name}/@/claude/sonnet-5`)
    expect(sonnet?.row.routeId).toBe('@/claude/sonnet-5')
    expect(sonnet?.detail).toContain(DOOR.name)
  })
})

describe('reasoning effort', () => {
  test('reasoningLevelsFor is undefined when the row declares none', () => {
    expect(
      reasoningLevelsFor({
        id: 'x',
        routeId: 'x',
        door: DOOR,
        tools: false,
        serves: [],
        state: 'installed',
        capabilities: {},
      }),
    ).toBeUndefined()
  })

  test('sonnet-5 declares reasoning; snapping picks the nearest listed level', () => {
    const mapped = mapModels(models, DOOR, 1)
    const sonnet = mapped.find((m) => m.id === '@/claude/sonnet-5')
    if (sonnet === undefined) {
      throw new Error('sonnet-5 row missing')
    }
    const levels = reasoningLevelsFor(sonnet.row)
    if (levels === undefined) {
      throw new Error('sonnet-5 declares no reasoning levels')
    }
    expect(levels).toEqual(['none', 'low', 'high'])
    expect(snapReasoningEffort('medium', levels)).toBe('low')
    expect(snapReasoningEffort('xhigh', levels)).toBe('high')
    expect(snapReasoningEffort('none', levels)).toBe('none')
  })
})

describe('qualifyId', () => {
  test('stays plain with one door -- existing single-door settings keep working', () => {
    expect(qualifyId('local', '@/llama/ornith', 1)).toBe('@/llama/ornith')
  })

  test('is prefixed with the door name once more than one door is configured', () => {
    expect(qualifyId('gpu-box', '@/llama/ornith', 2)).toBe('gpu-box/@/llama/ornith')
  })
})

describe('splitQualifiedId', () => {
  test('one door: never split, whatever the id looks like', () => {
    expect(splitQualifiedId('gpu-box/@/llama/ornith', 1)).toEqual({
      doorName: undefined,
      rawId: 'gpu-box/@/llama/ornith',
    })
  })

  test('more than one door: splits on the first slash', () => {
    expect(splitQualifiedId('gpu-box/@/llama/ornith', 2)).toEqual({
      doorName: 'gpu-box',
      rawId: '@/llama/ornith',
    })
  })

  test('more than one door, no slash in the id: no door name', () => {
    expect(splitQualifiedId('claude', 2)).toEqual({ doorName: undefined, rawId: 'claude' })
  })
})

describe('doorByName', () => {
  const local: Door = { name: 'local', url: 'http://127.0.0.1:29200' }
  const gpuBox: Door = { name: 'gpu-box', url: 'http://10.0.0.5:29200' }

  test('finds the named door', () => {
    expect(doorByName([local, gpuBox], 'gpu-box')).toEqual(gpuBox)
  })

  test('falls back to the first door when the name is undefined or unknown', () => {
    expect(doorByName([local, gpuBox], undefined)).toEqual(local)
    expect(doorByName([local, gpuBox], 'nonexistent')).toEqual(local)
  })
})

describe('qualifiedEngineIds', () => {
  const local: Door = { name: 'local', url: 'http://127.0.0.1:29200' }
  const gpuBox: Door = { name: 'gpu-box', url: 'http://10.0.0.5:29200' }

  function row(id: string, engine: string, door: Door): EnginedModelRow {
    return {
      id,
      routeId: id,
      door,
      engine,
      tools: false,
      serves: [],
      state: 'installed',
      capabilities: {},
    }
  }

  test('one distinct id per engine, routed to the door that reported it', () => {
    const ids = qualifiedEngineIds([row('a', 'llama', local), row('b', 'claude', local)], 1)
    expect(ids).toEqual([
      { id: 'claude', door: local, rawId: 'claude' },
      { id: 'llama', door: local, rawId: 'llama' },
    ])
  })

  test('the same engine name on two doors stays two distinct qualified ids', () => {
    const ids = qualifiedEngineIds([row('a', 'llama', local), row('b', 'llama', gpuBox)], 2)
    expect(ids.map((e) => e.id)).toEqual(['gpu-box/llama', 'local/llama'])
    expect(ids.find((e) => e.id === 'gpu-box/llama')?.door).toEqual(gpuBox)
  })
})
