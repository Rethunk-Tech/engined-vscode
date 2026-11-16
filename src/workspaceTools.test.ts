import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EnginedModelRow } from './door.ts'

const tools = new Map<string, { invoke: (options: unknown, token: unknown) => Promise<unknown> }>()
const vscodeState = { workspaceFolders: [] as { uri: { fsPath: string } }[] }

mock.module('vscode', () => {
  class LanguageModelTextPart {
    constructor(readonly value: string) {}
  }
  class LanguageModelToolResult {
    constructor(readonly content: unknown[]) {}
  }
  class FileSystemError extends Error {
    code = 'FileNotFound'
  }
  return {
    LanguageModelTextPart,
    LanguageModelToolResult,
    FileSystemError,
    FileType: { File: 1 },
    Uri: { file: (fsPath: string) => ({ fsPath }) },
    ViewColumn: { Beside: 2 },
    workspace: {
      get workspaceFolders() {
        return vscodeState.workspaceFolders
      },
      fs: {
        readFile: async (uri: { fsPath: string }) => readFileSync(uri.fsPath),
        stat: async (uri: { fsPath: string }) => {
          const s = statSync(uri.fsPath)
          return { type: 1, size: s.size }
        },
      },
    },
    lm: {
      registerTool: (
        name: string,
        tool: { invoke: (options: unknown, token: unknown) => Promise<unknown> },
      ) => {
        tools.set(name, tool)
        return { dispose() {} }
      },
    },
    commands: { executeCommand: () => Promise.resolve() },
  }
})

const { registerTools } = await import('./workspaceTools.ts')

const whisper: EnginedModelRow = {
  id: '@/whisper/large-v3-turbo',
  routeId: '@/whisper/large-v3-turbo',
  door: { name: 'local', url: 'http://127.0.0.1:29200' },
  tools: false,
  serves: ['/openai/v1/audio/transcriptions', '/openai/v1/audio/translations'],
  translate: true,
  probe: { kind: 'translate', quality: true, detail: '', at: 't' },
  state: 'installed',
  capabilities: {},
}

describe('engined_transcribe', () => {
  let root = ''
  const posted: string[] = []
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'engined-transcribe-'))
    writeFileSync(join(root, 'clip.wav'), 'RIFF')
    posted.length = 0
    tools.clear()
    vscodeState.workspaceFolders = [{ uri: { fsPath: root } }]
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      posted.push(String(input))
      return new Response(JSON.stringify({ text: 'hola' }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    registerTools({
      log: () => undefined,
      resolveRoleRow: () => whisper,
      searchIndex: () => {
        throw new Error('search unused')
      },
      callingChat: () => undefined,
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  })

  test('passes translate into the door request when the probe passed', async () => {
    const transcribe = tools.get('engined_transcribe')
    if (transcribe === undefined) {
      throw new Error('engined_transcribe was not registered')
    }
    await transcribe.invoke(
      { input: { path: 'clip.wav', translate: true } },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
    )
    const invokePassesTranslate = posted.some((url) =>
      url.endsWith('/openai/v1/audio/translations'),
    )
    expect(invokePassesTranslate).toBe(true)
    expect(posted.some((url) => url.endsWith('/openai/v1/audio/transcriptions'))).toBe(false)
  })
})
