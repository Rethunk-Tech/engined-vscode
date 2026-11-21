import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agenticBusyMessage,
  DoorHttpError,
  doorErrorMessage,
  fetchAllDoors,
  fetchAllUsage,
  fetchEngineLogs,
  fetchEngineResources,
  fetchEngines,
  holdEngine,
  openEngineEventsStream,
  postChatCompletion,
  postEmbeddings,
  postForm,
  postImage,
  postRerank,
  postTokenize,
  startModel,
  stopEngine,
  unholdEngine,
} from './doorClient.ts'
import { toEngineNodes } from './engineTree.ts'
import { obtainEngine } from './obtainEngine.ts'

describe('doorErrorMessage', () => {
  test('reads a string or OpenAI message and ignores anything else', () => {
    expect(doorErrorMessage('"llama" is not running')).toBe('"llama" is not running')
    expect(
      doorErrorMessage({
        message: '"llama" is not running',
        type: 'not_found_error',
        param: null,
        code: null,
      }),
    ).toBe('"llama" is not running')
    expect(new DoorHttpError(404, '{"error":"stopped"}').message).toBe('stopped')
    expect(
      new DoorHttpError(
        404,
        '{"error":{"message":"stopped","type":"not_found_error","param":null,"code":null},"attempts":[]}',
      ).message,
    ).toBe('stopped')
    expect(new DoorHttpError(502, 'gateway timeout').message).toBe('gateway timeout')
    expect(doorErrorMessage({ message: 1 })).toBeUndefined()
    expect(doorErrorMessage(null)).toBeUndefined()
  })
})

describe('postChatCompletion', () => {
  test('refuses a non-http(s) door URL without fetching', async () => {
    await expect(
      postChatCompletion(
        'file:///etc/passwd',
        { model: 'x', messages: [] },
        new AbortController().signal,
      ),
    ).rejects.toThrow('door URL is not allowed')
  })

  test('retries a 429 once when Retry-After is at most 10 s, then reads the 200', async () => {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        hits += 1
        if (hits === 1) {
          return new Response(
            JSON.stringify({
              error: {
                message: 'Too many requests',
                type: 'rate_limit_error',
                param: null,
                code: null,
              },
            }),
            {
              status: 429,
              headers: { 'content-type': 'application/json', 'retry-after': '0' },
            },
          )
        }
        return new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    try {
      const { body } = await postChatCompletion(
        `http://127.0.0.1:${server.port}`,
        { model: 'x', messages: [] },
        new AbortController().signal,
      )
      expect(hits).toBe(2)
      expect(body).toBeInstanceOf(ReadableStream)
    } finally {
      server.stop(true)
    }
  })

  test('does not retry a 429 when Retry-After is over 10 s', async () => {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        hits += 1
        return new Response(
          JSON.stringify({
            error: {
              message: 'Too many requests',
              type: 'rate_limit_error',
              param: null,
              code: null,
            },
          }),
          {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '11' },
          },
        )
      },
    })
    try {
      await expect(
        postChatCompletion(
          `http://127.0.0.1:${server.port}`,
          { model: 'x', messages: [] },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        status: 429,
        message: agenticBusyMessage(11),
      })
      expect(hits).toBe(1)
    } finally {
      server.stop(true)
    }
  })

  test('retries a 429 once when Retry-After is an HTTP-date at most 10 s away', async () => {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        hits += 1
        if (hits === 1) {
          return new Response(JSON.stringify({ error: { message: 'Too many requests' } }), {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'retry-after': new Date(Date.now() - 1000).toUTCString(),
            },
          })
        }
        return new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    try {
      const { body } = await postChatCompletion(
        `http://127.0.0.1:${server.port}`,
        { model: 'x', messages: [] },
        new AbortController().signal,
      )
      expect(hits).toBe(2)
      expect(body).toBeInstanceOf(ReadableStream)
    } finally {
      server.stop(true)
    }
  })

  test('does not follow a redirect, so the POST body never leaves the door', async () => {
    const leaked: string[] = []
    const attacker = Bun.serve({
      port: 0,
      async fetch(req) {
        leaked.push(await req.text())
        return new Response('nope', { status: 500 })
      },
    })
    const door = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, {
          status: 307,
          headers: { location: `http://127.0.0.1:${attacker.port}/steal` },
        })
      },
    })
    try {
      await expect(
        postChatCompletion(
          `http://127.0.0.1:${door.port}`,
          { model: 'x', secret: 's' },
          new AbortController().signal,
        ),
      ).rejects.toThrow()
      expect(leaked).toEqual([])
    } finally {
      door.stop(true)
      attacker.stop(true)
    }
  })
})

describe('postChatCompletion busy and empty replies', () => {
  test('a 429 with no usable Retry-After fails immediately with a zero-second hint', async () => {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        hits += 1
        const retryAfter = hits === 1 ? '' : 'not-a-date'
        return new Response(JSON.stringify({ error: { message: 'Too many requests' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': retryAfter },
        })
      },
    })
    const base = `http://127.0.0.1:${server.port}`
    const body = { model: 'x', messages: [] }
    try {
      await expect(
        postChatCompletion(base, body, new AbortController().signal),
      ).rejects.toMatchObject({ status: 429, message: agenticBusyMessage(0) })
      await expect(
        postChatCompletion(base, body, new AbortController().signal),
      ).rejects.toMatchObject({ status: 429, message: agenticBusyMessage(0) })
      expect(hits).toBe(2)
    } finally {
      server.stop(true)
    }
  })

  test('aborting during a 429 wait cancels the retry', async () => {
    const ac = new AbortController()
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ error: { message: 'Too many requests' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '1' },
        })
      },
    })
    try {
      const pending = postChatCompletion(
        `http://127.0.0.1:${server.port}`,
        { model: 'x', messages: [] },
        ac.signal,
      )
      await Bun.sleep(20)
      ac.abort()
      await expect(pending).rejects.toThrow()
    } finally {
      server.stop(true)
    }
  })

  test('a successful chat reply with no body is an error', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, { status: 204 })
      },
    })
    try {
      await expect(
        postChatCompletion(
          `http://127.0.0.1:${server.port}`,
          { model: 'x', messages: [] },
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(DoorHttpError)
    } finally {
      server.stop(true)
    }
  })
})

describe('fetchAllDoors', () => {
  test('polls models only; engines is never fetched even when models 503', async () => {
    const paths: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        paths.push(new URL(req.url).pathname)
        return new Response('{"error":"config"}', { status: 503 })
      },
    })
    try {
      const door = { name: 'a', url: `http://127.0.0.1:${server.port}` }
      const { doorStatus, chatModels } = await fetchAllDoors([door])
      expect(doorStatus).toEqual([{ door, reachable: false }])
      expect(chatModels).toEqual([])
      expect(paths).toEqual(['/openai/v1/models'])
    } finally {
      await server.stop(true)
    }
  })

  test('a models-ok door is reachable without consulting engines', async () => {
    const paths: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        paths.push(new URL(req.url).pathname)
        return Response.json({ data: [] })
      },
    })
    try {
      const door = { name: 'a', url: `http://127.0.0.1:${server.port}` }
      const { doorStatus } = await fetchAllDoors([door])
      expect(doorStatus).toEqual([{ door, reachable: true }])
      expect(paths).toEqual(['/openai/v1/models'])
    } finally {
      await server.stop(true)
    }
  })
})

describe('obtainEngine', () => {
  const sse = (exitCode: number) =>
    `event: step\ndata: {"step":0,"command":"x"}\n\nevent: exit\ndata: {"exitCode":${exitCode},"steps":1}\n\n`

  test('a missing row offers Obtain through the package.json menu patterns', () => {
    const door = { name: 'local', url: 'http://127.0.0.1:29200' }
    const nodes = toEngineNodes(
      {
        engines: [
          { id: 'llama', kind: 'openai-http', state: 'unavailable', missing: true, fix: 'pull' },
          { id: 'whisper', kind: 'openai-http', state: 'installed', missing: true },
          { id: 'tts', kind: 'openai-http', state: 'unavailable', fix: 'enable' },
          { id: 'plain', kind: 'openai-http', state: 'installed' },
        ],
      },
      { heldIds: new Set(), door, doorCount: 1 },
    )
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
    ) as {
      contributes: { menus: { 'view/item/context': { command: string; when: string }[] } }
    }
    const menus = manifest.contributes.menus['view/item/context']
    const offered = (command: string, contextValue: string): boolean =>
      menus
        .filter((m) => m.command === command)
        .some((m) => {
          const pattern = /viewItem =~ \/(.+?)\//.exec(m.when)?.[1]
          return pattern !== undefined && new RegExp(pattern).test(contextValue)
        })
    const value = (id: string) => nodes.find((n) => n.id === id)?.contextValue ?? ''
    expect(offered('engined.obtainEngine', value('llama'))).toBe(true)
    expect(offered('engined.obtainEngine', value('whisper'))).toBe(true)
    expect(offered('engined.obtainEngine', value('tts'))).toBe(false)
    expect(offered('engined.stopEngine', value('whisper'))).toBe(true)
    expect(offered('engined.stopEngine', value('llama'))).toBe(false)
    expect(offered('engined.copyFixCommand', value('tts'))).toBe(true)
    expect(offered('engined.stopEngine', value('plain'))).toBe(true)
  })

  test('posts the encoded engine path, and a non-zero exit event is an error', async () => {
    let method = ''
    let pathname = ''
    let body = ''
    let exitCode = 0
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        method = req.method
        pathname = new URL(req.url).pathname
        body = await req.text()
        return new Response(sse(exitCode), { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    try {
      const url = `http://127.0.0.1:${server.port}`
      await obtainEngine(url, 'a/b')
      expect(method).toBe('POST')
      expect(pathname).toBe(`/engined/v1/engines/${encodeURIComponent('a/b')}/obtain`)
      expect(body).toBe('{}')
      exitCode = 2
      await expect(obtainEngine(url, 'a/b')).rejects.toThrow('obtain exited with code 2')
    } finally {
      server.stop(true)
    }
  })
})

describe('holdEngine', () => {
  test('posts the encoded engine path with no duration query', async () => {
    let method = ''
    let href = ''
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        method = req.method
        const url = new URL(req.url)
        href = url.pathname + url.search
        return Response.json({})
      },
    })
    try {
      await holdEngine(`http://127.0.0.1:${server.port}`, 'a/b')
      expect(method).toBe('POST')
      expect(href).toBe(`/engined/v1/engines/${encodeURIComponent('a/b')}/hold`)
    } finally {
      server.stop(true)
    }
  })
})

describe('fetchEngineLogs', () => {
  test('encodes the engine id in the path', async () => {
    let pathname = ''
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname: path } = new URL(req.url)
        pathname = path
        return Response.json({ lines: [] })
      },
    })
    try {
      await fetchEngineLogs(`http://127.0.0.1:${server.port}`, 'a/b', 10)
      expect(pathname).toBe(`/engined/v1/engines/${encodeURIComponent('a/b')}/logs`)
    } finally {
      server.stop(true)
    }
  })
})

const IMAGE = { created: 1, data: [{ b64_json: Buffer.from('png').toString('base64') }] }
const INLINE_PREVIEW = Buffer.from('jpeg').toString('base64')

function imageSse(): string {
  return [
    'event: progress',
    'data: {"value":1,"max":4,"node":"4"}',
    '',
    'event: preview',
    'data: {"bytes":12,"format":"jpeg"}',
    '',
    'event: preview',
    `data: ${JSON.stringify({ bytes: 4, format: 'jpeg', image: INLINE_PREVIEW })}`,
    '',
    'event: progress',
    'data: {"value":4,"max":4,"node":"4"}',
    '',
    'event: image',
    `data: ${JSON.stringify(IMAGE)}`,
    '',
    '',
  ].join('\n')
}

describe('postImage', () => {
  test('generations and edits ask for events, report progress, and return the image event', async () => {
    const accepts: string[] = []
    const contentTypes: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        accepts.push(req.headers.get('accept') ?? '')
        contentTypes.push(req.headers.get('content-type') ?? '')
        return new Response(imageSse(), { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    const base = `http://127.0.0.1:${server.port}`
    const lines: string[] = []
    const previews: { image: string; format: string }[] = []
    try {
      const onProgress = (line: string): void => {
        lines.push(line)
      }
      const onPreview = (frame: { image: string; format: string }): void => {
        previews.push(frame)
      }
      const generated = await postImage(
        base,
        '/openai/v1/images/generations',
        { json: { model: '@/comfy/local', prompt: 'a red cube' } },
        { onProgress, onPreview },
      )
      const form = new FormData()
      form.set('prompt', 'a blue cube')
      const edited = await postImage(
        base,
        '/openai/v1/images/edits',
        { form },
        { onProgress, onPreview },
      )
      expect(generated).toEqual(IMAGE)
      expect(edited).toEqual(IMAGE)
      expect(accepts).toEqual(['text/event-stream', 'text/event-stream'])
      expect(contentTypes[0]).toBe('application/json')
      expect(contentTypes[1]).toStartWith('multipart/form-data')
      expect(lines).toEqual([
        'Rendering 1/4 node 4',
        'Rendering 4/4 node 4',
        'Rendering 1/4 node 4',
        'Rendering 4/4 node 4',
      ])
      expect(previews).toEqual([
        { image: INLINE_PREVIEW, format: 'jpeg' },
        { image: INLINE_PREVIEW, format: 'jpeg' },
      ])
    } finally {
      await server.stop(true)
    }
  })

  test('an error event fails with the door message', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          'event: progress\ndata: {"value":1,"max":2}\n\nevent: error\ndata: {"error":{"message":"checkpoint missing","type":"invalid_request_error","param":null,"code":null}}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    const lines: string[] = []
    try {
      await expect(
        postImage(
          `http://127.0.0.1:${server.port}`,
          '/openai/v1/images/generations',
          { json: { prompt: 'a red cube' } },
          { onProgress: (line) => lines.push(line) },
        ),
      ).rejects.toThrow('checkpoint missing')
      expect(lines).toEqual(['Rendering 1/2'])
    } finally {
      await server.stop(true)
    }
  })

  test('a door that answers JSON is parsed as the image body', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path.endsWith('/refused')) {
          return Response.json(
            { error: { message: 'empty prompt', type: 'invalid_request_error' } },
            { status: 400 },
          )
        }
        return Response.json(IMAGE)
      },
    })
    const base = `http://127.0.0.1:${server.port}`
    try {
      const lines: string[] = []
      const body = await postImage(
        base,
        '/openai/v1/images/generations',
        { json: { prompt: 'a red cube' } },
        { onProgress: (line) => lines.push(line) },
      )
      expect(body).toEqual(IMAGE)
      expect(lines).toEqual([])
      await expect(
        postImage(
          base,
          '/openai/v1/images/generations/refused',
          { json: {} },
          {
            onProgress: () => {
              // A refused call never renders.
            },
          },
        ),
      ).rejects.toMatchObject({ status: 400, message: 'empty prompt' })
    } finally {
      await server.stop(true)
    }
  })

  test('a 204 event-stream is a missing body; a non-JSON reply is the raw bytes', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path.endsWith('/bytes')) {
          return new Response(new Uint8Array([9, 8]), { headers: { 'content-type': 'image/png' } })
        }
        return new Response(null, { status: 204, headers: { 'content-type': 'text/event-stream' } })
      },
    })
    const base = `http://127.0.0.1:${server.port}`
    try {
      await expect(
        postImage(
          base,
          '/openai/v1/images/generations',
          { json: { prompt: 'x' } },
          {
            onProgress: () => undefined,
          },
        ),
      ).rejects.toThrow('engined returned no image data')
      const bytes = await postImage(
        base,
        '/openai/v1/images/generations/bytes',
        { json: {} },
        {
          onProgress: () => undefined,
        },
      )
      expect(bytes).toBeInstanceOf(ArrayBuffer)
    } finally {
      server.stop(true)
    }
  })
})

describe('postRerank', () => {
  test('a results array is the ranking; a missing array is a failure, not empty', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname.startsWith('/ok/')) {
          return Response.json({ results: [{ index: 0, score: 1 }] })
        }
        return Response.json({})
      },
    })
    const base = `http://127.0.0.1:${server.port}`
    try {
      await expect(postRerank(base, { model: 'r', query: 'q', documents: ['a'] })).rejects.toThrow(
        'missing results',
      )
      expect(await postRerank(`${base}/ok`, { model: 'r', query: 'q', documents: ['a'] })).toEqual([
        { index: 0, score: 1 },
      ])
    } finally {
      server.stop(true)
    }
  })
})

describe('fetchAllUsage', () => {
  test('a 200 whose data is not an array is unreachable', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ data: null })
      },
    })
    try {
      const [row] = await fetchAllUsage(
        [{ name: 'local', url: `http://127.0.0.1:${server.port}` }],
        1,
      )
      expect(row?.status).toBe('unreachable')
    } finally {
      server.stop(true)
    }
  })

  test('a 404 is unsupported, a 500 or a down door is unreachable, and a data array is kept', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url)
        if (pathname.startsWith('/u404/')) {
          return new Response('no', { status: 404 })
        }
        if (pathname.startsWith('/u500/')) {
          return new Response('no', { status: 500 })
        }
        return Response.json({
          data: [
            { date: '2026-01-01', route: 'chat', requests: 1, ok: 1, failed: 0, duration_ms: 2 },
          ],
        })
      },
    })
    const port = server.port
    try {
      const [unsupported, failed, ok, down] = await fetchAllUsage(
        [
          { name: 'missing', url: `http://127.0.0.1:${port}/u404` },
          { name: 'fail', url: `http://127.0.0.1:${port}/u500` },
          { name: 'ok', url: `http://127.0.0.1:${port}` },
          { name: 'down', url: 'http://127.0.0.1:1' },
        ],
        1,
      )
      expect(unsupported?.status).toBe('unsupported')
      expect(failed?.status).toBe('unreachable')
      expect(ok).toMatchObject({
        status: 'ok',
        rows: [{ date: '2026-01-01', route: 'chat', requests: 1 }],
      })
      expect(down?.status).toBe('unreachable')
    } finally {
      server.stop(true)
    }
  })
})

describe('fetchEngineResources', () => {
  test('a stopped engine 404 is the error text; garbage or a bare 500 still throw', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const id = decodeURIComponent(new URL(req.url).pathname.split('/')[4] ?? '')
        if (id === 'stopped') {
          return Response.json({ error: { message: 'not running' } }, { status: 404 })
        }
        if (id === 'flat') {
          return Response.json({ error: 'stopped' }, { status: 404 })
        }
        if (id === 'ok') {
          return Response.json({ memory_bytes: 1, graphics_bytes: null })
        }
        if (id === 'garbage') {
          return new Response('not-json', { status: 404 })
        }
        return Response.json({ state: 'busy' }, { status: 500 })
      },
    })
    const base = `http://127.0.0.1:${server.port}`
    try {
      expect(await fetchEngineResources(base, 'stopped')).toEqual({ error: 'not running' })
      expect(await fetchEngineResources(base, 'flat')).toEqual({ error: 'stopped' })
      expect(await fetchEngineResources(base, 'ok')).toEqual({
        memory_bytes: 1,
        graphics_bytes: null,
      })
      await expect(fetchEngineResources(base, 'garbage')).rejects.toMatchObject({
        status: 404,
        message: 'not-json',
      })
      await expect(fetchEngineResources(base, 'fail')).rejects.toMatchObject({ status: 500 })
    } finally {
      server.stop(true)
    }
  })
})

describe('postEmbeddings', () => {
  test('an empty batch is not posted; rows land in input order and out-of-range indexes are dropped', async () => {
    let hits = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        hits += 1
        return Response.json({
          data: [
            { embedding: [9], index: 1 },
            { embedding: [8], index: 99 },
            { embedding: [7], index: 0 },
          ],
        })
      },
    })
    const base = `http://127.0.0.1:${server.port}`
    try {
      expect(await postEmbeddings(base, 'e', [])).toEqual([])
      expect(hits).toBe(0)
      expect(await postEmbeddings(base, 'e', ['a', 'b'])).toEqual([[7], [9]])
      expect(hits).toBe(1)
    } finally {
      server.stop(true)
    }
  })
})

describe('door JSON posts', () => {
  test('JSON posts unwrap tokens, empty lists, and missing log lines', async () => {
    const paths: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url)
        paths.push(pathname)
        if (pathname.includes('/tokenize')) {
          return Response.json({ tokens: 4 })
        }
        if (pathname.includes('/start')) {
          return Response.json({})
        }
        if (pathname.startsWith('/e503/')) {
          return new Response('nope', { status: 503 })
        }
        if (pathname.endsWith('/engines')) {
          return Response.json({ engines: [] })
        }
        if (pathname.endsWith('/logs')) {
          return pathname.includes('/missing/')
            ? new Response('gone', { status: 404 })
            : Response.json({})
        }
        if (pathname.endsWith('/stop')) {
          return new Response('nope', { status: 500 })
        }
        return new Response(new Uint8Array([1]), { headers: { 'content-type': 'text/plain' } })
      },
    })
    const base = `http://127.0.0.1:${server.port}`
    const encoded = encodeURIComponent('a/b')
    try {
      expect(await postTokenize(base, 'm', 'hello')).toBe(4)
      expect(await startModel(base, 'm')).toEqual([])
      expect(await fetchEngines(base)).toEqual({ engines: [] })
      await expect(fetchEngines(`${base}/e503`)).rejects.toMatchObject({ status: 503 })
      expect(await fetchEngineLogs(base, 'a/b', 10)).toEqual([])
      await expect(fetchEngineLogs(base, 'missing', 10)).rejects.toMatchObject({
        status: 404,
        message: 'gone',
      })
      await expect(stopEngine(base, 'a/b')).rejects.toMatchObject({ status: 500 })
      await unholdEngine(base, 'a/b')
      expect(paths).toContain(`/engined/v1/engines/${encoded}/stop`)
      expect(paths).toContain(`/engined/v1/engines/${encoded}/unhold`)
    } finally {
      server.stop(true)
    }
  })
})

describe('door form posts and events', () => {
  test('form posts keep JSON or bytes; events need a live stream', async () => {
    let eventHits = 0
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url)
        if (pathname.endsWith('/events')) {
          eventHits += 1
          return eventHits > 1
            ? new Response('nope', { status: 503 })
            : new Response('data: {}\n\n', {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
              })
        }
        if (pathname.endsWith('/form-bytes')) {
          return new Response(new Uint8Array([1, 2]), {
            headers: { 'content-type': 'audio/mpeg' },
          })
        }
        if (pathname.endsWith('/form-fail')) {
          return new Response('nope', { status: 400 })
        }
        return Response.json({ text: 'hi' })
      },
    })
    const base = `http://127.0.0.1:${server.port}`
    try {
      expect(await postForm(base, '/form-json', new FormData())).toEqual({ text: 'hi' })
      const bytes = await postForm(base, '/form-bytes', new FormData())
      expect(bytes).toBeInstanceOf(ArrayBuffer)
      await expect(postForm(base, '/form-fail', new FormData())).rejects.toMatchObject({
        status: 400,
        message: 'nope',
      })
      const stream = await openEngineEventsStream(base, new AbortController().signal)
      expect(stream).toBeInstanceOf(ReadableStream)
      await expect(
        openEngineEventsStream(base, new AbortController().signal),
      ).rejects.toMatchObject({ status: 503 })
    } finally {
      server.stop(true)
    }
  })
})
