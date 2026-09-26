import { describe, expect, test } from 'bun:test'
import type { EnginedModelRow } from './door.ts'
import {
  buildImageRequest,
  buildReadImageRequest,
  buildSpeakRequest,
  buildTranscribeRequest,
  confirmationMessage,
} from './toolRequests.ts'

const comfy: EnginedModelRow = {
  id: '@/comfy/local',
  tools: false,
  serves: ['/openai/v1/images/generations', '/openai/v1/images/edits'],
  state: 'installed',
  capabilities: {},
}

const ocrRow: EnginedModelRow = {
  id: '@/llama/ocr',
  tools: true,
  serves: ['/openai/v1/chat/completions'],
  role: 'vision',
  vision: 'read',
  state: 'installed',
  capabilities: {},
}

const whisper: EnginedModelRow = {
  id: '@/whisper/large-v3-turbo',
  tools: false,
  serves: ['/openai/v1/audio/transcriptions', '/openai/v1/audio/translations'],
  translate: true,
  state: 'installed',
  capabilities: {},
}

const piper: EnginedModelRow = {
  id: '@/piper/local',
  tools: false,
  serves: ['/openai/v1/audio/speech'],
  egress: 'none',
  state: 'installed',
  capabilities: {},
}

describe('request builders', () => {
  test('image generation, no source', () => {
    const req = buildImageRequest(comfy, { prompt: 'a cat' })
    expect(req).toEqual({
      path: '/openai/v1/images/generations',
      body: { model: '@/comfy/local', prompt: 'a cat', size: undefined },
    })
  })

  test('image edit, a source given', () => {
    const source = new Blob(['x'])
    const req = buildImageRequest(comfy, { prompt: 'a cat', source })
    expect(req.path).toBe('/openai/v1/images/edits')
    expect((req as { form: { model: string } }).form.model).toBe('@/comfy/local')
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
