/**
 * The thin adapter: register the chat provider, the tools, the status bar
 * and log, and convert between real `vscode` values and the plain shapes
 * `door.ts`/`requestBuilder.ts`/`chatStream.ts`/`toolRequests.ts` operate on.
 * Everything decision-shaped lives in those files; this file only wires.
 */

import * as vscode from 'vscode'
import { readChatStream } from './chatStream.ts'
import {
  buildCompletionsRequestBody,
  COMPLETIONS_PATH,
  extractCompletionText,
  extractCompletionUsage,
  sliceContext,
} from './completions.ts'
import {
  getCompletionsEnabled,
  getDefaultModel,
  getNeighbourContextEnabled,
  getPollSeconds,
  getReasoningEffort,
  getReasoningEffortByModel,
  getUrl,
  setDefaultModel,
  setReasoningEffort,
} from './config.ts'
import type { DefaultModelResolution, ModelRole } from './defaultModels.ts'
import { qualifyingRows, ROLE_PATH, resolveDefaultModel } from './defaultModels.ts'
import type { EnginedModelInfo, EnginedModelRow, ReasoningLevel } from './door.ts'
import { REASONING_LEVELS } from './door.ts'
import {
  DoorHttpError,
  fetchModels,
  postChatCompletion,
  postForm,
  postJson,
  postJsonWithHeaders,
} from './doorClient.ts'
import type { NeighbourCandidate } from './neighbourContext.ts'
import { selectSnippets } from './neighbourContext.ts'
import { PathEscapeError, resolveWorkspacePath } from './pathGuard.ts'
import { ModelPoller } from './polling.ts'
import type { PlainMessage, PlainMessagePart } from './requestBuilder.ts'
import {
  buildChatRequestBody,
  estimateMessageTokenCount,
  estimateTokenCount,
} from './requestBuilder.ts'
import { SearchIndex } from './searchIndex.ts'
import type { CallRecord } from './status.ts'
import {
  buildTooltip,
  formatCallLine,
  formatLoadingText,
  hasExceededLoadingThreshold,
  isLocalEgress,
  resolveRoute,
  unreachableTooltip,
} from './status.ts'
import {
  buildImageRequest,
  buildReadImageRequest,
  buildSpeakRequest,
  buildTranscribeRequest,
  confirmationMessage,
  ToolRouteError,
} from './toolRequests.ts'

const LOADING_TICK_MS = 300
const RECENT_DOCUMENTS_CAP = 10
/** Every setting a saved defaultModel reason was logged for, so a repeated request logs it once per change rather than once per call. */
const loggedUnusableReasons = new Map<ModelRole, string>()

let output: vscode.OutputChannel
let poller: ModelPoller
let searchIndex: SearchIndex
let statusBarItem: vscode.StatusBarItem
let pollTimer: ReturnType<typeof setInterval> | undefined
let doorReachable = true
let lastChatCall: CallRecord | undefined
let lastCompletionCall: CallRecord | undefined
let inFlightChat: { modelId: string; startedAt: number; firstTokenAt?: number } | undefined
let loadingTimer: ReturnType<typeof setInterval> | undefined
/** Most-recently-active documents this session, most recent first; excludes whichever is currently active. */
const recentDocuments: vscode.TextDocument[] = []

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
    const startedAt = Date.now()
    inFlightChat = { modelId: model.id, startedAt }
    startLoadingTimer()
    renderStatusBar()
    let stream: ReadableStream<Uint8Array>
    let headers: Headers
    try {
      const res = await postChatCompletion(getUrl(), body, controller.signal)
      stream = res.body
      headers = res.headers
    } catch (error) {
      log(`chat completion failed for ${model.id}: ${describeError(error)}`)
      stopLoadingTimer()
      renderStatusBar()
      throw asError(error)
    }
    let usage: { promptTokens?: number; completionTokens?: number } | undefined
    let toolCalls: Awaited<ReturnType<typeof readChatStream>>
    try {
      toolCalls = await readChatStream(stream, {
        text: (delta) => {
          if (inFlightChat?.firstTokenAt === undefined && inFlightChat !== undefined) {
            inFlightChat.firstTokenAt = Date.now()
          }
          progress.report(new vscode.LanguageModelTextPart(delta))
        },
        usage: (u) => (usage = u),
      })
    } finally {
      stopLoadingTimer()
    }
    const resolved = resolveRoute(
      {
        route: headers.get('x-engined-route') ?? undefined,
        egress: headers.get('x-engined-egress') ?? undefined,
        chain: headers.get('x-engined-chain') ?? undefined,
      },
      { id: model.id, egress: model.row.egress },
    )
    lastChatCall = {
      route: resolved.route,
      egress: resolved.egress,
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      wallMs: Date.now() - startedAt,
    }
    renderStatusBar()
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

// --- default-model selection (engined.defaultModels.*) ---------------------

/** Logs an unusable configured id once per change, never once per call. */
function logUnusableIfChanged(role: ModelRole, reason: string | undefined): void {
  if (reason === undefined) {
    loggedUnusableReasons.delete(role)
    return
  }
  if (loggedUnusableReasons.get(role) === reason) {
    return
  }
  loggedUnusableReasons.set(role, reason)
  log(`engined.defaultModels.${role}: ${reason}`)
}

/** The role's resolved row, or throws `ToolRouteError` naming the role when nothing qualifies at all. */
function resolveRoleRow(role: ModelRole, path?: string): EnginedModelRow {
  const resolved: DefaultModelResolution = resolveDefaultModel(
    poller.rows,
    role,
    getDefaultModel(role),
    path,
  )
  logUnusableIfChanged(role, resolved.unusableReason)
  if (resolved.row === undefined) {
    throw new ToolRouteError(
      `no installed engined route serves ${role} (${path ?? ROLE_PATH[role]})`,
    )
  }
  return resolved.row
}

// --- inline completions (ghost text) ---------------------------------------

const COMPLETIONS_DEBOUNCE_MS = 250

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

class EnginedInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (!getCompletionsEnabled()) {
      return undefined
    }
    if (vscode.window.activeTextEditor?.selection.isEmpty === false) {
      return undefined
    }
    const completionModel = resolveDefaultModel(
      poller.rows,
      'completion',
      getDefaultModel('completion'),
    )
    logUnusableIfChanged('completion', completionModel.unusableReason)
    const model = completionModel.row
    if (model === undefined) {
      return undefined
    }
    const controller = new AbortController()
    token.onCancellationRequested(() => controller.abort())
    await delay(COMPLETIONS_DEBOUNCE_MS, controller.signal)
    if (token.isCancellationRequested) {
      return undefined
    }
    const { prefix, suffix } = sliceContext(document.getText(), document.offsetAt(position))
    const extra =
      getNeighbourContextEnabled() && isLocalEgress(model.egress)
        ? selectSnippets(
            gatherNeighbourCandidates(document),
            vscode.workspace.asRelativePath(document.uri, false),
            excludeGlobs(),
          )
        : undefined
    const body = buildCompletionsRequestBody(model.id, prefix, suffix, extra)
    const startedAt = Date.now()
    let reply: unknown
    let headers: Headers
    try {
      const res = await postJsonWithHeaders(getUrl(), COMPLETIONS_PATH, body, controller.signal)
      reply = res.data
      headers = res.headers
    } catch (error) {
      if (!token.isCancellationRequested) {
        log(`completion failed for ${model.id}: ${describeError(error)}`)
      }
      return undefined
    }
    const resolved = resolveRoute(
      {
        route: headers.get('x-engined-route') ?? undefined,
        egress: headers.get('x-engined-egress') ?? undefined,
        chain: headers.get('x-engined-chain') ?? undefined,
      },
      { id: model.id, egress: model.egress },
    )
    const usage = extractCompletionUsage(reply)
    lastCompletionCall = {
      route: resolved.route,
      egress: resolved.egress,
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      wallMs: Date.now() - startedAt,
    }
    renderStatusBar()
    const text = extractCompletionText(reply)
    return text === undefined ? undefined : [new vscode.InlineCompletionItem(text)]
  }
}

// --- neighbouring-file context for completions -----------------------------

/** `files.exclude`/`search.exclude` keys whose value is `true` -- the same globs VS Code itself hides. */
function excludeGlobs(): string[] {
  const files = vscode.workspace
    .getConfiguration('files')
    .get<Record<string, boolean>>('exclude', {})
  const search = vscode.workspace
    .getConfiguration('search')
    .get<Record<string, boolean>>('exclude', {})
  return Object.entries({ ...files, ...search })
    .filter(([, enabled]) => enabled)
    .map(([glob]) => glob)
}

/** Visible editors first (with a live cursor), then recently active documents this session, current document excluded by the caller (`selectSnippets`). */
function gatherNeighbourCandidates(current: vscode.TextDocument): NeighbourCandidate[] {
  const candidates: NeighbourCandidate[] = []
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document === current) {
      continue
    }
    candidates.push({
      filename: vscode.workspace.asRelativePath(editor.document.uri, false),
      scheme: editor.document.uri.scheme,
      text: editor.document.getText(),
      cursorOffset: editor.document.offsetAt(editor.selection.active),
    })
  }
  for (const doc of recentDocuments) {
    if (doc === current || doc.isClosed) {
      continue
    }
    candidates.push({
      filename: vscode.workspace.asRelativePath(doc.uri, false),
      scheme: doc.uri.scheme,
      text: doc.getText(),
    })
  }
  return candidates
}

function trackActiveEditor(editor: vscode.TextEditor | undefined): void {
  if (editor === undefined) {
    return
  }
  const doc = editor.document
  const existing = recentDocuments.indexOf(doc)
  if (existing !== -1) {
    recentDocuments.splice(existing, 1)
  }
  recentDocuments.unshift(doc)
  if (recentDocuments.length > RECENT_DOCUMENTS_CAP) {
    recentDocuments.length = RECENT_DOCUMENTS_CAP
  }
}

// --- polling and status bar ------------------------------------------------

function isRowWarming(modelId: string): boolean {
  return poller.models.find((m) => m.id === modelId)?.row.state === 'warming'
}

function renderStatusBar(): void {
  if (!doorReachable) {
    statusBarItem.text = '$(warning) engined unreachable'
    statusBarItem.tooltip = unreachableTooltip(getUrl())
    return
  }
  if (
    inFlightChat !== undefined &&
    inFlightChat.firstTokenAt === undefined &&
    (hasExceededLoadingThreshold(inFlightChat.startedAt, Date.now()) ||
      isRowWarming(inFlightChat.modelId))
  ) {
    statusBarItem.text = formatLoadingText(inFlightChat.modelId)
  } else if (lastChatCall !== undefined) {
    statusBarItem.text = formatCallLine(lastChatCall)
  } else {
    statusBarItem.text = `$(server) engined (${poller.models.length})`
  }
  statusBarItem.tooltip = buildTooltip({
    lastChat: lastChatCall,
    lastCompletion: lastCompletionCall,
    doorUrl: getUrl(),
    modelCount: poller.models.length,
  })
}

function startLoadingTimer(): void {
  if (loadingTimer !== undefined) {
    clearInterval(loadingTimer)
  }
  loadingTimer = setInterval(renderStatusBar, LOADING_TICK_MS)
}

function stopLoadingTimer(): void {
  if (loadingTimer !== undefined) {
    clearInterval(loadingTimer)
    loadingTimer = undefined
  }
  inFlightChat = undefined
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
      { label: 'Choose default models', action: 'default-models' as const },
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
  } else if (pick.action === 'default-models') {
    await chooseDefaultModels()
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

const DEFAULT_MODEL_ROLES: { role: ModelRole; label: string; path?: string }[] = [
  { role: 'image', label: 'Image generation/edit' },
  { role: 'ocr', label: 'OCR (vision: read)' },
  { role: 'vision', label: 'Describe image (vision: describe)' },
  { role: 'completion', label: 'Inline completions' },
  { role: 'speech', label: 'Text-to-speech' },
  { role: 'transcription', label: 'Audio transcription' },
]

/** `engined.chooseDefaultModels`: pick a role, then a qualifying row (or Automatic), and write `engined.defaultModels.<role>` at user scope. */
async function chooseDefaultModels(): Promise<void> {
  const rolePick = await vscode.window.showQuickPick(
    DEFAULT_MODEL_ROLES.map((r) => ({ label: r.label, role: r.role })),
    { title: 'engined: Choose default models -- role' },
  )
  if (rolePick === undefined) {
    return
  }
  const qualifying = qualifyingRows(poller.rows, rolePick.role)
  const items = [
    { label: 'Automatic', description: '', id: '' },
    ...qualifying.map((row) => ({
      label: row.display_name ?? row.id,
      description: `${row.id} · ${row.egress ?? 'unknown'} egress`,
      id: row.id,
    })),
  ]
  const modelPick = await vscode.window.showQuickPick(items, {
    title: `engined: Choose default models -- ${rolePick.label}`,
  })
  if (modelPick === undefined) {
    return
  }
  await setDefaultModel(rolePick.role, modelPick.id)
  loggedUnusableReasons.delete(rolePick.role)
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

function imagePath(sourcePath: string | undefined): string {
  return sourcePath !== undefined ? '/openai/v1/images/edits' : '/openai/v1/images/generations'
}

const generateImageTool: vscode.LanguageModelTool<GenerateImageInput> = {
  async invoke(options) {
    try {
      const source =
        options.input.sourcePath !== undefined
          ? new Blob([await readWorkspaceFile(options.input.sourcePath)])
          : undefined
      const row = resolveRoleRow('image', imagePath(options.input.sourcePath))
      const req = buildImageRequest(row, {
        prompt: options.input.prompt,
        size: options.input.size,
        source,
      })
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
      const bytes = Buffer.from(png, 'base64')
      await writeWorkspaceFile(options.input.outputPath, bytes)
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Wrote ${options.input.outputPath}`),
        vscode.LanguageModelDataPart.image(bytes, 'image/png'),
      ])
    } catch (error) {
      return toolError(error)
    }
  },
  prepareInvocation(options) {
    const row = resolveRoleRow('image', imagePath(options.input.sourcePath))
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
      const row = resolveRoleRow(options.input.mode === 'ocr' ? 'ocr' : 'vision')
      const req = buildReadImageRequest(row, {
        mode: options.input.mode,
        question: options.input.question,
        mimeType: mimeTypeFor(options.input.path),
        base64: Buffer.from(bytes).toString('base64'),
      })
      const { body: stream } = await postChatCompletion(
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
    const row = resolveRoleRow(options.input.mode === 'ocr' ? 'ocr' : 'vision')
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
      const row = resolveRoleRow('transcription', transcriptionPath(options.input.translate))
      const req = buildTranscribeRequest(row, {
        audio: new Blob([bytes]),
        translate: options.input.translate,
      })
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
    const row = resolveRoleRow('transcription', transcriptionPath(options.input.translate))
    return {
      confirmationMessages: {
        title: 'Transcribe audio',
        message: confirmationMessage(row, 'Transcribe audio'),
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
  async invoke(options) {
    try {
      const row = resolveRoleRow('speech')
      const req = buildSpeakRequest(row, {
        text: options.input.text,
        voice: options.input.voice,
      })
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
    const row = resolveRoleRow('speech')
    return {
      confirmationMessages: {
        title: 'Speak text',
        message: confirmationMessage(row, 'Speak text'),
      },
    }
  },
}

interface SearchInput {
  query: string
  maxResults?: number
}

const DEFAULT_SEARCH_MAX_RESULTS = 8

const searchTool: vscode.LanguageModelTool<SearchInput> = {
  async invoke(options) {
    try {
      const hits = await searchIndex.search(
        options.input.query,
        options.input.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS,
      )
      if (hits.length === 0) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('No matching results.'),
        ])
      }
      const text = hits
        .map((h) => `${h.path}:${h.startLine}-${h.endLine}\n${h.text}`)
        .join('\n\n---\n\n')
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)])
    } catch (error) {
      return toolError(error)
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
    () => {
      doorReachable = poller.reachable
      renderStatusBar()
      chatProvider.fire()
    },
  )

  restartPollTimer()
  if (vscode.window.activeTextEditor !== undefined) {
    trackActiveEditor(vscode.window.activeTextEditor)
  }

  searchIndex = new SearchIndex(
    context.storageUri ?? context.globalStorageUri,
    () => poller.rows,
    log,
  )
  const watcher = vscode.workspace.createFileSystemWatcher('**/*')

  context.subscriptions.push(
    output,
    statusBarItem,
    vscode.lm.registerLanguageModelChatProvider('engined', chatProvider),
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      new EnginedInlineCompletionProvider(),
    ),
    vscode.window.onDidChangeActiveTextEditor(trackActiveEditor),
    vscode.lm.registerTool('engined_generateImage', generateImageTool),
    vscode.lm.registerTool('engined_readImage', readImageTool),
    vscode.lm.registerTool('engined_transcribe', transcribeTool),
    vscode.lm.registerTool('engined_speak', speakTool),
    vscode.lm.registerTool('engined_search', searchTool),
    watcher,
    watcher.onDidChange((uri) => void searchIndex.onFileChanged(uri, 'change')),
    watcher.onDidCreate((uri) => void searchIndex.onFileChanged(uri, 'create')),
    watcher.onDidDelete((uri) => void searchIndex.onFileChanged(uri, 'delete')),
    vscode.commands.registerCommand('engined.refreshModels', async () => {
      await poller.pollNow()
      chatProvider.fire()
    }),
    vscode.commands.registerCommand('engined.showQuickPick', () => showQuickPick(chatProvider)),
    vscode.commands.registerCommand('engined.chooseDefaultModels', () => chooseDefaultModels()),
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
  stopLoadingTimer()
}
