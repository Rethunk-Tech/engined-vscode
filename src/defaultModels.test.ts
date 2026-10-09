import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareCodeUnits } from './compareCodeUnits.ts'
import {
  DEFAULT_MODEL_ROLES,
  qualifyingRows,
  ROLE_PATH,
  resolveDefaultModel,
} from './defaultModels.ts'
import type { Door, EnginedModelRow } from './door.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const models: { data: EnginedModelRow[] } = JSON.parse(
  readFileSync(join(FIXTURES, 'models.json'), 'utf8'),
)
const rows = models.data
const DOOR: Door = { name: 'local', url: 'http://127.0.0.1:29200' }

const completionRows: EnginedModelRow[] = [
  {
    id: '@/llama/ornith',
    routeId: '@/llama/ornith',
    door: DOOR,
    tools: false,
    serves: ['/openai/v1/chat/completions', '/openai/v1/completions'],
    state: 'installed',
    capabilities: {},
  },
  {
    id: '@/llama/second',
    routeId: '@/llama/second',
    door: DOOR,
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

  test('a setting written before a second door existed still matches by its bare routeId', () => {
    const qualifiedRows: EnginedModelRow[] = completionRows.map((row) => ({
      ...row,
      id: `${DOOR.name}/${row.id}`,
    }))
    const resolved = resolveDefaultModel(qualifiedRows, 'completion', '@/llama/second')
    expect(resolved.row?.id).toBe(`${DOOR.name}/@/llama/second`)
    expect(resolved.unusableReason).toBeUndefined()
  })
})

describe('DEFAULT_MODEL_ROLES', () => {
  test('covers every ModelRole exactly once', () => {
    const roles: string[] = DEFAULT_MODEL_ROLES.map((r) => r.role)
    expect(new Set(roles).size).toBe(roles.length)
    expect(roles.sort(compareCodeUnits)).toEqual(Object.keys(ROLE_PATH).sort(compareCodeUnits))
  })

  test('matches the engined.defaultModels.* keys package.json declares, one role each', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
    const properties = pkg.contributes.configuration.properties as Record<string, unknown>
    const settingRoles = Object.keys(properties)
      .map((key) => /^engined\.defaultModels\.(\w+)$/.exec(key)?.[1])
      .filter((role): role is string => role !== undefined)
      .sort(compareCodeUnits)
    const roles: string[] = DEFAULT_MODEL_ROLES.map((r) => r.role)
    expect(roles.sort(compareCodeUnits)).toEqual(settingRoles)
  })

  test('every role has a non-empty chooser and popup label', () => {
    for (const r of DEFAULT_MODEL_ROLES) {
      expect(r.chooserLabel.length).toBeGreaterThan(0)
      expect(r.popupLabel.length).toBeGreaterThan(0)
    }
  })
})
