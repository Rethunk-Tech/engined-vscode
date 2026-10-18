import { describe, expect, test } from 'bun:test'
import {
  agenticBusyMessage,
  DoorHttpError,
  doorErrorMessage,
  fetchAllDoors,
  postChatCompletion,
  postImage,
} from './doorClient.ts'

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
})

describe('fetchAllDoors', () => {
  test('a door whose models 503 but whose engines list carries config_error is reachable', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return new URL(req.url).pathname === '/openai/v1/models'
          ? new Response('{"error":"config"}', { status: 503 })
          : Response.json({ engines: [], config_error: 'bad toml' })
      },
    })
    try {
      const door = { name: 'a', url: `http://127.0.0.1:${server.port}` }
      const { doorStatus, chatModels } = await fetchAllDoors([door])
      expect(doorStatus).toEqual([{ door, reachable: true, configError: 'bad toml' }])
      expect(chatModels).toEqual([])
    } finally {
      await server.stop(true)
    }
  })

  test('config_error marks a reachable door; a failing engines list changes nothing', async () => {
    const serve = (engines: Response) =>
      Bun.serve({
        port: 0,
        fetch(req) {
          return new URL(req.url).pathname === '/openai/v1/models'
            ? Response.json({ data: [] })
            : engines
        },
      })
    const refusing = serve(Response.json({ data: [], config_error: 'bad toml' }))
    const broken = serve(new Response('nope', { status: 500 }))
    try {
      const a = { name: 'a', url: `http://127.0.0.1:${refusing.port}` }
      const b = { name: 'b', url: `http://127.0.0.1:${broken.port}` }
      const doors = [a, b]
      const { doorStatus } = await fetchAllDoors(doors)
      expect(doorStatus).toEqual([
        { door: a, reachable: true, configError: 'bad toml' },
        { door: b, reachable: true },
      ])
    } finally {
      await refusing.stop(true)
      await broken.stop(true)
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
