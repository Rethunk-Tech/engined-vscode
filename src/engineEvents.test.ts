import { describe, expect, test } from 'bun:test'
import { backoffMs, parseSseChunk } from './engineEvents.ts'

describe('parseSseChunk', () => {
  test('parses one complete frame with a JSON payload', () => {
    const { frames, rest } = parseSseChunk('event: snapshot\ndata: {"a":1}\n\n')
    expect(frames).toEqual([{ event: 'snapshot', data: { a: 1 } }])
    expect(rest).toBe('')
  })

  test('holds back a trailing partial frame as rest', () => {
    const { frames, rest } = parseSseChunk('event: engine\ndata: {"id":"x"}\n\nevent: eng')
    expect(frames).toEqual([{ event: 'engine', data: { id: 'x' } }])
    expect(rest).toBe('event: eng')
  })

  test('a chunk boundary mid-frame reassembles once fed back as rest', () => {
    const first = parseSseChunk('event: engine\ndata: {"id":')
    expect(first.frames).toEqual([])
    const second = parseSseChunk(`${first.rest}"x"}\n\n`)
    expect(second.frames).toEqual([{ event: 'engine', data: { id: 'x' } }])
  })

  test('ignores keepalive comment lines', () => {
    const { frames } = parseSseChunk(': keepalive\n\nevent: engine\ndata: {"id":"x"}\n\n')
    expect(frames).toEqual([{ event: 'engine', data: { id: 'x' } }])
  })

  test('defaults the event name to "message" when none is given', () => {
    const { frames } = parseSseChunk('data: {"ok":true}\n\n')
    expect(frames).toEqual([{ event: 'message', data: { ok: true } }])
  })

  test('non-JSON data is kept as the raw string rather than dropped', () => {
    const { frames } = parseSseChunk('event: engine\ndata: not json\n\n')
    expect(frames).toEqual([{ event: 'engine', data: 'not json' }])
  })

  test('a frame with no data line at all is dropped', () => {
    const { frames } = parseSseChunk('event: ping\n\n')
    expect(frames).toEqual([])
  })
})

describe('backoffMs', () => {
  test('doubles each attempt starting from baseMs', () => {
    expect(backoffMs(0)).toBe(1000)
    expect(backoffMs(1)).toBe(2000)
    expect(backoffMs(2)).toBe(4000)
    expect(backoffMs(3)).toBe(8000)
  })

  test('caps at maxMs', () => {
    expect(backoffMs(10)).toBe(60000)
  })

  test('never goes below baseMs for a negative attempt', () => {
    expect(backoffMs(-3)).toBe(1000)
  })
})
