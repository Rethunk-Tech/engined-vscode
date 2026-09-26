/**
 * The thin adapter: register the chat provider, the tools, the status bar
 * and log, and convert between real `vscode` values and the plain shapes
 * `door.ts`/`requestBuilder.ts`/`chatStream.ts`/`toolRequests.ts` operate on.
 * Everything decision-shaped lives in those files; this file only wires.
 */

import * as vscode from 'vscode'
import { readChatStream } from './chatStream.ts'
import {
  getPollSeconds,
  getReasoningEffort,
  getReasoningEffortByModel,
  getUrl,
  setReasoningEffort,
} from './config.ts'
import type { EnginedModelInfo, ReasoningLevel } from './door.ts'
import { REASONING_LEVELS } from './door.ts'
import { DoorHttpError, fetchModels, postChatCompletion, postForm, postJson } from './doorClient.ts'
import { PathEscapeError, resolveWorkspacePath } from './pathGuard.ts'
import { ModelPoller } from './polling.ts'
import type { PlainMessage, PlainMessagePart } from './requestBuilder.ts'
import {
  buildChatRequestBody,
  estimateMessageTokenCount,
  estimateTokenCount,
} from './requestBuilder.ts'
import {
  buildImageRequest,
  buildReadImageRequest,
  buildSpeakRequest,
  buildTranscribeRequest,
  confirmationMessage,
  pickRoute,
  pickVisionRoute,
  ToolRouteError,
} from './toolRequests.ts'

let output: vscode.OutputChannel
let poller: ModelPoller
let statusBarItem: vscode.StatusBarItem
let pollTimer: ReturnType<typeof setInterval> | undefined

function log(line: string): void {
  output.appendLine(`[${new Date().toISOString()}] ${line}`)
}

function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)
}

// --- vscode <-> plain message conversion --------------------------------

function toPlainPart(part: unknown): PlainMessagePart | undefined {
  if (part instanceof vscode.LanguageModelTextPart) {
    return { type: 'text', text: part.value }
  }
  if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
    return {
      type: 'image',
      mimeType: part.mimeType,
      base64: Buffer.from(part.data).toString('base64'),
    }
  }
  if (part instanceof vscode.LanguageModelToolCallPart) {
    return { type: 'toolCall', id: part.callId, name: part.name, arguments: part.input }
  }
  if (part instanceof vscode.LanguageModelToolResultPart) {
    const text = part.content
      .map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : ''))
      .join('')
    return { type: 'toolResult', toolCallId: part.callId, text }
  }
  return undefined
}

function toPlainMessage(message: vscode.LanguageModelChatRequestMessage): PlainMessage {
  const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user'
  const parts: PlainMessagePart[] = []
  for (const part of message.content) {
    const plain = toPlainPart(part)
    if (plain !== undefined) {
      parts.push(plain)
    }
  }
  return { role, parts }
}

// --- the chat provider ----------------------------------------------------

class EnginedChatProvider implements vscode.LanguageModelChatProvider<EnginedModelInfo> {
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeLanguageModelChatInformation = this.emitter.event

  fire(): void {
    this.emitter.fire()
  }

  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<EnginedModelInfo[]> {
    return [...poller.models]
  }

  async provideLanguageModelChatResponse(
    model: EnginedModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const plainMessages = messages.map(toPlainMessage)
    const body = buildChatRequestBody(model, plainMessages, {
      tools: options.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
      toolChoiceRequired: options.toolMode === vscode.LanguageModelChatToolMode.Required,
      reasoningEffort: getReasoningEffort(),
      reasoningEffortByModel: getReasoningEffortByModel(),
    })
    const controller = new AbortController()
    token.onCancellationRequested(() => controller.abort())
    let stream: ReadableStream<Uint8Array>
    try {
      stream = await postChatCompletion(getUrl(), body, controller.signal)
    } catch (error) {
      log(`chat completion failed for ${model.id}: ${describeError(error)}`)
      throw asError(error)
    }
    const toolCalls = await readChatStream(stream, {
      text: (delta) => progress.report(new vscode.LanguageModelTextPart(delta)),
    })
    for (const call of toolCalls) {
      progress.report(
        new vscode.LanguageModelToolCallPart(call.id, call.name, call.arguments ?? {}),
      )
    }
  }

  async provideTokenCount(
    _model: EnginedModelInfo,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    return typeof text === 'string'
      ? estimateTokenCount(text)
      : estimateMessageTokenCount(toPlainMessage(text))
  }
}

function describeError(error: unknown): string {
  if (error instanceof DoorHttpError) {
    return `HTTP ${error.status}: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

// --- polling and status bar ------------------------------------------------

function updateStatusBar(reachable: boolean, count: number): void {
  statusBarItem.text = reachable ? `$(hubot) engined (${count})` : '$(warning) engined unreachable'
  statusBarItem.tooltip = reachable
    ? `${count} model(s) available from ${getUrl()}`
    : `Could not reach engined at ${getUrl()}`
}

function restartPollTimer(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
  const seconds = getPollSeconds()
  if (seconds > 0) {
    pollTimer = setInterval(() => void poller.pollNow(), seconds * 1000)
  }
  void poller.pollNow()
}

async function showQuickPick(chatProvider: EnginedChatProvider): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Refresh models', action: 'refresh' as const },
      { label: 'Set reasoning effort (global)', action: 'effort-global' as const },
      { label: 'Set reasoning effort for a model', action: 'effort-model' as const },
      { label: 'Show engined log', action: 'log' as const },
    ],
    { title: 'engined' },
  )
  if (pick === undefined) {
    return
  }
  if (pick.action === 'refresh') {
    await poller.pollNow()
    chatProvider.fire()
  } else if (pick.action === 'log') {
    output.show()
  } else if (pick.action === 'effort-global') {
    await pickAndSetEffort()
  } else {
    const model = await vscode.window.showQuickPick(
      poller.models.map((m) => m.name),
      { title: 'Model' },
    )
    const id = poller.models.find((m) => m.name === model)?.id
    if (id !== undefined) {
      await pickAndSetEffort(id)
    }
  }
}

async function pickAndSetEffort(modelId?: string): Promise<void> {
  const level = await vscode.window.showQuickPick([...REASONING_LEVELS], {
    title: 'Reasoning effort',
  })
  if (level !== undefined) {
    await setReasoningEffort(level as ReasoningLevel, modelId)
  }
}

// --- tools ------------------------------------------------------------------

async function readWorkspaceFile(path: string): Promise<Uint8Array> {
  const resolved = resolveWorkspacePath(workspaceRoots(), path)
  return vscode.workspace.fs.readFile(vscode.Uri.file(resolved))
}

async function writeWorkspaceFile(path: string, data: Uint8Array): Promise<void> {
  const resolved = resolveWorkspacePath(workspaceRoots(), path)
  await vscode.workspace.fs.writeFile(vscode.Uri.file(resolved), data)
}

function mimeTypeFor(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  return ext === 'jpg' || ext === 'jpeg'
    ? 'image/jpeg'
    : ext === 'webp'
      ? 'image/webp'
      : 'image/png'
}

function toolError(error: unknown): vscode.LanguageModelToolResult {
  const message =
    error instanceof PathEscapeError || error instanceof ToolRouteError
      ? error.message
      : describeError(error)
  log(`tool error: ${message}`)
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

const generateImageTool: vscode.LanguageModelTool<GenerateImageInput> = {
  async invoke(options) {
    try {
      const source =
        options.input.sourcePath !== undefined
          ? new Blob([await readWorkspaceFile(options.input.sourcePath)])
          : undefined
      const req = buildImageRequest(
        poller.models.map((m) => m.row),
        { prompt: options.input.prompt, size: options.input.size, source },
      )
      const result =
        req.path === '/openai/v1/images/generations'
          ? ((await postJson(getUrl(), req.path, req.body)) as { data: { b64_json: string }[] })
          : ((await postForm(getUrl(), req.path, buildEditForm(req.form))) as {
              data: { b64_json: string }[]
            })
      const png = result.data[0]?.b64_json
      if (png === undefined) {
        throw new Error('engined returned no image data')
      }
      await writeWorkspaceFile(options.input.outputPath, Buffer.from(png, 'base64'))
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Wrote ${options.input.outputPath}`),
      ])
    } catch (error) {
      return toolError(error)
    }
  },
  prepareInvocation(options) {
    const row = pickRoute(
      poller.models.map((m) => m.row),
      options.input.sourcePath !== undefined
        ? '/openai/v1/images/edits'
        : '/openai/v1/images/generations',
      'image generation',
    )
    return {
      confirmationMessages: {
        title: 'Generate image',
        message: confirmationMessage(row, 'Generate image'),
      },
    }
  },
}

function buildEditForm(form: { model: string; prompt: string; image: Blob }): FormData {
  const data = new FormData()
  data.set('model', form.model)
  data.set('prompt', form.prompt)
  data.set('image', form.image)
  return data
}

interface ReadImageInput {
  path: string
  mode: 'ocr' | 'describe'
  question?: string
}

const readImageTool: vscode.LanguageModelTool<ReadImageInput> = {
  async invoke(options) {
    try {
      const bytes = await readWorkspaceFile(options.input.path)
      const req = buildReadImageRequest(
        poller.models.map((m) => m.row),
        {
          mode: options.input.mode,
          question: options.input.question,
          mimeType: mimeTypeFor(options.input.path),
          base64: Buffer.from(bytes).toString('base64'),
        },
      )
      const stream = await postChatCompletion(
        getUrl(),
        { ...req, stream: true, stream_options: { include_usage: true } },
        new AbortController().signal,
      )
      let text = ''
      await readChatStream(stream, { text: (delta) => (text += delta) })
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)])
    } catch (error) {
      return toolError(error)
    }
  },
  prepareInvocation(options) {
    const row = pickVisionRoute(
      poller.models.map((m) => m.row),
      options.input.mode,
    )
    return {
      confirmationMessages: {
        title: 'Read image',
        message: confirmationMessage(
          row,
          `${options.input.mode === 'ocr' ? 'OCR' : 'Describe'} image`,
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
  async invoke(options) {
    try {
      const bytes = await readWorkspaceFile(options.input.path)
      const req = buildTranscribeRequest(
        poller.models.map((m) => m.row),
        {
          audio: new Blob([bytes]),
          translate: options.input.translate,
        },
      )
      const form = new FormData()
      form.set('model', req.form.model)
      form.set('file', req.form.file)
      const result = (await postForm(getUrl(), req.path, form)) as { text?: string } | ArrayBuffer
      const text =
        typeof result === 'object' && result !== null && 'text' in result
          ? (result.text ?? '')
          : String(result)
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)])
    } catch (error) {
      return toolError(error)
    }
  },
  prepareInvocation(options) {
    const row = pickRoute(
      poller.models.map((m) => m.row),
      options.input.translate === true
        ? '/openai/v1/audio/translations'
        : '/openai/v1/audio/transcriptions',
      'audio transcription',
    )
    return {
      confirmationMessages: {
        title: 'Transcribe audio',
        message: confirmationMessage(row, 'Transcribe audio'),
      },
    }
  },
}

interface SpeakInput {
  text: string
  outputPath: string
  voice?: string
}

const speakTool: vscode.LanguageModelTool<SpeakInput> = {
  async invoke(options) {
    try {
      const req = buildSpeakRequest(
        poller.models.map((m) => m.row),
        { text: options.input.text, voice: options.input.voice },
      )
      const audio = (await postJson(getUrl(), req.path, req.body)) as ArrayBuffer
      await writeWorkspaceFile(options.input.outputPath, new Uint8Array(audio))
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Wrote ${options.input.outputPath}`),
      ])
    } catch (error) {
      return toolError(error)
    }
  },
  prepareInvocation() {
    const row = pickRoute(
      poller.models.map((m) => m.row),
      '/openai/v1/audio/speech',
      'text-to-speech',
    )
    return {
      confirmationMessages: {
        title: 'Speak text',
        message: confirmationMessage(row, 'Speak text'),
      },
    }
  },
}

// --- activation ---------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('engined')
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBarItem.command = 'engined.showQuickPick'
  statusBarItem.show()

  const chatProvider = new EnginedChatProvider()
  poller = new ModelPoller(
    () =>
      fetchModels(getUrl()).catch((error) => {
        log(`poll failed: ${describeError(error)}`)
        throw error
      }),
    (models) => {
      updateStatusBar(true, models.length)
      chatProvider.fire()
    },
  )

  restartPollTimer()

  context.subscriptions.push(
    output,
    statusBarItem,
    vscode.lm.registerLanguageModelChatProvider('engined', chatProvider),
    vscode.lm.registerTool('engined_generateImage', generateImageTool),
    vscode.lm.registerTool('engined_readImage', readImageTool),
    vscode.lm.registerTool('engined_transcribe', transcribeTool),
    vscode.lm.registerTool('engined_speak', speakTool),
    vscode.commands.registerCommand('engined.refreshModels', async () => {
      await poller.pollNow()
      chatProvider.fire()
    }),
    vscode.commands.registerCommand('engined.showQuickPick', () => showQuickPick(chatProvider)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('engined.pollSeconds') || e.affectsConfiguration('engined.url')) {
        restartPollTimer()
      }
    }),
    new vscode.Disposable(() => {
      if (pollTimer !== undefined) {
        clearInterval(pollTimer)
      }
    }),
  )
}

export function deactivate(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}
