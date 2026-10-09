/** The five `engined_*` language-model tools and the workspace-path plumbing they share. */

import * as vscode from 'vscode'
import { cancellationSignal } from './cancellation.ts'
import { readChatStream } from './chatStream.ts'
import type { ModelRole } from './defaultModels.ts'
import { describeError } from './describeError.ts'
import type { EnginedModelRow } from './door.ts'
import { postChatCompletion, postForm, postJson } from './doorClient.ts'
import { PathEscapeError, resolveWorkspacePath } from './pathGuard.ts'
import { truncateSnippet } from './search.ts'
import type { SearchIndex } from './searchIndex.ts'
import {
  buildImageRequest,
  buildReadImageRequest,
  buildSpeakRequest,
  buildTranscribeRequest,
  type ConfirmationTarget,
  confirmationMessage,
  ToolRouteError,
} from './toolRequests.ts'

/** What the tools need from the activation module: they stay free of its module state. */
export interface ToolHost {
  log: (line: string) => void
  resolveRoleRow: (role: ModelRole, path?: string) => EnginedModelRow
  searchIndex: () => SearchIndex
}

let toolHost: ToolHost | undefined

function host(): ToolHost {
  if (toolHost === undefined) {
    throw new Error('registerTools has not run')
  }
  return toolHost
}

export function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)
}

async function readWorkspaceFile(path: string): Promise<Uint8Array> {
  const resolved = resolveWorkspacePath(workspaceRoots(), path)
  return await vscode.workspace.fs.readFile(vscode.Uri.file(resolved))
}

async function writeWorkspaceFile(path: string, data: Uint8Array): Promise<vscode.Uri> {
  const uri = vscode.Uri.file(resolveWorkspacePath(workspaceRoots(), path))
  await vscode.workspace.fs.writeFile(uri, data)
  return uri
}

/** `path` as the confirmation dialog names it: workspace-relative, and whether a write would replace a file. */
async function confirmationTarget(path: string, writes: boolean): Promise<ConfirmationTarget> {
  let uri: vscode.Uri
  try {
    uri = vscode.Uri.file(resolveWorkspacePath(workspaceRoots(), path))
  } catch {
    // The invoke call refuses an escaping path; the dialog just shows what was asked for.
    return { path }
  }
  const shown = vscode.workspace.asRelativePath(uri, false)
  if (!writes) {
    return { path: shown }
  }
  try {
    await vscode.workspace.fs.stat(uri)
    return { path: shown, overwrites: true }
  } catch {
    return { path: shown, overwrites: false }
  }
}

const IMAGE_MIME_TYPES: Partial<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

function mimeTypeFor(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  return IMAGE_MIME_TYPES[ext] ?? 'image/png'
}

function toolError(error: unknown): vscode.LanguageModelToolResult {
  const message =
    error instanceof PathEscapeError || error instanceof ToolRouteError
      ? error.message
      : describeError(error)
  host().log(`tool error: ${message}`)
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(`engined: ${message}`),
  ])
}

interface GenerateImageInput {
  prompt: string
  outputPath: string
  size?: string
  sourcePath?: string
}

function imagePath(sourcePath: string | undefined): string {
  return sourcePath === undefined ? '/openai/v1/images/generations' : '/openai/v1/images/edits'
}

const generateImageTool: vscode.LanguageModelTool<GenerateImageInput> = {
  async invoke(options, token) {
    try {
      const source =
        options.input.sourcePath === undefined
          ? undefined
          : new Blob([await readWorkspaceFile(options.input.sourcePath)])
      const row = host().resolveRoleRow('image', imagePath(options.input.sourcePath))
      const req = buildImageRequest(row, {
        prompt: options.input.prompt,
        size: options.input.size,
        source,
      })
      const result =
        req.path === '/openai/v1/images/generations'
          ? ((await postJson(row.door.url, req.path, req.body, cancellationSignal(token))) as {
              data: { b64_json: string }[]
            })
          : ((await postForm(
              row.door.url,
              req.path,
              buildEditForm(req.form),
              cancellationSignal(token),
            )) as {
              data: { b64_json: string }[]
            })
      const png = result.data[0]?.b64_json
      if (png === undefined) {
        throw new Error('engined returned no image data')
      }
      const uri = await writeWorkspaceFile(options.input.outputPath, Buffer.from(png, 'base64'))
      // The image is shown to the user, not returned to the model: a tool can't tell which
      // model called it, and Copilot's backend fails the next turn fetching an image part.
      await vscode.commands.executeCommand('vscode.open', uri, {
        preview: true,
        viewColumn: vscode.ViewColumn.Beside,
      })
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Wrote ${options.input.outputPath}; it is open beside the chat for the user to see.`,
        ),
      ])
    } catch (error) {
      return toolError(error)
    }
  },
  async prepareInvocation(options) {
    const row = host().resolveRoleRow('image', imagePath(options.input.sourcePath))
    const source =
      options.input.sourcePath === undefined
        ? undefined
        : (await confirmationTarget(options.input.sourcePath, false)).path
    return {
      confirmationMessages: {
        title: 'Generate image',
        message: confirmationMessage(
          row,
          source === undefined ? 'Generate image' : `Generate image from ${source}`,
          await confirmationTarget(options.input.outputPath, true),
        ),
      },
    }
  },
}

function buildEditForm(form: {
  model: string
  prompt: string
  image: Blob
  response_format: 'b64_json'
}): FormData {
  const data = new FormData()
  data.set('model', form.model)
  data.set('prompt', form.prompt)
  data.set('image', form.image)
  data.set('response_format', form.response_format)
  return data
}

interface ReadImageInput {
  path: string
  mode: 'ocr' | 'describe'
  question?: string
}

const readImageTool: vscode.LanguageModelTool<ReadImageInput> = {
  async invoke(options, token) {
    try {
      const bytes = await readWorkspaceFile(options.input.path)
      const row = host().resolveRoleRow(options.input.mode === 'ocr' ? 'ocr' : 'vision')
      const req = buildReadImageRequest(row, {
        mode: options.input.mode,
        question: options.input.question,
        mimeType: mimeTypeFor(options.input.path),
        base64: Buffer.from(bytes).toString('base64'),
      })
      const { body: stream } = await postChatCompletion(
        row.door.url,
        { ...req, stream: true, stream_options: { include_usage: true } },
        cancellationSignal(token),
      )
      let text = ''
      await readChatStream(stream, {
        text: (delta) => {
          text += delta
        },
      })
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)])
    } catch (error) {
      return toolError(error)
    }
  },
  async prepareInvocation(options) {
    const row = host().resolveRoleRow(options.input.mode === 'ocr' ? 'ocr' : 'vision')
    return {
      confirmationMessages: {
        title: 'Read image',
        message: confirmationMessage(
          row,
          `${options.input.mode === 'ocr' ? 'OCR' : 'Describe'} image`,
          await confirmationTarget(options.input.path, false),
        ),
      },
    }
  },
}

interface TranscribeInput {
  path: string
  translate?: boolean
}

const transcribeTool: vscode.LanguageModelTool<TranscribeInput> = {
  async invoke(options, token) {
    try {
      const bytes = await readWorkspaceFile(options.input.path)
      const row = host().resolveRoleRow('transcription', transcriptionPath(options.input.translate))
      const req = buildTranscribeRequest(row, {
        audio: new Blob([bytes]),
        translate: options.input.translate,
      })
      const form = new FormData()
      form.set('model', req.form.model)
      form.set('file', req.form.file)
      const result = (await postForm(row.door.url, req.path, form, cancellationSignal(token))) as
        | { text?: string }
        | ArrayBuffer
      const text =
        typeof result === 'object' && result !== null && 'text' in result
          ? (result.text ?? '')
          : String(result)
      const note =
        options.input.translate === true
          ? '\n\nNote: speech translation on this route is measured unreliable (it can return fluent but wrong English); prefer transcribing and translating the text.'
          : ''
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text + note)])
    } catch (error) {
      return toolError(error)
    }
  },
  async prepareInvocation(options) {
    const row = host().resolveRoleRow('transcription', transcriptionPath(options.input.translate))
    return {
      confirmationMessages: {
        title: 'Transcribe audio',
        message: confirmationMessage(
          row,
          'Transcribe audio',
          await confirmationTarget(options.input.path, false),
        ),
      },
    }
  },
}

function transcriptionPath(translate: boolean | undefined): string {
  return translate === true ? '/openai/v1/audio/translations' : '/openai/v1/audio/transcriptions'
}

interface SpeakInput {
  text: string
  outputPath: string
  voice?: string
}

const speakTool: vscode.LanguageModelTool<SpeakInput> = {
  async invoke(options, token) {
    try {
      const row = host().resolveRoleRow('speech')
      const req = buildSpeakRequest(row, {
        text: options.input.text,
        voice: options.input.voice,
      })
      const audio = (await postJson(
        row.door.url,
        req.path,
        req.body,
        cancellationSignal(token),
      )) as ArrayBuffer
      await writeWorkspaceFile(options.input.outputPath, new Uint8Array(audio))
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Wrote ${options.input.outputPath}`),
      ])
    } catch (error) {
      return toolError(error)
    }
  },
  async prepareInvocation(options) {
    const row = host().resolveRoleRow('speech')
    return {
      confirmationMessages: {
        title: 'Speak text',
        message: confirmationMessage(
          row,
          'Speak text',
          await confirmationTarget(options.input.outputPath, true),
        ),
      },
    }
  },
}

interface SearchInput {
  query: string
  maxResults?: number
}

const DEFAULT_SEARCH_MAX_RESULTS = 6

const searchTool: vscode.LanguageModelTool<SearchInput> = {
  async invoke(options, token) {
    try {
      const hits = await host()
        .searchIndex()
        .search(
          options.input.query,
          options.input.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS,
          cancellationSignal(token),
        )
      if (hits.length === 0) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('No matching results.'),
        ])
      }
      const text = hits
        .map((h) => `${h.path}:${h.startLine}-${h.endLine}\n${truncateSnippet(h.text)}`)
        .join('\n\n---\n\n')
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)])
    } catch (error) {
      return toolError(error)
    }
  },
}

/** Registers the five `engined_*` language-model tools. */
export function registerTools(tools: ToolHost): vscode.Disposable[] {
  toolHost = tools
  return [
    vscode.lm.registerTool('engined_generateImage', generateImageTool),
    vscode.lm.registerTool('engined_readImage', readImageTool),
    vscode.lm.registerTool('engined_transcribe', transcribeTool),
    vscode.lm.registerTool('engined_speak', speakTool),
    vscode.lm.registerTool('engined_search', searchTool),
  ]
}
