import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { qualifyingRows, resolveDefaultModel } from './defaultModels.ts'
import type { EnginedModelRow } from './door.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const models: { data: EnginedModelRow[] } = JSON.parse(
  readFileSync(join(FIXTURES, 'models.json'), 'utf8'),
)
const rows = models.data

const completionRows: EnginedModelRow[] = [
  {
    id: '@/llama/ornith',
    tools: false,
    serves: ['/openai/v1/chat/completions', '/openai/v1/completions'],
    state: 'installed',
    capabilities: {},
  },
  {
    id: '@/llama/second',
    tools: false,
    serves: ['/openai/v1/completions'],
    state: 'installed',
    capabilities: {},
  },
]

describe('resolveDefaultModel: image', () => {
  test('empty setting -> automatic pick (comfy)', () => {
    expect(resolveDefaultModel(rows, 'image', '').row?.id).toBe('@/comfy/local')
  })

  test('configured id wins when it qualifies', () => {
    expect(resolveDefaultModel(rows, 'image', '@/comfy/local').row?.id).toBe('@/comfy/local')
  })

  test('an unusable configured id falls back to automatic, with a reason', () => {
    const resolved = resolveDefaultModel(rows, 'image', '@/claude/sonnet-5')
    expect(resolved.row?.id).toBe('@/comfy/local')
    expect(resolved.unusableReason).toContain('@/claude/sonnet-5')
  })

  test('a configured id that does not exist at all falls back, with a reason', () => {
    const resolved = resolveDefaultModel(rows, 'image', '@/nope/nope')
    expect(resolved.row?.id).toBe('@/comfy/local')
    expect(resolved.unusableReason).toContain('not an installed engined route')
  })
})

describe('resolveDefaultModel: ocr and vision', () => {
  test('ocr picks the vision: "read" row, vision picks vision: "describe"', () => {
    expect(resolveDefaultModel(rows, 'ocr', '').row?.id).toBe('@/llama/ocr')
    expect(resolveDefaultModel(rows, 'vision', '').row?.id).toBe('@/llama/vision')
  })

  test('a describe row configured for ocr does not qualify -- wrong vision kind', () => {
    const resolved = resolveDefaultModel(rows, 'ocr', '@/llama/vision')
    expect(resolved.row?.id).toBe('@/llama/ocr')
    expect(resolved.unusableReason).toContain('@/llama/vision')
  })

  test('qualifyingRows for vision never includes the ocr row', () => {
    const vision = qualifyingRows(rows, 'vision')
    expect(vision.map((r) => r.id)).not.toContain('@/llama/ocr')
  })
})

describe('resolveDefaultModel: speech and transcription', () => {
  test('empty setting picks the first installed route for each', () => {
    expect(resolveDefaultModel(rows, 'speech', '').row?.id).toBe('@/chatterbox-multi/local')
    expect(resolveDefaultModel(rows, 'transcription', '').row?.id).toBe('@/whisper/medium.en')
  })

  test('configured id wins when it serves the role', () => {
    expect(resolveDefaultModel(rows, 'speech', '@/piper/local').row?.id).toBe('@/piper/local')
  })
})

describe('resolveDefaultModel: completion', () => {
  test('empty setting picks the first completions-serving row', () => {
    expect(resolveDefaultModel(completionRows, 'completion', '').row?.id).toBe('@/llama/ornith')
  })

  test('configured id wins even when it is completions-only (never chat)', () => {
    expect(resolveDefaultModel(completionRows, 'completion', '@/llama/second').row?.id).toBe(
      '@/llama/second',
    )
  })
})
