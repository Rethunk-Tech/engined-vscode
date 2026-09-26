import { describe, expect, test } from 'bun:test'
import type { EnginedModelRow } from './door.ts'
import {
  buildImageRequest,
  buildReadImageRequest,
  buildSpeakRequest,
  buildTranscribeRequest,
  confirmationMessage,
  pickVisionRoute,
  ToolRouteError,
} from './toolRequests.ts'

const rows: EnginedModelRow[] = [
  {
    id: '@/comfy/local',
    tools: false,
    serves: ['/openai/v1/images/generations', '/openai/v1/images/edits'],
    state: 'installed',
    capabilities: {},
  },
  {
    id: '@/llama/vision',
    tools: true,
    serves: ['/openai/v1/chat/completions'],
    role: 'vision',
    vision: 'describe',
    state: 'installed',
    capabilities: {},
  },
  {
    id: '@/llama/ocr',
    tools: true,
    serves: ['/openai/v1/chat/completions'],
    role: 'vision',
    vision: 'read',
    state: 'installed',
    capabilities: {},
  },
  {
    id: '@/whisper/large-v3-turbo',
    tools: false,
    serves: ['/openai/v1/audio/transcriptions', '/openai/v1/audio/translations'],
    translate: true,
    state: 'installed',
    capabilities: {},
  },
  {
    id: '@/whisper/small.en',
    tools: false,
    serves: ['/openai/v1/audio/transcriptions'],
    state: 'installed',
    capabilities: {},
  },
  {
    id: '@/piper/local',
    tools: false,
    serves: ['/openai/v1/audio/speech'],
    egress: 'none',
    state: 'installed',
    capabilities: {},
  },
]

describe('route picking', () => {
  test('image generation picks the comfy route when no source is given', () => {
    const req = buildImageRequest(rows, { prompt: 'a cat' })
    expect(req.path).toBe('/openai/v1/images/generations')
    expect((req as { body: { model: string } }).body.model).toBe('@/comfy/local')
  })

  test('image edit picks the comfy route when a source is given', () => {
    const req = buildImageRequest(rows, { prompt: 'a cat', source: new Blob(['x']) })
    expect(req.path).toBe('/openai/v1/images/edits')
  })

  test('vision route picking distinguishes ocr from describe', () => {
    expect(pickVisionRoute(rows, 'ocr').id).toBe('@/llama/ocr')
    expect(pickVisionRoute(rows, 'describe').id).toBe('@/llama/vision')
  })

  test('read image builds a data-URI chat request against the picked vision row', () => {
    const req = buildReadImageRequest(rows, { mode: 'ocr', mimeType: 'image/png', base64: 'AAAA' })
    expect(req.model).toBe('@/llama/ocr')
    expect(req.messages[0].content[1].image_url.url).toBe('data:image/png;base64,AAAA')
  })

  test('translate=true requires a route whose translate is true', () => {
    const req = buildTranscribeRequest(rows, { audio: new Blob(['x']), translate: true })
    expect(req.path).toBe('/openai/v1/audio/translations')
    expect(req.form.model).toBe('@/whisper/large-v3-turbo')
  })

  test('plain transcription accepts the first installed transcriber, translate-capable or not', () => {
    const req = buildTranscribeRequest(rows, { audio: new Blob(['x']) })
    expect(req.form.model).toBe('@/whisper/large-v3-turbo')
  })

  test('speech picks the tts route and carries voice through', () => {
    const req = buildSpeakRequest(rows, { text: 'hello', voice: 'v1' })
    expect(req.body).toEqual({ model: '@/piper/local', input: 'hello', voice: 'v1' })
  })

  test('a missing route throws ToolRouteError naming what is missing', () => {
    expect(() => buildSpeakRequest([], { text: 'hi' })).toThrow(ToolRouteError)
  })
})

describe('confirmationMessage', () => {
  test('names local egress with no extra warning', () => {
    expect(confirmationMessage(rows[5] as EnginedModelRow, 'Speak text')).toBe(
      'Speak text via @/piper/local.',
    )
  })

  test('warns when egress is not local', () => {
    const remoteRow: EnginedModelRow = {
      id: '@/claude/sonnet-5',
      tools: false,
      serves: [],
      egress: 'remote',
      state: 'installed',
      capabilities: {},
    }
    expect(confirmationMessage(remoteRow, 'Describe image')).toContain('leaves this machine')
  })
})
