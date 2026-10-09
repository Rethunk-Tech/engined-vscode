import { beforeEach, describe, expect, jest, mock, test } from 'bun:test'
import type { EnginedModelRow } from './door.ts'
import type { HostUri, SearchHost } from './searchHost.ts'

const embedCalls: number[] = []
let rerankImpl: (signal?: AbortSignal) => Promise<never[]> = () => Promise.resolve([])

mock.module('./doorClient.ts', () => ({
  postEmbeddings: (_url: string, _model: string, texts: string[]) => {
    embedCalls.push(texts.length)
    return Promise.resolve(texts.map(() => [1, 0]))
  },
  postRerank: (_url: string, _body: unknown, signal?: AbortSignal) => rerankImpl(signal),
}))

const { SearchIndex } = await import('./searchIndex.ts')

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
    let gated = false
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
})
