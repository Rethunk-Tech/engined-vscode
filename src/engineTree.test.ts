import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Door } from './door.ts'
import {
  type EnginesListResponse,
  formatResourceLine,
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

  test('a held id (qualified) is reflected in the description', () => {
    const nodes = toEngineNodes(engines, { heldIds: new Set(['llama']), door: DOOR, doorCount: 1 })
    const llama = nodes.find((n) => n.id === 'llama')
    expect(llama?.description).toContain('held')
    const comfy = nodes.find((n) => n.id === 'comfy')
    expect(comfy?.description).not.toContain('held')
  })

  test('missing response maps to no nodes', () => {
    expect(toEngineNodes(undefined, { heldIds: new Set(), door: DOOR, doorCount: 1 })).toEqual([])
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
