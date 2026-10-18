import { describe, expect, test } from 'bun:test'
import {
  type ImagePreviewFrame,
  type PreviewFile,
  readImageEvents,
  removePreviewFile,
  writePreviewFile,
} from './imageStream.ts'

const IMAGE = { created: 1, data: [{ b64_json: Buffer.from('png').toString('base64') }] }
const JPEG = Buffer.from('jpeg-frame').toString('base64')
const PNG = Buffer.from('png-frame').toString('base64')

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function imageSse(): string {
  return [
    'event: progress',
    'data: {"value":1,"max":4,"node":"4"}',
    '',
    'event: preview',
    `data: ${JSON.stringify({ bytes: 10, format: 'jpeg', image: JPEG })}`,
    '',
    'event: preview',
    'data: {"bytes":40000,"format":"png"}',
    '',
    'event: preview',
    'data: {"bytes":8,"image":"aaaa"}',
    '',
    'event: preview',
    `data: ${JSON.stringify({ bytes: 9, format: 'png', image: PNG })}`,
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

describe('readImageEvents', () => {
  test('delivers inline previews in order and keeps the image event as the result', async () => {
    const lines: string[] = []
    const previews: ImagePreviewFrame[] = []
    const image = await readImageEvents(
      streamFromText(imageSse()),
      (line) => {
        lines.push(line)
      },
      (frame) => {
        previews.push(frame)
      },
    )
    expect(lines).toEqual(['Rendering 1/4 node 4', 'Rendering 4/4 node 4'])
    expect(previews).toEqual([
      { image: JPEG, format: 'jpeg' },
      { image: PNG, format: 'png' },
    ])
    expect(image).toEqual(IMAGE)
  })

  test('an error event throws after any preview already delivered', async () => {
    const previews: ImagePreviewFrame[] = []
    const stream = streamFromText(
      [
        'event: preview',
        `data: ${JSON.stringify({ format: 'jpeg', image: JPEG })}`,
        '',
        'event: error',
        'data: {"error":{"message":"checkpoint missing"}}',
        '',
        '',
      ].join('\n'),
    )
    await expect(
      readImageEvents(
        stream,
        () => undefined,
        (frame) => {
          previews.push(frame)
        },
      ),
    ).rejects.toThrow('checkpoint missing')
    expect(previews).toEqual([{ image: JPEG, format: 'jpeg' }])
  })
})

describe('writePreviewFile', () => {
  test('replaces the latest preview and removes it when the render finishes', async () => {
    const files = new Map<string, Uint8Array>()
    const io = {
      write: (path: string, bytes: Uint8Array): Promise<void> => {
        files.set(path, bytes)
        return Promise.resolve()
      },
      remove: (path: string): Promise<void> => {
        files.delete(path)
        return Promise.resolve()
      },
    }
    const file: PreviewFile = { path: undefined }
    await writePreviewFile(file, 'out/cube.png', { image: JPEG, format: 'jpeg' }, io)
    await writePreviewFile(file, 'out/cube.png', { image: JPEG, format: 'jpeg' }, io)
    expect([...files.keys()]).toEqual(['out/cube.png.preview.jpeg'])
    expect(files.get('out/cube.png.preview.jpeg')).toEqual(Buffer.from('jpeg-frame'))
    await writePreviewFile(file, 'out/cube.png', { image: PNG, format: 'png' }, io)
    expect([...files.keys()]).toEqual(['out/cube.png.preview.png'])
    expect(files.get('out/cube.png.preview.png')).toEqual(Buffer.from('png-frame'))
    await removePreviewFile(file, io.remove)
    await removePreviewFile(file, io.remove)
    expect(files.size).toBe(0)
    expect(file.path).toBeUndefined()
  })
})
