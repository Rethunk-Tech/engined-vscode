/**
 * The thin adapter: register the chat provider, the tools, the status bar
 * and log, and convert between real `vscode` values and the plain shapes
 * `door.ts`/`requestBuilder.ts`/`chatStream.ts`/`toolRequests.ts` operate on.
 * Everything decision-shaped lives in those files; this file only wires.
 */

import * as vscode from 'vscode'
import type { SavedSetting, SettingWrite } from './chatSettingsPlan.ts'
import { buildChatSettingsPlan, buildRestorePlan, describePlan } from './chatSettingsPlan.ts'
import { readChatStream } from './chatStream.ts'
import {
  buildCompletionsRequestBody,
  COMPLETIONS_DOCUMENT_SELECTOR_SCHEMES,
  COMPLETIONS_PATH,
  extractCompletionText,
  extractCompletionUsage,
  sliceContext,
} from './completions.ts'
import {
  getCompletionsEnabled,
  getDefaultModel,
  getDoors,
  getNeighbourContextEnabled,
  getPollSeconds,
  getReasoningEffort,
  getReasoningEffortByModel,
  setDefaultModel,
  setReasoningEffort,
} from './config.ts'
import type { DefaultModelResolution, ModelRole } from './defaultModels.ts'
import { qualifyingRows, ROLE_PATH, resolveDefaultModel } from './defaultModels.ts'
import type { Door, EnginedModelInfo, EnginedModelRow, ReasoningLevel } from './door.ts'
import {
  doorByName,
  qualifiedEngineIds,
  REASONING_LEVELS,
  servesTokenize,
  splitQualifiedId,
} from './door.ts'
import {
  DoorHttpError,
  fetchAllDoors,
  holdEngine,
  openEngineEventsStream,
  postChatCompletion,
  postForm,
  postJson,
  postJsonWithHeaders,
  postTokenize,
  startModel,
  unholdEngine,
} from './doorClient.ts'
import { backoffMs, parseSseChunk } from './engineEvents.ts'
import type { EngineTreeItem } from './engineExplorer.ts'
import { copyFixCommand, EngineExplorer } from './engineExplorer.ts'
import type { NeighbourCandidate } from './neighbourContext.ts'
import { selectSnippets } from './neighbourContext.ts'
import { PathEscapeError, resolveWorkspacePath } from './pathGuard.ts'
import { ModelPoller } from './polling.ts'
import type { PlainMessage, PlainMessagePart } from './requestBuilder.ts'
import {
  buildChatRequestBody,
  estimateMessageTokenCount,
  plainMessageContent,
} from './requestBuilder.ts'
import { truncateSnippet } from './search.ts'
import { SearchIndex } from './searchIndex.ts'
import type { CallRecord } from './status.ts'
import {
  buildTooltip,
  formatCallLine,
  formatWaitingText,
  hasExceededLoadingThreshold,
  isLocalEgress,
  resolveRoute,
  TOOLTIP_COMMANDS,
} from './status.ts'
import { resolveTokenCount, TokenCountCache } from './tokenCount.ts'
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

let extensionContext: vscode.ExtensionContext
let output: vscode.OutputChannel
let poller: ModelPoller
let searchIndex: SearchIndex
let engineExplorer: EngineExplorer
let statusBarItem: vscode.StatusBarItem
let pollTimer: ReturnType<typeof setInterval> | undefined
let doorReachable = true
/** Shown once per session, on the first failed poll -- never repeated even if the door stays down. */
let unreachableNoticeShown = false
const tokenCountCache = new TokenCountCache()
let lastChatCall: CallRecord | undefined
/** The last tool-less chat request -- Copilot's own title/summary calls, never the status-bar source. */
let lastBackgroundCall: CallRecord | undefined
let lastCompletionCall: CallRecord | undefined
let inFlightChat:
  | { modelId: string; startedAt: number; promptTokenEstimate: number; firstTokenAt?: number }
  | undefined
let loadingTimer: ReturnType<typeof setInterval> | undefined
/** Most-recently-active documents this session, most recent first; excludes whichever is currently active. */
const recentDocuments: vscode.TextDocument[] = []

/** Engine ids this session has itself put on hold -- `GET /engined/v1/engines` reports no held-until field, so a hold placed elsewhere is invisible here. */
const heldEngineIds = new Set<string>()
/** One events connection per door, keyed by door name -- each reconnects independently. */
interface DoorSseState {
  abort?: AbortController
  attempt: number
  connected: boolean
  reconnectTimer?: ReturnType<typeof setTimeout>
}
const sseStates = new Map<string, DoorSseState>()
function doorSseState(door: Door): DoorSseState {
  let state = sseStates.get(door.name)
  if (state === undefined) {
    state = { attempt: 0, connected: false }
    sseStates.set(door.name, state)
  }
  return state
}
function anySseConnected(): boolean {
  return [...sseStates.values()].some((s) => s.connected)
}
let sseRefreshTimer: ReturnType<typeof setTimeout> | undefined
/** Poll interval floor while the events stream is up -- it is the fallback, not the primary signal, once frames are actually arriving. */
const CONNECTED_POLL_FLOOR_SECONDS = 300
const SSE_REFRESH_DEBOUNCE_MS = 500

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
    const hadTools = (options.tools?.length ?? 0) > 0
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
    const promptTokenEstimate = plainMessages.reduce(
      (sum, m) => sum + estimateMessageTokenCount(m),
      0,
    )
    const flight = { modelId: model.id, startedAt, promptTokenEstimate }
    inFlightChat = flight
    startLoadingTimer()
    renderStatusBar()
    if (servesTokenize(model.row)) {
      const content = plainMessages.map(plainMessageContent).join('')
      void resolveTokenCount(
        tokenCountCache,
        () => postTokenize(model.row.door.url, model.row.routeId, content, controller.signal),
        model.id,
        content,
        true,
      ).then((tokens) => {
        if (inFlightChat === flight) {
          flight.promptTokenEstimate = tokens
          renderStatusBar()
        }
      })
    }
    let stream: ReadableStream<Uint8Array>
    let headers: Headers
    try {
      const res = await postChatCompletion(model.row.door.url, body, controller.signal)
      stream = res.body
      headers = res.headers
    } catch (error) {
      log(`chat completion failed for ${model.id}: ${describeError(error)}`)
      stopLoadingTimer()
      renderStatusBar()
      throw asError(error)
    }
    let usage: { promptTokens?: number; completionTokens?: number; costUsd?: number } | undefined
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
    const record: CallRecord = {
      route: resolved.route,
      egress: resolved.egress,
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      wallMs: Date.now() - startedAt,
      costUsd: usage?.costUsd ?? costUsdHeader(headers),
    }
    if (hadTools) {
      lastChatCall = record
    } else {
      lastBackgroundCall = record
    }
    renderStatusBar()
    for (const call of toolCalls) {
      progress.report(
        new vscode.LanguageModelToolCallPart(call.id, call.name, call.arguments ?? {}),
      )
    }
  }

  async provideTokenCount(
    model: EnginedModelInfo,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Promise<number> {
    const content = typeof text === 'string' ? text : plainMessageContent(toPlainMessage(text))
    const controller = new AbortController()
    token.onCancellationRequested(() => controller.abort())
    return resolveTokenCount(
      tokenCountCache,
      (_m, c) => postTokenize(model.row.door.url, model.row.routeId, c, controller.signal),
      model.id,
      content,
      servesTokenize(model.row),
    )
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

/** `x-engined-cost-usd`, parsed -- absent or unparseable means no cost was reported, not zero. */
function costUsdHeader(headers: Headers): number | undefined {
  const raw = headers.get('x-engined-cost-usd')
  if (raw === null) {
    return undefined
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
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
    const body = buildCompletionsRequestBody(model.routeId, prefix, suffix, extra)
    const startedAt = Date.now()
    let reply: unknown
    let headers: Headers
    try {
      const res = await postJsonWithHeaders(
        model.door.url,
        COMPLETIONS_PATH,
        body,
        controller.signal,
      )
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
      costUsd: costUsdHeader(headers),
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

function rowState(modelId: string): string | undefined {
  return poller.models.find((m) => m.id === modelId)?.row.state
}

/** Scrolls the shipped README to its Troubleshooting section -- no network round trip needed for a local doc. */
async function revealReadmeTroubleshooting(): Promise<void> {
  const uri = vscode.Uri.joinPath(extensionContext.extensionUri, 'README.md')
  const doc = await vscode.workspace.openTextDocument(uri)
  const editor = await vscode.window.showTextDocument(doc)
  const line = doc
    .getText()
    .split('\n')
    .findIndex((l) => l.startsWith('## Troubleshooting'))
  if (line !== -1) {
    const pos = new vscode.Position(line, 0)
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop)
  }
}

/** The first poll after activation failing gets one notice; every later failure (door still down, or down again) stays silent. */
function maybeShowUnreachableNotice(): void {
  if (unreachableNoticeShown) {
    return
  }
  unreachableNoticeShown = true
  const urls = getDoors()
    .map((d) => d.url)
    .join(', ')
  void vscode.window
    .showInformationMessage(`engined isn't reachable at ${urls}`, 'How to start it', 'Settings')
    .then((choice) => {
      if (choice === 'How to start it') {
        void revealReadmeTroubleshooting()
      } else if (choice === 'Settings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'engined.doors')
      }
    })
}

function tooltipMarkdown(): vscode.MarkdownString {
  const md = new vscode.MarkdownString(
    buildTooltip({
      // Before the first poll resolves, `doorStatus` is empty -- assume every configured door
      // reachable, matching the sync default `renderStatusBar` shows at activation.
      doors: (poller.doorStatus.length > 0
        ? poller.doorStatus.map((d) => ({ door: d.door, reachable: d.reachable }))
        : getDoors().map((door) => ({ door, reachable: true }))
      ).map((d) => ({
        name: d.door.name,
        url: d.door.url,
        reachable: d.reachable,
      })),
      lastChat: lastChatCall,
      lastBackground: lastBackgroundCall,
      lastCompletion: lastCompletionCall,
      modelCount: poller.models.length,
      defaults: DEFAULT_MODEL_TOOLTIP_ROLES.map((r) => {
        const configuredId = getDefaultModel(r.role)
        const resolved = resolveDefaultModel(poller.rows, r.role, configuredId)
        return {
          label: r.label,
          resolvedName:
            resolved.row === undefined ? undefined : (resolved.row.display_name ?? resolved.row.id),
          configured: configuredId !== '',
          unusableConfigured: resolved.unusableReason === undefined ? undefined : configuredId,
        }
      }),
      heldEngines: [...heldEngineIds],
      chatSettingsRouted: savedChatSettings() !== undefined,
    }),
  )
  md.supportThemeIcons = true
  md.isTrusted = { enabledCommands: Object.values(TOOLTIP_COMMANDS) }
  return md
}

function renderStatusBar(): void {
  if (!doorReachable) {
    statusBarItem.text = '$(warning) engined unreachable'
    statusBarItem.tooltip = tooltipMarkdown()
    return
  }
  if (
    inFlightChat !== undefined &&
    inFlightChat.firstTokenAt === undefined &&
    (hasExceededLoadingThreshold(inFlightChat.startedAt, Date.now()) ||
      rowState(inFlightChat.modelId) !== 'running')
  ) {
    statusBarItem.text = formatWaitingText(
      rowState(inFlightChat.modelId),
      inFlightChat.modelId,
      inFlightChat.promptTokenEstimate,
    )
  } else if (lastChatCall !== undefined) {
    statusBarItem.text = formatCallLine(lastChatCall)
  } else {
    statusBarItem.text = `$(server) engined (${poller.models.length})`
  }
  statusBarItem.tooltip = tooltipMarkdown()
}

const SAVED_CHAT_SETTINGS_KEY = 'engined.savedChatSettings'
const CHAT_SETTINGS_ROUTED_CONTEXT = 'engined.chatSettingsRouted'

function savedChatSettings(): SavedSetting[] | undefined {
  return extensionContext.globalState.get<SavedSetting[]>(SAVED_CHAT_SETTINGS_KEY)
}

async function writeUserSettings(writes: readonly SettingWrite[]): Promise<void> {
  const config = vscode.workspace.getConfiguration()
  for (const w of writes) {
    await config.update(w.key, w.value, vscode.ConfigurationTarget.Global)
  }
}

async function useForAllChatFeatures(): Promise<void> {
  if (savedChatSettings() !== undefined) {
    void vscode.window.showInformationMessage(
      'Chat features already route to engined. Run "engined: Restore Previous Chat Settings" first to switch models.',
    )
    return
  }
  const candidates = [...poller.models].sort(
    (a, b) =>
      Number(b.row.egress === 'local' && b.row.tools) -
      Number(a.row.egress === 'local' && a.row.tools),
  )
  const pick = await vscode.window.showQuickPick(
    candidates.map((m) => ({
      label: m.name,
      description: `${m.id} · ${m.row.egress ?? ''}`,
      model: m,
    })),
    { title: 'Route every chat default to which engined model?' },
  )
  if (pick === undefined) {
    return
  }
  const config = vscode.workspace.getConfiguration()
  // A key whose extension isn't installed (e.g. Copilot's) is unregistered and can't be written.
  const plan = buildChatSettingsPlan(pick.model).filter((w) => config.inspect(w.key) !== undefined)
  const confirmed = await vscode.window.showWarningMessage(
    'Write these user settings? Your current values are saved and "engined: Restore Previous Chat Settings" puts them back.',
    { modal: true, detail: describePlan(plan) },
    'Write settings',
  )
  if (confirmed !== 'Write settings') {
    return
  }
  const saved = plan.map((w) => ({ key: w.key, previous: config.inspect(w.key)?.globalValue }))
  await extensionContext.globalState.update(SAVED_CHAT_SETTINGS_KEY, saved)
  await writeUserSettings(plan)
  await vscode.commands.executeCommand('setContext', CHAT_SETTINGS_ROUTED_CONTEXT, true)
  log(`routed ${plan.length} chat settings to ${pick.model.id}`)
  renderStatusBar()
}

async function restoreChatSettings(): Promise<void> {
  const saved = savedChatSettings()
  if (saved === undefined) {
    return
  }
  await writeUserSettings(buildRestorePlan(saved))
  await extensionContext.globalState.update(SAVED_CHAT_SETTINGS_KEY, undefined)
  await vscode.commands.executeCommand('setContext', CHAT_SETTINGS_ROUTED_CONTEXT, false)
  log(`restored ${saved.length} chat settings`)
  renderStatusBar()
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

/** Effective poll period: the configured one, floored to 5 minutes while the events stream is delivering frames -- polling is then only the fallback. */
function effectivePollMs(): number {
  const seconds = getPollSeconds()
  if (seconds <= 0) {
    return 0
  }
  return (anySseConnected() ? Math.max(seconds, CONNECTED_POLL_FLOOR_SECONDS) : seconds) * 1000
}

function restartPollTimer(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
  const ms = effectivePollMs()
  if (ms > 0) {
    pollTimer = setInterval(() => void poller.pollNow(), ms)
  }
  void poller.pollNow()
}

/** Re-polls at most every `SSE_REFRESH_DEBOUNCE_MS` -- a burst of events (several engines changing at once) triggers one refetch, not one per frame. */
function scheduleSseRefresh(): void {
  if (sseRefreshTimer !== undefined) {
    clearTimeout(sseRefreshTimer)
  }
  sseRefreshTimer = setTimeout(() => {
    sseRefreshTimer = undefined
    void poller.pollNow()
    void engineExplorer.refresh()
  }, SSE_REFRESH_DEBOUNCE_MS)
}

function scheduleSseReconnect(door: Door): void {
  const state = doorSseState(door)
  if (state.reconnectTimer !== undefined) {
    return
  }
  const delay = backoffMs(state.attempt)
  state.attempt += 1
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = undefined
    void connectEngineEvents(door)
  }, delay)
}

/** Opens `GET /engined/v1/engines/events` against one door and stays connected until it errors or the extension deactivates, reconnecting with backoff either way. */
async function connectEngineEvents(door: Door): Promise<void> {
  const state = doorSseState(door)
  const controller = new AbortController()
  state.abort = controller
  let stream: ReadableStream<Uint8Array>
  try {
    stream = await openEngineEventsStream(door.url, controller.signal)
  } catch (error) {
    if (!controller.signal.aborted) {
      log(`engine events stream (${door.name}): ${describeError(error)}`)
      scheduleSseReconnect(door)
    }
    return
  }
  state.connected = true
  state.attempt = 0
  restartPollTimer()
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseSseChunk(buffer)
      buffer = parsed.rest
      if (parsed.frames.length > 0) {
        scheduleSseRefresh()
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      log(`engine events stream error (${door.name}): ${describeError(error)}`)
    }
  }
  state.connected = false
  restartPollTimer()
  if (!controller.signal.aborted) {
    scheduleSseReconnect(door)
  }
}

/** Connects the events stream for every configured door. */
async function connectAllEngineEvents(): Promise<void> {
  await Promise.all(getDoors().map((door) => connectEngineEvents(door)))
}

function stopEngineEvents(): void {
  for (const state of sseStates.values()) {
    state.abort?.abort()
    state.abort = undefined
    state.connected = false
    if (state.reconnectTimer !== undefined) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = undefined
    }
  }
  if (sseRefreshTimer !== undefined) {
    clearTimeout(sseRefreshTimer)
    sseRefreshTimer = undefined
  }
}

/** `engined: Warm Model`: pick any answerable row and `POST /engined/v1/start` it against the door that owns it. */
async function warmModel(): Promise<void> {
  const multiDoor = getDoors().length > 1
  const pick = await vscode.window.showQuickPick(
    poller.rows.map((row) => ({
      label: row.display_name ?? row.id,
      description: multiDoor ? `${row.id} · ${row.door.name}` : row.id,
      row,
    })),
    { title: 'engined: Warm model' },
  )
  if (pick === undefined) {
    return
  }
  try {
    const rows = await startModel(pick.row.door.url, pick.row.routeId)
    log(
      `warmed ${pick.row.id}: ${rows.map((r) => `${r.address}=${r.state}`).join(', ') || 'no routes'}`,
    )
  } catch (error) {
    const message = `warm ${pick.row.id} failed: ${describeError(error)}`
    log(message)
    void vscode.window.showErrorMessage(`engined: ${message}`)
  }
  await poller.pollNow()
}

/** `engined: Hold Model`: stop an engine and keep it stopped so another process can load the same weights. */
async function holdModel(): Promise<void> {
  const engines = qualifiedEngineIds(poller.rows, getDoors().length)
  const id = await vscode.window.showQuickPick(
    engines.map((e) => e.id),
    {
      title: 'engined: Hold engine',
    },
  )
  const engine = engines.find((e) => e.id === id)
  if (engine === undefined) {
    return
  }
  try {
    await holdEngine(engine.door.url, engine.rawId)
    heldEngineIds.add(engine.id)
    renderStatusBar()
  } catch (error) {
    void vscode.window.showErrorMessage(`engined: hold "${id}" failed: ${describeError(error)}`)
  }
  await poller.pollNow()
}

/** `engined: Release Hold`: only offers engines this session itself held. */
async function releaseHold(): Promise<void> {
  if (heldEngineIds.size === 0) {
    void vscode.window.showInformationMessage('engined: no engines are held')
    return
  }
  const id = await vscode.window.showQuickPick([...heldEngineIds].sort(), {
    title: 'engined: Release hold',
  })
  if (id === undefined) {
    return
  }
  const doors = getDoors()
  const { doorName, rawId } = splitQualifiedId(id, doors.length)
  const door = doorByName(doors, doorName)
  try {
    await unholdEngine(door.url, rawId)
    heldEngineIds.delete(id)
    renderStatusBar()
  } catch (error) {
    void vscode.window.showErrorMessage(
      `engined: release hold "${id}" failed: ${describeError(error)}`,
    )
  }
  await poller.pollNow()
}

async function showQuickPick(chatProvider: EnginedChatProvider): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Refresh models', action: 'refresh' as const },
      { label: 'Warm model', action: 'warm' as const },
      { label: 'Hold engine', action: 'hold' as const },
      { label: 'Release hold', action: 'unhold' as const },
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
  } else if (pick.action === 'warm') {
    await warmModel()
  } else if (pick.action === 'hold') {
    await holdModel()
  } else if (pick.action === 'unhold') {
    await releaseHold()
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

/** One compact tooltip line per role, in `engined.defaultModels.*`'s own order (`package.json` configuration). */
const DEFAULT_MODEL_TOOLTIP_ROLES: { role: ModelRole; label: string }[] = [
  { role: 'image', label: 'Image' },
  { role: 'ocr', label: 'OCR' },
  { role: 'vision', label: 'Vision' },
  { role: 'completion', label: 'Completion' },
  { role: 'speech', label: 'Speech' },
  { role: 'transcription', label: 'Transcription' },
  { role: 'embedding', label: 'Embedding' },
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

async function writeWorkspaceFile(path: string, data: Uint8Array): Promise<vscode.Uri> {
  const uri = vscode.Uri.file(resolveWorkspacePath(workspaceRoots(), path))
  await vscode.workspace.fs.writeFile(uri, data)
  return uri
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
          ? ((await postJson(row.door.url, req.path, req.body)) as { data: { b64_json: string }[] })
          : ((await postForm(row.door.url, req.path, buildEditForm(req.form))) as {
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
        row.door.url,
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
      const result = (await postForm(row.door.url, req.path, form)) as
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
      const audio = (await postJson(row.door.url, req.path, req.body)) as ArrayBuffer
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

const DEFAULT_SEARCH_MAX_RESULTS = 6

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
        .map((h) => `${h.path}:${h.startLine}-${h.endLine}\n${truncateSnippet(h.text)}`)
        .join('\n\n---\n\n')
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)])
    } catch (error) {
      return toolError(error)
    }
  },
}

// --- activation ---------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context
  void vscode.commands.executeCommand(
    'setContext',
    CHAT_SETTINGS_ROUTED_CONTEXT,
    savedChatSettings() !== undefined,
  )
  output = vscode.window.createOutputChannel('engined')
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBarItem.command = 'engined.showQuickPick'
  statusBarItem.show()

  const chatProvider = new EnginedChatProvider()
  poller = new ModelPoller(
    () =>
      fetchAllDoors(getDoors()).then((poll) => {
        if (poll.doorStatus.length > 0 && poll.doorStatus.every((d) => !d.reachable)) {
          log('poll failed: no configured door is reachable')
          maybeShowUnreachableNotice()
        }
        return poll
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

  engineExplorer = new EngineExplorer(heldEngineIds, log, getDoors, () => poller.rows)
  void engineExplorer.refresh()

  context.subscriptions.push(
    output,
    statusBarItem,
    engineExplorer,
    vscode.window.registerTreeDataProvider('engined.engines', engineExplorer),
    vscode.lm.registerLanguageModelChatProvider('engined', chatProvider),
    vscode.languages.registerInlineCompletionItemProvider(
      COMPLETIONS_DOCUMENT_SELECTOR_SCHEMES.map((scheme) => ({ scheme, pattern: '**' })),
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
    vscode.commands.registerCommand('engined.warmModel', () => warmModel()),
    vscode.commands.registerCommand('engined.useForAllChatFeatures', () => useForAllChatFeatures()),
    vscode.commands.registerCommand('engined.restoreChatSettings', () => restoreChatSettings()),
    vscode.commands.registerCommand('engined.showLog', () => output.show()),
    vscode.commands.registerCommand('engined.holdModel', () => holdModel()),
    vscode.commands.registerCommand('engined.releaseHold', () => releaseHold()),
    vscode.commands.registerCommand('engined.refreshEngines', () => engineExplorer.refresh()),
    vscode.commands.registerCommand('engined.showEngineLogs', (item: EngineTreeItem) => {
      if (item.kind === 'engine') {
        return engineExplorer.showLogs(item.node)
      }
      return undefined
    }),
    vscode.commands.registerCommand('engined.stopEngine', (item: EngineTreeItem) => {
      if (item.kind === 'engine') {
        return engineExplorer.stop(item.node)
      }
      return undefined
    }),
    vscode.commands.registerCommand('engined.warmEngine', async (item: EngineTreeItem) => {
      if (item.kind !== 'engine') {
        return
      }
      const row = poller.rows.find(
        (r) => r.engine === item.node.rawId && r.door.name === item.node.door.name,
      )
      if (row === undefined) {
        void vscode.window.showErrorMessage(
          `engined: no known model route for engine "${item.node.id}"`,
        )
        return
      }
      try {
        await startModel(row.door.url, row.routeId)
      } catch (error) {
        void vscode.window.showErrorMessage(
          `engined: warm "${row.id}" failed: ${describeError(error)}`,
        )
      }
      await poller.pollNow()
      await engineExplorer.refresh()
    }),
    vscode.commands.registerCommand('engined.holdEngine', async (item: EngineTreeItem) => {
      if (item.kind !== 'engine') {
        return
      }
      try {
        await holdEngine(item.node.door.url, item.node.rawId)
        heldEngineIds.add(item.node.id)
        renderStatusBar()
      } catch (error) {
        void vscode.window.showErrorMessage(
          `engined: hold "${item.node.id}" failed: ${describeError(error)}`,
        )
      }
      await engineExplorer.refresh()
    }),
    vscode.commands.registerCommand('engined.releaseHoldEngine', async (item: EngineTreeItem) => {
      if (item.kind !== 'engine') {
        return
      }
      try {
        await unholdEngine(item.node.door.url, item.node.rawId)
        heldEngineIds.delete(item.node.id)
        renderStatusBar()
      } catch (error) {
        void vscode.window.showErrorMessage(
          `engined: release hold "${item.node.id}" failed: ${describeError(error)}`,
        )
      }
      await engineExplorer.refresh()
    }),
    vscode.commands.registerCommand('engined.copyFixCommand', (item: EngineTreeItem) => {
      if (item.kind === 'engine') {
        return copyFixCommand(item.node.fix)
      }
      return undefined
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('engined.pollSeconds')) {
        restartPollTimer()
      }
      if (e.affectsConfiguration('engined.doors')) {
        stopEngineEvents()
        restartPollTimer()
        void connectAllEngineEvents()
      }
      if (e.affectsConfiguration('engined.defaultModels')) {
        renderStatusBar()
      }
    }),
    new vscode.Disposable(() => {
      if (pollTimer !== undefined) {
        clearInterval(pollTimer)
      }
      stopEngineEvents()
    }),
  )
  void connectAllEngineEvents()
}

export function deactivate(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
  stopEngineEvents()
  stopLoadingTimer()
}
