import { beforeEach, describe, expect, jest, test } from 'bun:test'
import type { EnginedModelRow } from './door.ts'
import type { HostUri, SearchHost } from './searchHost.ts'
import { SearchIndex } from './searchIndex.ts'

const embedCalls: number[] = []
let rerankImpl: (signal?: AbortSignal) => Promise<never[]> = () => Promise.resolve([])

const ROW = {
  id: '@/llama/embed',
  routeId: '@/llama/embed',
  door: { name: 'local', url: 'http://127.0.0.1:29200' },
  tools: false,
  serves: ['/openai/v1/embeddings'],
  state: 'installed',
  egress: 'none',
  capabilities: {},
} as unknown as EnginedModelRow

const uri = (fsPath: string): HostUri => ({ fsPath })

/** An in-memory host; `gate` holds `findFiles` open so a test can overlap refreshes. */
function fakeHost(over: Partial<SearchHost> = {}) {
  const counts = { findFiles: 0, writes: 0, running: 0, maxRunning: 0 }
  const host: SearchHost = {
    joinPath: (base, name) => uri(`${base.fsPath}/${name}`),
    readFile: (u) =>
      u.fsPath.endsWith('search-index.json')
        ? Promise.reject(new Error('no index yet'))
        : Promise.resolve(new TextEncoder().encode('hello world\n')),
    writeFile: () => {
      counts.writes += 1
      return Promise.resolve()
    },
    createDirectory: () => Promise.resolve(),
    stat: () => Promise.resolve({ isFile: true, size: 12, mtime: 1 }),
    findFiles: async () => {
      counts.findFiles += 1
      counts.running += 1
      counts.maxRunning = Math.max(counts.maxRunning, counts.running)
      await Promise.resolve()
      counts.running -= 1
      return [uri('/ws/a.txt')]
    },
    isWorkspaceFile: () => Promise.resolve(true),
    asRelativePath: (u) => u.fsPath.replace('/ws/', ''),
    excludeSettings: () => [{ '**/node_modules': true, '**/skip': false }],
    withProgress: (_title, task) => task(() => undefined),
    embed: (_url, _model, texts) => {
      embedCalls.push(texts.length)
      return Promise.resolve(texts.map(() => [1, 0]))
    },
    rerank: (_url, _request, signal) => rerankImpl(signal),
    defaultModel: () => '',
    allowRemote: () => false,
    maxChunks: () => 100,
    ...over,
  }
  return { host, counts }
}

async function built(host: SearchHost) {
  const logs: string[] = []
  const index = new SearchIndex(
    uri('/storage'),
    () => [ROW],
    (l) => logs.push(l),
    host,
  )
  await index.ensureBuilt()
  return { index, logs }
}

const tick = async () => {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

describe('SearchIndex refresh', () => {
  beforeEach(() => {
    embedCalls.length = 0
    rerankImpl = () => Promise.resolve([])
    jest.useFakeTimers()
  })

  test('file events before the index is built do nothing', async () => {
    const { host, counts } = fakeHost()
    const index = new SearchIndex(
      uri('/storage'),
      () => [ROW],
      () => undefined,
      host,
    )
    index.onFileChanged(uri('/ws/a.txt'), 'change')
    jest.advanceTimersByTime(5000)
    await tick()
    expect(counts.findFiles).toBe(0)
  })

  test('a burst of changes arms one debounced refresh', async () => {
    const { host, counts } = fakeHost()
    const { index } = await built(host)
    const before = counts.findFiles
    for (let i = 0; i < 5; i += 1) {
      index.onFileChanged(uri('/ws/a.txt'), 'change')
      await tick()
      jest.advanceTimersByTime(300)
    }
    expect(counts.findFiles).toBe(before)
    jest.advanceTimersByTime(1000)
    await tick()
    expect(counts.findFiles).toBe(before + 1)
  })

  test('a path the exclude globs reject arms nothing', async () => {
    const { host, counts } = fakeHost({ isWorkspaceFile: () => Promise.resolve(false) })
    const { index } = await built(host)
    const before = counts.findFiles
    index.onFileChanged(uri('/ws/node_modules/x.js'), 'create')
    await tick()
    jest.advanceTimersByTime(5000)
    await tick()
    expect(counts.findFiles).toBe(before)
  })

  test('events during a running refresh fold into one follow-up, never two at once', async () => {
    let release: () => void = () => undefined
    let gated: boolean
    gated = false
    const { host, counts } = fakeHost()
    const realFind = host.findFiles
    const slowHost: SearchHost = {
      ...host,
      findFiles: async (exclude) => {
        if (gated) {
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        return await realFind(exclude)
      },
    }
    const { index } = await built(slowHost)
    const before = counts.findFiles
    gated = true
    index.onFileChanged(uri('/ws/a.txt'), 'change')
    await tick()
    jest.advanceTimersByTime(1000)
    await tick()
    // First refresh is in flight and parked; two more bursts arrive meanwhile.
    index.onFileChanged(uri('/ws/a.txt'), 'change')
    await tick()
    jest.advanceTimersByTime(1000)
    await tick()
    index.onFileChanged(uri('/ws/a.txt'), 'change')
    await tick()
    jest.advanceTimersByTime(1000)
    await tick()
    gated = false
    release()
    await tick()
    await tick()
    expect(counts.findFiles - before).toBe(2)
    expect(counts.maxRunning).toBe(1)
  })

  test('ensureBuilt and a debounced refresh do not embed the same file at once', async () => {
    let running = 0
    let maxRunning = 0
    let mtime = 1
    let release: () => void = () => undefined
    let gated: boolean
    gated = false
    const { host } = fakeHost({
      stat: () => Promise.resolve({ isFile: true, size: 12, mtime }),
      embed: async (_url, _model, texts) => {
        running += 1
        maxRunning = Math.max(maxRunning, running)
        if (gated) {
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        running -= 1
        return texts.map(() => [1, 0])
      },
    })
    const { index } = await built(host)
    mtime = 2
    maxRunning = 0
    gated = true
    index.onFileChanged(uri('/ws/a.txt'), 'change')
    await tick()
    jest.advanceTimersByTime(1000)
    await tick()
    const ensured = index.ensureBuilt()
    await tick()
    expect(maxRunning).toBe(1)
    gated = false
    release()
    await ensured
    await tick()
    const hits = await index.search('hello', 20)
    const keys = hits.map((h) => `${h.path}:${h.startLine}:${h.text}`)
    expect(keys).toEqual([...new Set(keys)])
  })

  test('a binary file is read once across two ensureBuilt calls', async () => {
    let reads = 0
    const { host } = fakeHost({
      readFile: (u) => {
        if (u.fsPath.endsWith('search-index.json')) {
          return Promise.reject(new Error('no index yet'))
        }
        reads += 1
        return Promise.resolve(new Uint8Array([0x00, 0x01, 0x02]))
      },
    })
    const { index } = await built(host)
    expect(reads).toBe(1)
    await index.ensureBuilt()
    expect(reads).toBe(1)
  })

  test('a partial embeddings reply is retried on the next refresh', async () => {
    let calls = 0
    const { host } = fakeHost({
      embed: (_url, _model, texts) => {
        calls += 1
        if (calls === 1) {
          return Promise.resolve(texts.map(() => undefined))
        }
        return Promise.resolve(texts.map(() => [1, 0]))
      },
    })
    const { index } = await built(host)
    expect(calls).toBe(1)
    await index.ensureBuilt()
    expect(calls).toBe(2)
  })

  test('a delete applies at once and schedules a debounced save', async () => {
    const { host, counts } = fakeHost()
    const { index } = await built(host)
    const writesAfterBuild = counts.writes
    index.onFileChanged(uri('/ws/a.txt'), 'delete')
    expect(counts.writes).toBe(writesAfterBuild)
    jest.advanceTimersByTime(2000)
    await tick()
    expect(counts.writes).toBe(writesAfterBuild + 1)
  })
})

describe('SearchIndex load', () => {
  beforeEach(() => {
    jest.useRealTimers()
    embedCalls.length = 0
  })

  for (const bad of ['{}', '{"entries": 5}', '{"files":{},"entries":[1]}']) {
    test(`a wrong-shape index file ${bad} is discarded and rebuilt`, async () => {
      const { host } = fakeHost({
        readFile: (u) =>
          Promise.resolve(
            u.fsPath.endsWith('search-index.json')
              ? new TextEncoder().encode(bad)
              : new TextEncoder().encode('hello world\n'),
          ),
      })
      const index = new SearchIndex(
        uri('/storage'),
        () => [ROW],
        () => undefined,
        host,
      )
      const hits = await index.search('hello', 5)
      expect(hits.length).toBeGreaterThan(0)
      expect(embedCalls.length).toBeGreaterThan(0)
    })
  }
})

describe('SearchIndex.search cancellation', () => {
  beforeEach(() => {
    jest.useRealTimers()
    rerankImpl = () => Promise.resolve([])
  })

  test('a rerank failure after cancellation is rethrown', async () => {
    const rerankRow = { ...ROW, serves: ['/openai/v1/embeddings', '/openai/v1/rerank'] }
    const { host } = fakeHost()
    const index = new SearchIndex(
      uri('/storage'),
      () => [rerankRow as EnginedModelRow],
      () => undefined,
      host,
    )
    const controller = new AbortController()
    rerankImpl = () => {
      controller.abort()
      return Promise.reject(new Error('aborted'))
    }
    await expect(index.search('hello', 5, controller.signal)).rejects.toThrow('aborted')
  })

  test('a configured rerank id wins over the first qualifying row', async () => {
    const first = {
      ...ROW,
      id: '@/llama/a',
      routeId: '@/llama/a',
      serves: ['/openai/v1/embeddings', '/openai/v1/rerank'],
    } as EnginedModelRow
    const second = {
      ...ROW,
      id: '@/llama/b',
      routeId: '@/llama/b',
      serves: ['/openai/v1/rerank'],
    } as EnginedModelRow
    let rerankModel = ''
    const { host } = fakeHost({
      defaultModel: (role) => (role === 'rerank' ? '@/llama/b' : ''),
      rerank: (_url, request, signal) => {
        rerankModel = request.model
        return rerankImpl(signal)
      },
    })
    const index = new SearchIndex(
      uri('/storage'),
      () => [first, second],
      () => undefined,
      host,
    )
    await index.search('hello', 5)
    expect(rerankModel).toBe('@/llama/b')
  })

  test('a rerank failure without cancellation falls back to cosine order', async () => {
    const rerankRow = { ...ROW, serves: ['/openai/v1/embeddings', '/openai/v1/rerank'] }
    const { host } = fakeHost()
    const logs: string[] = []
    const index = new SearchIndex(
      uri('/storage'),
      () => [rerankRow as EnginedModelRow],
      (l) => logs.push(l),
      host,
    )
    rerankImpl = () => Promise.reject(new Error('boom'))
    const hits = await index.search('hello', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(logs.some((l) => l.includes('rerank failed'))).toBe(true)
  })

  test('an empty rerank ranking keeps cosine order', async () => {
    const rerankRow = { ...ROW, serves: ['/openai/v1/embeddings', '/openai/v1/rerank'] }
    const { host } = fakeHost()
    const logs: string[] = []
    const index = new SearchIndex(
      uri('/storage'),
      () => [rerankRow as EnginedModelRow],
      (l) => logs.push(l),
      host,
    )
    rerankImpl = () => Promise.resolve([])
    const hits = await index.search('hello', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(logs.some((l) => l.includes('rerank failed'))).toBe(false)
  })
})
