import { describe, expect, test } from 'bun:test'
import {
  agenticBusyMessage,
  DoorHttpError,
  doorErrorMessage,
  fetchAllDoors,
  fetchAllUsage,
  fetchEngineLogs,
  obtainEngine,
  postChatCompletion,
  postImage,
  postRerank,
} from './doorClient.ts'
import { obtainResultText, toEngineNodes } from './engineTree.ts'

describe('doorErrorMessage', () => {
  test('reads a flat string and an OpenAI error object', () => {
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
  })
})

describe('postChatCompletion', () => {
  test('refuses a cleartext non-loopback door URL without fetching', async () => {
    await expect(
      postChatCompletion(
        'http://10.0.0.5:29200',
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
  test('posts the encoded engine path and a missing row offers Obtain', async () => {
    const door = { name: 'local', url: 'http://127.0.0.1:29200' }
    const nodes = toEngineNodes(
      {
        engines: [
          {
            id: 'llama',
            kind: 'openai-http',
            state: 'unavailable',
            missing: true,
            fix: 'pull',
          },
          { id: 'whisper', kind: 'openai-http', state: 'installed', missing: true },
          { id: 'comfy', kind: 'openai-http', state: 'failed', fix: 'start', missing: true },
          { id: 'tts', kind: 'openai-http', state: 'unavailable', fix: 'enable' },
        ],
      },
      { heldIds: new Set(), door, doorCount: 1 },
    )
    expect(nodes.find((n) => n.id === 'llama')?.contextValue).toBe(
      'engine-unavailable,engine-can-obtain',
    )
    expect(nodes.find((n) => n.id === 'whisper')?.contextValue).toBe('engine,engine-can-obtain')
    expect(nodes.find((n) => n.id === 'comfy')?.contextValue).toBe(
      'engine,engine-has-fix,engine-can-obtain',
    )
    expect(nodes.find((n) => n.id === 'tts')?.contextValue).toBe('engine-unavailable')

    let method = ''
    let pathname = ''
    let body = ''
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        method = req.method
        pathname = new URL(req.url).pathname
        body = await req.text()
        return Response.json({ message: 'pulled a/b' })
      },
    })
    try {
      const data = await obtainEngine(`http://127.0.0.1:${server.port}`, 'a/b')
      expect(method).toBe('POST')
      expect(pathname).toBe(`/engined/v1/engines/${encodeURIComponent('a/b')}/obtain`)
      expect(body).toBe('{}')
      expect(obtainResultText(data)).toBe('pulled a/b')
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
})

describe('postRerank', () => {
  test('a 200 with no results array is a failure, not an empty ranking', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({})
      },
    })
    try {
      await expect(
        postRerank(`http://127.0.0.1:${server.port}`, {
          model: 'r',
          query: 'q',
          documents: ['a'],
        }),
      ).rejects.toThrow('missing results')
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
})
