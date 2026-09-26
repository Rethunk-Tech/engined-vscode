import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatResourceLines, stateIcon, toEngineNodes, truncateLogLines } from './engineTree.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const engines = JSON.parse(readFileSync(join(FIXTURES, 'engines.json'), 'utf8'))

describe('toEngineNodes', () => {
  test('maps every recorded engine, one node per id', () => {
    const nodes = toEngineNodes(engines, new Set())
    expect(nodes.length).toBe(engines.engines.length)
    expect(nodes.map((n) => n.id)).toEqual(engines.engines.map((e: { id: string }) => e.id))
  })

  test('an unavailable engine gets the engine-unavailable contextValue and its fix as tooltip', () => {
    const nodes = toEngineNodes(engines, new Set())
    const openai = nodes.find((n) => n.id === 'openai')
    expect(openai?.contextValue).toBe('engine-unavailable')
    expect(openai?.fix).toBeDefined()
    expect(openai?.tooltip).toBe(openai?.fix)
  })

  test('an installed engine gets the plain engine contextValue', () => {
    const nodes = toEngineNodes(engines, new Set())
    const llama = nodes.find((n) => n.id === 'llama')
    expect(llama?.contextValue).toBe('engine')
  })

  test('a held id is reflected in the description', () => {
    const nodes = toEngineNodes(engines, new Set(['llama']))
    const llama = nodes.find((n) => n.id === 'llama')
    expect(llama?.description).toContain('held')
    const comfy = nodes.find((n) => n.id === 'comfy')
    expect(comfy?.description).not.toContain('held')
  })

  test('missing response maps to no nodes', () => {
    expect(toEngineNodes(undefined, new Set())).toEqual([])
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

describe('formatResourceLines', () => {
  test('an error response becomes its one line', () => {
    expect(formatResourceLines({ error: '"llama" is not running' })).toEqual([
      '"llama" is not running',
    ])
  })

  test('a resources object becomes one "key: value" line per field', () => {
    expect(formatResourceLines({ cgroup_bytes: 1024, graphics_bytes: 2048 })).toEqual([
      'cgroup_bytes: 1024',
      'graphics_bytes: 2048',
    ])
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
