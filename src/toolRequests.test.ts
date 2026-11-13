import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Door, EnginedModelRow } from './door.ts'
import { PathEscapeError } from './pathGuard.ts'
import {
  buildImageRequest,
  buildReadImageRequest,
  buildSpeakRequest,
  buildTranscribeRequest,
  checkToolReadSize,
  checkVoiceFile,
  confirmationMessage,
  generateImageWorkspacePaths,
  MAX_TOOL_READ_BYTES,
  MAX_VOICE_BYTES,
  refuseTranslate,
  requestSpeech,
  searchConfirmationMessage,
  speakAction,
  ToolRouteError,
  TRANSLATE_UNAVAILABLE,
  transcribeAction,
  voiceUploadPath,
} from './toolRequests.ts'

const DOOR: Door = { name: 'local', url: 'http://127.0.0.1:29200' }

// `id` is qualified as `gpu-box/@/comfy/local` to prove a request body sends `routeId`
// (the door's own raw id), never the VS Code/settings-facing qualified id.
const comfy: EnginedModelRow = {
  id: 'gpu-box/@/comfy/local',
  routeId: '@/comfy/local',
  door: DOOR,
  tools: false,
  serves: ['/openai/v1/images/generations', '/openai/v1/images/edits'],
  state: 'installed',
  capabilities: {},
}

const ocrRow: EnginedModelRow = {
  id: '@/llama/ocr',
  routeId: '@/llama/ocr',
  door: DOOR,
  tools: true,
  serves: ['/openai/v1/chat/completions'],
  role: 'vision',
  vision: 'read',
  state: 'installed',
  capabilities: {},
}

const whisper: EnginedModelRow = {
  id: '@/whisper/large-v3-turbo',
  routeId: '@/whisper/large-v3-turbo',
  door: DOOR,
  tools: false,
  serves: ['/openai/v1/audio/transcriptions', '/openai/v1/audio/translations'],
  translate: true,
  state: 'installed',
  capabilities: {},
}

const piper: EnginedModelRow = {
  id: '@/piper/local',
  routeId: '@/piper/local',
  door: DOOR,
  tools: false,
  serves: ['/openai/v1/audio/speech'],
  egress: 'none',
  state: 'installed',
  capabilities: {},
}

describe('request builders', () => {
  test('image generation size must be WxH with sides 64-4096 and multiples of 8', () => {
    expect(() => buildImageRequest(comfy, { prompt: 'a cat', size: '1024x768' })).not.toThrow()
    expect(() => buildImageRequest(comfy, { prompt: 'a cat', size: '64x64' })).not.toThrow()
    expect(() => buildImageRequest(comfy, { prompt: 'a cat', size: '4096x4096' })).not.toThrow()
    const reject = (size: string): void => {
      expect(() => buildImageRequest(comfy, { prompt: 'a cat', size })).toThrow(ToolRouteError)
      expect(() => buildImageRequest(comfy, { prompt: 'a cat', size })).toThrow(
        'size must be WxH with each side 64-4096 and a multiple of 8',
      )
    }
    reject('1024')
    reject('63x64')
    reject('65x64')
    reject('4104x64')
    reject('512x512.0')
  })

  test('image edit rejects an invalid size before sending', () => {
    expect(() =>
      buildImageRequest(comfy, { prompt: 'a cat', size: '10x10', source: new Blob(['x']) }),
    ).toThrow('size must be WxH with each side 64-4096 and a multiple of 8')
  })

  test('image generation, no source', () => {
    const req = buildImageRequest(comfy, { prompt: 'a cat' })
    expect(req).toEqual({
      path: '/openai/v1/images/generations',
      body: {
        model: '@/comfy/local',
        prompt: 'a cat',
        size: undefined,
        response_format: 'b64_json',
      },
    })
  })

  test('image edit, a source given', () => {
    const source = new Blob(['x'])
    const req = buildImageRequest(comfy, { prompt: 'a cat', source })
    expect(req.path).toBe('/openai/v1/images/edits')
    expect((req as { form: { model: string; response_format: string } }).form.model).toBe(
      '@/comfy/local',
    )
    expect((req as { form: { response_format: string } }).form.response_format).toBe('b64_json')
  })

  test('read image builds a data-URI chat request against the given row', () => {
    const req = buildReadImageRequest(ocrRow, {
      mode: 'ocr',
      mimeType: 'image/png',
      base64: 'AAAA',
    })
    expect(req.model).toBe('@/llama/ocr')
    expect(req.messages[0].content[1].image_url.url).toBe('data:image/png;base64,AAAA')
  })

  test('translate stays unoffered when the quality probe is absent or failing', () => {
    expect(refuseTranslate(true)).toBe(TRANSLATE_UNAVAILABLE)
    expect(refuseTranslate(true, { quality: false })).toBe(TRANSLATE_UNAVAILABLE)
    expect(refuseTranslate(undefined)).toBeUndefined()
    expect(refuseTranslate(true, { quality: true })).toBeUndefined()
  })

  test('transcribe picks the translations path when asked to translate', () => {
    const req = buildTranscribeRequest(whisper, { audio: new Blob(['x']), translate: true })
    expect(req.path).toBe('/openai/v1/audio/translations')
    expect(req.form.model).toBe('@/whisper/large-v3-turbo')
  })

  test('transcribe defaults to the transcriptions path', () => {
    const req = buildTranscribeRequest(whisper, { audio: new Blob(['x']) })
    expect(req.path).toBe('/openai/v1/audio/transcriptions')
  })

  test('speech carries voice through', () => {
    const req = buildSpeakRequest(piper, { text: 'hello', voice: 'v1' })
    expect(req.body).toEqual({ model: '@/piper/local', input: 'hello', voice: 'v1' })
  })

  test('a workspace voice file is uploaded, then spoken with the returned handle', async () => {
    const reference = new Uint8Array([1, 2, 3, 4])
    const paths: string[] = []
    const uploads: { name: string; bytes: Uint8Array }[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname
        paths.push(path)
        if (path === '/engined/v1/audio/voices') {
          const form = await req.formData()
          const file = form.get('file')
          if (!(file instanceof File)) {
            return new Response('expected file', { status: 400 })
          }
          uploads.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
          return Response.json({ voice: 'vc_cef8305b2eb7c0bf8766de6b1f5d0fab.wav', bytes: 4 })
        }
        expect(await req.json()).toEqual({
          model: '@/piper/local',
          input: 'hello',
          voice: 'vc_cef8305b2eb7c0bf8766de6b1f5d0fab.wav',
        })
        return new Response(Uint8Array.from([9, 8, 7]), {
          headers: { 'content-type': 'audio/wav' },
        })
      },
    })
    try {
      const row: EnginedModelRow = {
        ...piper,
        door: { name: 'local', url: `http://127.0.0.1:${server.port}` },
      }
      const audio = await requestSpeech(
        row,
        { text: 'hello', voice: 'clips/me.wav' },
        {
          roots: ['/workspace/project'],
          fileSize: async () => reference.length,
          readFile: async (absolute) => {
            expect(absolute).toBe(join('/workspace/project', 'clips/me.wav'))
            return reference
          },
        },
      )
      expect(paths).toEqual(['/engined/v1/audio/voices', '/openai/v1/audio/speech'])
      expect(new Uint8Array(audio)).toEqual(Uint8Array.from([9, 8, 7]))
      expect(uploads).toEqual([{ name: 'me.wav', bytes: reference }])
    } finally {
      await server.stop(true)
    }
  })

  test('a bare voice name or a vc_ handle is sent as-is and not uploaded', async () => {
    const paths: string[] = []
    const bodies: unknown[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        paths.push(new URL(req.url).pathname)
        bodies.push(await req.json())
        return new Response(Uint8Array.from([1]), { headers: { 'content-type': 'audio/wav' } })
      },
    })
    try {
      const row: EnginedModelRow = {
        ...piper,
        door: { name: 'local', url: `http://127.0.0.1:${server.port}` },
      }
      const roots = ['/workspace/project']
      await requestSpeech(
        row,
        { text: 'hello', voice: 'af_heart' },
        { roots, fileSize: async () => undefined, readFile: async () => undefined },
      )
      await requestSpeech(
        row,
        { text: 'hello', voice: 'af_heart' },
        {
          roots: [],
          fileSize: async () => undefined,
          readFile: async () => {
            throw new Error('a bare name is not a path when no folder is open')
          },
        },
      )
      let reads = 0
      await requestSpeech(
        row,
        { text: 'hello', voice: 'vc_already.wav' },
        {
          fileSize: async () => undefined,
          roots,
          readFile: async () => {
            reads += 1
            return new Uint8Array([1])
          },
        },
      )
      expect(reads).toBe(0)
      expect(paths).toEqual([
        '/openai/v1/audio/speech',
        '/openai/v1/audio/speech',
        '/openai/v1/audio/speech',
      ])
      expect(bodies).toEqual([
        { model: '@/piper/local', input: 'hello', voice: 'af_heart' },
        { model: '@/piper/local', input: 'hello', voice: 'af_heart' },
        { model: '@/piper/local', input: 'hello', voice: 'vc_already.wav' },
      ])
    } finally {
      await server.stop(true)
    }
  })

  test('a voice path outside the workspace is refused before any upload', async () => {
    let reads = 0
    await expect(
      requestSpeech(
        piper,
        { text: 'hello', voice: '../secret.wav' },
        {
          roots: ['/workspace/project'],
          fileSize: async () => undefined,
          readFile: async () => {
            reads += 1
            return new Uint8Array([1])
          },
        },
      ),
    ).rejects.toThrow(PathEscapeError)
    expect(reads).toBe(0)
  })
})

describe('speak voice files', () => {
  test('an escaping output path throws before any door request', async () => {
    let reads = 0
    await expect(
      requestSpeech(
        piper,
        { text: 'hello', voice: 'vc_already.wav', outputPath: '../out.wav' },
        {
          roots: ['/workspace/project'],
          fileSize: async () => undefined,
          readFile: async () => {
            reads += 1
            return new Uint8Array([1])
          },
        },
      ),
    ).rejects.toThrow(PathEscapeError)
    expect(reads).toBe(0)
  })

  test('a voice file that is not audio is refused without being read', async () => {
    let reads = 0
    await expect(
      requestSpeech(
        piper,
        { text: 'hello', voice: '.env' },
        {
          roots: ['/workspace/project'],
          fileSize: async () => 12,
          readFile: async () => {
            reads += 1
            return new Uint8Array([1])
          },
        },
      ),
    ).rejects.toThrow(ToolRouteError)
    expect(reads).toBe(0)
  })

  test('a voice file over 20 MiB is refused without being read', async () => {
    let reads = 0
    await expect(
      requestSpeech(
        piper,
        { text: 'hello', voice: 'clips/Big.WAV' },
        {
          roots: ['/workspace/project'],
          fileSize: async () => MAX_VOICE_BYTES + 1,
          readFile: async () => {
            reads += 1
            return new Uint8Array([1])
          },
        },
      ),
    ).rejects.toThrow(ToolRouteError)
    expect(reads).toBe(0)
  })

  test('a voice file of exactly 20 MiB passes the check', async () => {
    await expect(
      checkVoiceFile('/workspace/project/Me.OGG', async () => MAX_VOICE_BYTES),
    ).resolves.toBe(true)
  })
})

describe('generateImageWorkspacePaths', () => {
  test('an escaping output path throws before a source path is considered', () => {
    expect(() =>
      generateImageWorkspacePaths(['/workspace/project'], {
        outputPath: '../out.png',
        sourcePath: 'src.png',
      }),
    ).toThrow(PathEscapeError)
  })
})

describe('checkToolReadSize', () => {
  test('refuses a file over 32 MiB and allows a missing or smaller one', () => {
    expect(() => checkToolReadSize(MAX_TOOL_READ_BYTES + 1)).toThrow(ToolRouteError)
    expect(() => checkToolReadSize(MAX_TOOL_READ_BYTES)).not.toThrow()
    expect(() => checkToolReadSize(undefined)).not.toThrow()
  })
})

describe('confirmationMessage', () => {
  test('names local egress with no extra warning', () => {
    expect(confirmationMessage(piper, 'Speak text')).toBe('Speak text via @/piper/local.')
  })

  test('names the target path and warns when it overwrites a file', () => {
    expect(confirmationMessage(piper, 'Speak text', { path: 'out/hi.wav' })).toBe(
      'Speak text via @/piper/local. Path: out/hi.wav.',
    )
    expect(confirmationMessage(piper, 'Speak text', { path: 'out/hi.wav', overwrites: true })).toBe(
      'Speak text via @/piper/local. Path: out/hi.wav. This overwrites an existing file.',
    )
  })

  test('warns when egress is not local', () => {
    const remoteRow: EnginedModelRow = {
      id: '@/claude/sonnet-5',
      routeId: '@/claude/sonnet-5',
      door: DOOR,
      tools: false,
      serves: [],
      egress: 'remote',
      state: 'installed',
      capabilities: {},
    }
    expect(confirmationMessage(remoteRow, 'Describe image')).toContain('leaves this machine')
  })
})

describe('transcribe confirmation', () => {
  test('names translate when that is what the call will do', () => {
    expect(transcribeAction(undefined)).toBe('Transcribe audio')
    expect(transcribeAction(false)).toBe('Transcribe audio')
    expect(transcribeAction(true)).toBe('Translate audio')
  })
})

describe('speak confirmation', () => {
  const root = join('/', 'ws')

  test('a voice that names a workspace file is resolved, so the dialog can name the upload', () => {
    expect(voiceUploadPath('.env', [root])).toBe(join(root, '.env'))
    expect(voiceUploadPath('secrets', [root])).toBe(join(root, 'secrets'))
    expect(speakAction('.env')).toBe('Speak text, uploading voice file .env')
  })

  test('a handle, or a bare name with no folder open, uploads nothing', () => {
    expect(voiceUploadPath('vc_abc', [root])).toBeUndefined()
    expect(voiceUploadPath('af_heart', [])).toBeUndefined()
    expect(voiceUploadPath(undefined, [root])).toBeUndefined()
    expect(speakAction(undefined)).toBe('Speak text')
  })

  test('an escaping voice path throws before anything is read', () => {
    expect(() => voiceUploadPath('../outside.wav', [root])).toThrow(PathEscapeError)
  })
})

describe('searchConfirmationMessage', () => {
  test('warns when the calling chat route is missing or not local', () => {
    expect(searchConfirmationMessage('secrets', { route: '@/llama/ornith', egress: 'none' })).toBe(
      'Search the workspace for "secrets". Results go to @/llama/ornith.',
    )
    expect(searchConfirmationMessage('secrets', { route: 'copilot', egress: 'remote' })).toContain(
      'leave this machine',
    )
    expect(searchConfirmationMessage('secrets', undefined)).toContain('leave this machine')
  })

  test('stale callingChat yields the may-leave-this-machine warning', () => {
    const chat: { route?: string; egress?: string; at?: number } = {
      route: '@/llama/ornith',
      egress: 'none',
      at: Date.now() - 10_000,
    }
    expect(searchConfirmationMessage('secrets', chat)).toContain('leave this machine')
  })
})
