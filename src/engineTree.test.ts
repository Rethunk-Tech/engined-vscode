import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Door } from './door.ts'
import {
  copyFixText,
  doorGroupNote,
  type EnginesListResponse,
  emptyListedMessage,
  enginesViewMessage,
  formatResourceLine,
  onlyRemoteEngineIds,
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

  test('a queued role names the model the door sent, and a role without one does not', () => {
    const response: EnginesListResponse = {
      engines: [
        {
          id: 'llama',
          kind: 'llama',
          state: 'running',
          roles: [{ role: 'chat', active: 0, waiting: 2, model: 'foo.gguf' }],
        },
        {
          id: 'comfy',
          kind: 'openai-http',
          state: 'running',
          roles: [{ role: 'chat', active: 1, waiting: 0 }],
        },
        {
          id: 'vision',
          kind: 'llama',
          state: 'running',
          roles: [{ role: 'vision', active: 1, waiting: 0, model: 'see.gguf' }],
        },
      ],
    }
    const nodes = toEngineNodes(response, { heldIds: new Set(), door: DOOR, doorCount: 1 })
    const llama = nodes.find((n) => n.id === 'llama')
    expect(llama?.description).toBe('llama · running · 2 waiting · foo.gguf')
    expect(llama?.tooltip).toBe('chat 0 active, 2 waiting · foo.gguf')
    const comfy = nodes.find((n) => n.id === 'comfy')
    expect(comfy?.description).toBe('openai-http · running')
    expect(comfy?.tooltip).toBe('chat 1 active, 0 waiting')
    const vision = nodes.find((n) => n.id === 'vision')
    expect(vision?.description).toBe('llama · running')
    expect(vision?.tooltip).toBe('vision 1 active, 0 waiting · see.gguf')
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
})

describe('release candidates', () => {
  test('release candidates are the session set plus rows still held by the list', () => {
    expect(releaseHoldIds(new Set(['llama', 'comfy']), ['comfy', 'whisper'])).toEqual([
      'comfy',
      'llama',
      'whisper',
    ])
    expect(releaseHoldIds(new Set(), [])).toEqual([])
  })
})

describe('emptyListedMessage', () => {
  test('empty lists name models or engines; a non-empty list opens the picker', () => {
    expect(emptyListedMessage('models', 0)).toBe('engined: no models are listed')
    expect(emptyListedMessage('engines', 0)).toBe('engined: no engines are listed')
    expect(emptyListedMessage('models', 1)).toBeUndefined()
    expect(emptyListedMessage('engines', 3)).toBeUndefined()
  })
})

describe('copyFixText', () => {
  test('undefined or empty fix is not copied; a non-empty fix is returned as-is', () => {
    expect(copyFixText(undefined)).toBeUndefined()
    expect(copyFixText('')).toBeUndefined()
    expect(copyFixText('engined engines openai start')).toBe('engined engines openai start')
  })
})

describe('missing engines response', () => {
  test('missing response maps to no nodes', () => {
    expect(toEngineNodes(undefined, { heldIds: new Set(), door: DOOR, doorCount: 1 })).toEqual([])
  })
})

describe('engine contextValue and remote ids', () => {
  test('a failed engine with a non-empty fix offers Copy Fix without losing engine actions', () => {
    const nodes = toEngineNodes(
      {
        engines: [
          { id: 'llama', kind: 'openai-http', state: 'failed', fix: 'engined start llama' },
          { id: 'whisper', kind: 'openai-http', state: 'failed' },
          { id: 'comfy', kind: 'openai-http', state: 'running', fix: 'unused' },
        ],
      },
      { heldIds: new Set(), door: DOOR, doorCount: 1 },
    )
    expect(nodes.find((n) => n.id === 'llama')?.contextValue).toBe('engine,engine-has-fix')
    expect(nodes.find((n) => n.id === 'whisper')?.contextValue).toBe('engine')
    expect(nodes.find((n) => n.id === 'comfy')?.contextValue).toBe('engine')
  })

  test('onlyRemoteEngineIds is true only when every backing row is remote', () => {
    expect(
      onlyRemoteEngineIds([
        { engine: 'mixed', egress: 'none' },
        { engine: 'mixed', egress: 'remote' },
        { engine: 'cloud', egress: 'remote' },
      ]),
    ).toEqual(new Set(['cloud']))
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

describe('last error', () => {
  test('a failed engine shows last_error; a running engine without the field does not', () => {
    const response: EnginesListResponse = {
      engines: [
        {
          id: 'llama',
          kind: 'openai-http',
          state: 'failed',
          last_error: 'container is not running',
        },
        { id: 'comfy', kind: 'openai-http', state: 'running' },
        {
          id: 'openai',
          kind: 'openai-http',
          state: 'unavailable',
          fix: 'set disable = false',
          last_error: 'container is not running',
        },
        { id: 'whisper', kind: 'openai-http', state: 'failed', last_error: '' },
        {
          id: 'kokoro',
          kind: 'tts',
          state: 'running',
          last_error: 'container is not running',
        },
      ],
    }
    const nodes = toEngineNodes(response, { heldIds: new Set(), door: DOOR, doorCount: 1 })
    const llama = nodes.find((n) => n.id === 'llama')
    expect(llama?.description).toBe('openai-http · failed · container is not running')
    expect(llama?.tooltip).toContain('container is not running')
    expect(llama?.description).not.toContain('held')
    expect(llama?.description).not.toContain('idle')
    expect(llama?.description).not.toContain('config stale')
    expect(llama?.hasResources).toBe(false)
    const comfy = nodes.find((n) => n.id === 'comfy')
    expect(comfy?.description).toBe('openai-http · running')
    expect(comfy?.tooltip).not.toContain('container is not running')
    const openai = nodes.find((n) => n.id === 'openai')
    expect(openai?.description).toContain('container is not running')
    expect(openai?.tooltip).toContain('container is not running')
    expect(openai?.tooltip).toContain('set disable = false')
    const whisper = nodes.find((n) => n.id === 'whisper')
    expect(whisper?.description).toBe('openai-http · failed')
    expect(whisper?.description).not.toContain('container is not running')
    const kokoro = nodes.find((n) => n.id === 'kokoro')
    expect(kokoro?.description).toBe('tts · running')
    expect(kokoro?.tooltip).not.toContain('container is not running')
  })
})

describe('declared capabilities', () => {
  test('the tooltip names a declared model id and leaves the live role model line alone', () => {
    const nodes = toEngineNodes(engines, { heldIds: new Set(), door: DOOR, doorCount: 1 })
    const recorded = nodes.find((n) => n.id === 'llama')
    expect(recorded?.tooltip).toContain('ornith')
    expect(recorded?.tooltip).toContain('models: ornith')
    expect(recorded?.description).not.toContain('ornith')
    const cursor = nodes.find((n) => n.id === 'cursor')
    expect(cursor?.tooltip).toContain('models, including auto')
    const piper = nodes.find((n) => n.id === 'piper')
    expect(piper?.tooltip).not.toContain('models')

    const response: EnginesListResponse = {
      engines: [
        {
          id: 'llama',
          kind: 'llama',
          state: 'running',
          roles: [{ role: 'chat', active: 1, waiting: 0, model: 'foo.gguf' }],
          capabilities: [{ model: 'ornith' }],
        },
        { id: 'comfy', kind: 'openai-http', state: 'running', capabilities: [] },
        { id: 'whisper', kind: 'stt', state: 'running', capabilities: [{}] },
      ],
    }
    const rows = toEngineNodes(response, { heldIds: new Set(), door: DOOR, doorCount: 1 })
    const llama = rows.find((n) => n.id === 'llama')
    expect(llama?.description).toBe('llama · running')
    expect(llama?.tooltip).toBe('chat 1 active, 0 waiting · foo.gguf\nmodels: ornith')
    const comfy = rows.find((n) => n.id === 'comfy')
    expect(comfy?.tooltip).toBe('openai-http · running')
    const whisper = rows.find((n) => n.id === 'whisper')
    expect(whisper?.tooltip).toBe('stt · running')
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

describe('config reload error', () => {
  test('config_error is the door group text; an absent or empty field is omitted', () => {
    const now = Date.parse('2026-10-11T18:00:00.000Z')
    const rows: EnginesListResponse['engines'] = [
      {
        id: 'llama',
        kind: 'llama',
        state: 'running',
        held_until: '2026-10-11T19:00:00.000Z',
        idle_until: '2026-10-11T19:00:00.000Z',
        last_error: 'container is not running',
        roles: [{ role: 'chat', active: 1, waiting: 0, model: 'foo.gguf' }],
        capabilities: [{ model: 'ornith' }],
      },
    ]
    const ctx = { heldIds: new Set<string>(), door: DOOR, doorCount: 1, now }
    const plain = toEngineNodes({ engines: rows }, ctx)
    const listed: EnginesListResponse = { engines: rows, config_error: 'toml: expected newline' }
    expect(toEngineNodes(listed, ctx)).toEqual(plain)
    const [node] = plain
    expect(node?.description).toBe(
      'llama · running · held until 2026-10-11T19:00:00.000Z · idle until 2026-10-11T19:00:00.000Z',
    )
    expect(node?.description).not.toContain('container is not running')
    expect(node?.tooltip).toBe('chat 1 active, 0 waiting · foo.gguf\nmodels: ornith')
    expect(doorGroupNote(listed)).toEqual({
      description: 'toml: expected newline',
      tooltip: 'toml: expected newline',
    })
    expect(doorGroupNote({ engines: rows })).toEqual({})
    expect(doorGroupNote({ engines: rows, config_error: '' })).toEqual({})
    expect(doorGroupNote(undefined)).toEqual({})
  })
})

describe('model discovery', () => {
  test('discovery last_error and fetched_at land on the agent row tooltip; a list without discovery is unchanged', () => {
    const rows: EnginesListResponse['engines'] = [
      {
        id: 'cursor',
        kind: 'agentic-cli',
        state: 'installed',
        capabilities: [
          { model: 'auto' },
          { model: 'composer' },
          { model: 'sonnet' },
          { model: 'opus' },
          { model: 'haiku' },
        ],
      },
      { id: 'claude', kind: 'agentic-cli', state: 'installed' },
      {
        id: 'llama',
        kind: 'llama',
        state: 'running',
        roles: [{ role: 'chat', active: 1, waiting: 0, model: 'foo.gguf' }],
        capabilities: [{ model: 'ornith' }],
      },
    ]
    const ctx = { heldIds: new Set<string>(), door: DOOR, doorCount: 1 }
    const plain = toEngineNodes({ engines: rows }, ctx)
    expect(toEngineNodes({ engines: rows, discovery: undefined }, ctx)).toEqual(plain)
    const cursorPlain = plain.find((n) => n.id === 'cursor')
    expect(cursorPlain?.tooltip).toBe(
      'agentic-cli · installed · agent CLI, no container\n5 models, including auto',
    )
    expect(cursorPlain?.description).toBe('agentic-cli · installed · agent CLI, no container')

    const listed: EnginesListResponse = {
      engines: rows,
      discovery: {
        cursor: {
          fetched_at: '2026-10-11T18:00:00.000Z',
          last_error: 'refresh failed: 401',
          models: 12,
          findings: [],
        },
        claude: {
          fetched_at: '2026-10-11T17:00:00.000Z',
          models: 4,
          findings: [{ kind: 'duplicate', route: 'claude/opus', fix: 'delete the route' }],
        },
        llama: {
          fetched_at: '2026-10-11T18:00:00.000Z',
          last_error: 'should not show',
          models: 1,
          findings: [],
        },
      },
    }
    const nodes = toEngineNodes(listed, ctx)
    const cursor = nodes.find((n) => n.id === 'cursor')
    expect(cursor?.description).toBe(cursorPlain?.description)
    expect(cursor?.tooltip).toBe(
      'agentic-cli · installed · agent CLI, no container\n5 models, including auto\nrefresh failed: 401\nfetched 2026-10-11T18:00:00.000Z',
    )
    const claude = nodes.find((n) => n.id === 'claude')
    expect(claude?.tooltip).toBe(
      'agentic-cli · installed · agent CLI, no container\nfetched 2026-10-11T17:00:00.000Z',
    )
    expect(claude?.tooltip).not.toContain('delete the route')
    const llama = nodes.find((n) => n.id === 'llama')
    expect(llama).toEqual(plain.find((n) => n.id === 'llama'))
    expect(llama?.tooltip).toBe('chat 1 active, 0 waiting · foo.gguf\nmodels: ornith')
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

describe('enginesViewMessage', () => {
  test('a lone door drops its name; several doors keep it; clean doors say nothing', () => {
    const bad = { name: 'a', url: 'http://x', configError: 'bad toml' }
    const down = { name: 'b', url: 'http://y', failure: 'refused' }
    expect(enginesViewMessage([bad])).toBe('config not loaded: bad toml')
    expect(enginesViewMessage([down])).toBe("can't reach http://y (refused)")
    expect(enginesViewMessage([bad, down])).toBe(
      "a: config not loaded: bad toml\nb: can't reach http://y (refused)",
    )
    expect(enginesViewMessage([{ name: 'a', url: 'u', configError: '' }])).toBeUndefined()
  })
})
