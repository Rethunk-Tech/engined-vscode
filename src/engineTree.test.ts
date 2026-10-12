import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Door } from './door.ts'
import {
  type EnginesListResponse,
  formatResourceLine,
  releaseHoldIds,
  stateIcon,
  toEngineNodes,
  truncateLogLines,
} from './engineTree.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const engines: EnginesListResponse = JSON.parse(
  readFileSync(join(FIXTURES, 'engines.json'), 'utf8'),
)

const DOOR: Door = { name: 'local', url: 'http://127.0.0.1:29200' }

describe('toEngineNodes', () => {
  test('maps every recorded engine, one node per id, unqualified with one door', () => {
    const nodes = toEngineNodes(engines, { heldIds: new Set(), door: DOOR, doorCount: 1 })
    expect(nodes.length).toBe(engines.engines.length)
    expect(nodes.map((n) => n.id)).toEqual(engines.engines.map((e) => e.id))
  })

  test('more than one door qualifies every id and carries the door through', () => {
    const nodes = toEngineNodes(engines, { heldIds: new Set(), door: DOOR, doorCount: 2 })
    const llama = nodes.find((n) => n.rawId === 'llama')
    expect(llama?.id).toBe('local/llama')
    expect(llama?.door).toEqual(DOOR)
  })

  test('an unavailable engine gets the engine-unavailable contextValue, its fix as tooltip and description, and no resources', () => {
    const nodes = toEngineNodes(engines, { heldIds: new Set(), door: DOOR, doorCount: 1 })
    const openai = nodes.find((n) => n.id === 'openai')
    expect(openai?.contextValue).toBe('engine-unavailable')
    expect(openai?.fix).toBeDefined()
    expect(openai?.tooltip).toBe(openai?.fix)
    expect(openai?.description).toContain(openai?.fix)
    expect(openai?.hasResources).toBe(false)
  })

  test('an agentic-cli engine never has resources and says so in its description', () => {
    const nodes = toEngineNodes(engines, { heldIds: new Set(), door: DOOR, doorCount: 1 })
    const claude = nodes.find((n) => n.id === 'claude')
    expect(claude?.contextValue).toBe('engine')
    expect(claude?.hasResources).toBe(false)
    expect(claude?.description).toContain('agent CLI, no container')
  })

  test('a remote row backing an engine marks it remote, with no resources', () => {
    const remoteRow: EnginesListResponse = {
      engines: [{ id: 'openrouter', kind: 'openai-http', state: 'installed' }],
    }
    const nodes = toEngineNodes(remoteRow, {
      heldIds: new Set(),
      door: DOOR,
      doorCount: 1,
      isRemote: (id) => id === 'openrouter',
    })
    const [node] = nodes
    expect(node?.hasResources).toBe(false)
    expect(node?.description).toContain('remote API')
  })

  test('an installed local container engine (not running) is idle, not fetched', () => {
    const nodes = toEngineNodes(engines, { heldIds: new Set(), door: DOOR, doorCount: 1 })
    const llama = nodes.find((n) => n.id === 'llama')
    expect(llama?.contextValue).toBe('engine')
    expect(llama?.hasResources).toBe(false)
    expect(llama?.description).toContain('idle, starts on demand')
  })

  test('a running local container engine has resources', () => {
    const runningRow: EnginesListResponse = {
      engines: [{ id: 'llama', kind: 'openai-http', state: 'running' }],
    }
    const nodes = toEngineNodes(runningRow, { heldIds: new Set(), door: DOOR, doorCount: 1 })
    expect(nodes[0]?.hasResources).toBe(true)
    expect(nodes[0]?.description).not.toContain('idle')
  })

  test('queued callers append the waiting total and the tooltip names each busy role', () => {
    const response: EnginesListResponse = {
      engines: [
        {
          id: 'llama',
          kind: 'llama',
          state: 'running',
          active_leases: 1,
          roles: [
            { role: 'chat', active: 1, waiting: 3 },
            { role: 'embedding', active: 0, waiting: 0 },
            { role: 'vision', active: 1, waiting: 1 },
          ],
        },
      ],
    }
    const [node] = toEngineNodes(response, { heldIds: new Set(), door: DOOR, doorCount: 1 })
    expect(node?.description).toBe('llama · running · 4 waiting')
    expect(node?.tooltip).toBe('chat 1 active, 3 waiting\nvision 1 active, 1 waiting')
    expect(node?.hasResources).toBe(true)
    expect(node?.heldUntil).toBeUndefined()
  })

  test('three callers queued on one role read as that waiting total', () => {
    const response: EnginesListResponse = {
      engines: [
        {
          id: 'llama',
          kind: 'llama',
          state: 'running',
          roles: [{ role: 'chat', active: 1, waiting: 3 }],
        },
      ],
    }
    const [node] = toEngineNodes(response, { heldIds: new Set(), door: DOOR, doorCount: 1 })
    expect(node?.description).toBe('llama · running · 3 waiting')
    expect(node?.tooltip).toBe('chat 1 active, 3 waiting')
  })

  test('a busy role with nobody queued does not append a waiting total, and leases without roles show on the tooltip', () => {
    const response: EnginesListResponse = {
      engines: [
        {
          id: 'llama',
          kind: 'openai-http',
          state: 'running',
          roles: [{ role: 'chat', active: 1, waiting: 0 }],
        },
        { id: 'kokoro', kind: 'tts', state: 'running', active_leases: 2 },
        { id: 'piper', kind: 'tts', state: 'running', active_leases: 0 },
      ],
    }
    const nodes = toEngineNodes(response, { heldIds: new Set(), door: DOOR, doorCount: 1 })
    const llama = nodes.find((n) => n.id === 'llama')
    expect(llama?.description).toBe('openai-http · running')
    expect(llama?.tooltip).toBe('chat 1 active, 0 waiting')
    const kokoro = nodes.find((n) => n.id === 'kokoro')
    expect(kokoro?.description).toBe('tts · running')
    expect(kokoro?.tooltip).toBe('tts · running\n2 active')
    expect(kokoro?.hasResources).toBe(true)
    const piper = nodes.find((n) => n.id === 'piper')
    expect(piper?.tooltip).toBe(piper?.description)
  })

  test('a held id (qualified) is reflected in the description', () => {
    const nodes = toEngineNodes(engines, { heldIds: new Set(['llama']), door: DOOR, doorCount: 1 })
    const llama = nodes.find((n) => n.id === 'llama')
    expect(llama?.description).toContain('held')
    expect(llama?.description).not.toContain('until')
    const comfy = nodes.find((n) => n.id === 'comfy')
    expect(comfy?.description).not.toContain('held')
  })

  test('a future held_until marks the row and appends the time; a past, equal, or unparseable one does not', () => {
    const now = Date.parse('2026-10-11T18:00:00.000Z')
    const response: EnginesListResponse = {
      engines: [
        {
          id: 'llama',
          kind: 'openai-http',
          state: 'installed',
          held_until: '2026-10-11T19:00:00.000Z',
        },
        {
          id: 'comfy',
          kind: 'openai-http',
          state: 'installed',
          held_until: '2026-10-11T17:00:00.000Z',
        },
        {
          id: 'whisper',
          kind: 'openai-http',
          state: 'installed',
          held_until: '2026-10-11T18:00:00.000Z',
        },
        { id: 'claude', kind: 'agentic-cli', state: 'installed', held_until: 'not-a-time' },
      ],
    }
    const nodes = toEngineNodes(response, { heldIds: new Set(), door: DOOR, doorCount: 1, now })
    const llama = nodes.find((n) => n.id === 'llama')
    expect(llama?.heldUntil).toBe('2026-10-11T19:00:00.000Z')
    expect(llama?.description).toContain('held until 2026-10-11T19:00:00.000Z')
    for (const id of ['comfy', 'whisper', 'claude']) {
      const node = nodes.find((n) => n.id === id)
      expect(node?.heldUntil).toBeUndefined()
      expect(node?.description).not.toContain('held')
    }
  })

  test('release candidates are the session set plus rows still held by the list', () => {
    expect(releaseHoldIds(new Set(['llama', 'comfy']), ['comfy', 'whisper'])).toEqual([
      'comfy',
      'llama',
      'whisper',
    ])
    expect(releaseHoldIds(new Set(), [])).toEqual([])
  })

  test('missing response maps to no nodes', () => {
    expect(toEngineNodes(undefined, { heldIds: new Set(), door: DOOR, doorCount: 1 })).toEqual([])
  })
})

describe('idle deadline', () => {
  test('a future idle_until appends the deadline; a past, equal, missing, or unparseable one adds nothing', () => {
    const now = Date.parse('2026-10-11T18:00:00.000Z')
    const response: EnginesListResponse = {
      engines: [
        {
          id: 'llama',
          kind: 'openai-http',
          state: 'running',
          active_leases: 0,
          idle_until: '2026-10-11T19:00:00.000Z',
        },
        {
          id: 'comfy',
          kind: 'openai-http',
          state: 'running',
          idle_until: '2026-10-11T17:00:00.000Z',
        },
        {
          id: 'whisper',
          kind: 'openai-http',
          state: 'running',
          idle_until: '2026-10-11T18:00:00.000Z',
        },
        { id: 'piper', kind: 'tts', state: 'running' },
        { id: 'kokoro', kind: 'tts', state: 'running', idle_until: 'not-a-time' },
      ],
    }
    const nodes = toEngineNodes(response, { heldIds: new Set(), door: DOOR, doorCount: 1, now })
    const llama = nodes.find((n) => n.id === 'llama')
    expect(llama?.description).toBe('openai-http · running · idle until 2026-10-11T19:00:00.000Z')
    expect(llama?.hasResources).toBe(true)
    expect(llama?.heldUntil).toBeUndefined()
    for (const id of ['comfy', 'whisper', 'piper', 'kokoro']) {
      const node = nodes.find((n) => n.id === id)
      expect(node?.description).not.toContain('until')
      expect(node?.hasResources).toBe(true)
    }
  })
})

describe('superseded config', () => {
  test('a superseded path appends config stale and the stop path; a row without the field does not', () => {
    const response: EnginesListResponse = {
      engines: [
        {
          id: 'llama',
          kind: 'openai-http',
          state: 'running',
          superseded: '/engined/v1/engines/llama/stop',
        },
        { id: 'comfy', kind: 'openai-http', state: 'running' },
      ],
    }
    const nodes = toEngineNodes(response, { heldIds: new Set(), door: DOOR, doorCount: 1 })
    const llama = nodes.find((n) => n.id === 'llama')
    expect(llama?.description).toBe(
      'openai-http · running · config stale /engined/v1/engines/llama/stop',
    )
    expect(llama?.tooltip).toContain('/engined/v1/engines/llama/stop')
    const comfy = nodes.find((n) => n.id === 'comfy')
    expect(comfy?.description).toBe('openai-http · running')
    expect(comfy?.description).not.toContain('config stale')
  })
})

describe('stateIcon', () => {
  test('a distinct icon per known state, falling back for anything else', () => {
    expect(stateIcon('running')).toBe('pass-filled')
    expect(stateIcon('warming')).toBe('sync~spin')
    expect(stateIcon('unavailable')).toBe('error')
    expect(stateIcon('installed')).toBe('circle-outline')
    expect(stateIcon('something-new')).toBe('circle-outline')
  })
})

describe('formatResourceLine', () => {
  test('an error response becomes its one line', () => {
    expect(
      formatResourceLine({
        error: {
          message: '"llama" is not running',
          type: 'not_found_error',
          param: null,
          code: null,
        },
      }),
    ).toBe('"llama" is not running')
  })

  test('both figures, 1024-based, one decimal from GiB up', () => {
    expect(formatResourceLine({ memory_bytes: 350_208, graphics_bytes: 30_026_362_880 })).toBe(
      'RAM 342 KiB · GPU 28.0 GiB',
    )
  })

  test('a null figure is omitted, not shown as zero', () => {
    expect(formatResourceLine({ memory_bytes: null, graphics_bytes: 0 })).toBe('GPU 0 KiB')
  })

  test('both null reports no data', () => {
    expect(formatResourceLine({ memory_bytes: null, graphics_bytes: null })).toBe(
      'no resource data',
    )
  })
})

describe('truncateLogLines', () => {
  test('keeps everything under the cap', () => {
    expect(truncateLogLines(['a', 'b'])).toEqual(['a', 'b'])
  })

  test('keeps only the last 500 lines once over the cap', () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i}`)
    const truncated = truncateLogLines(lines)
    expect(truncated).toHaveLength(500)
    expect(truncated[0]).toBe('line 100')
    expect(truncated.at(-1)).toBe('line 599')
  })
})
