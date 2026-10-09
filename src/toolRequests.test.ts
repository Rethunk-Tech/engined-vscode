import { describe, expect, test } from 'bun:test'
import type { Door, EnginedModelRow } from './door.ts'
import {
  buildImageRequest,
  buildReadImageRequest,
  buildSpeakRequest,
  buildTranscribeRequest,
  confirmationMessage,
  ToolRouteError,
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
