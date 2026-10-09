/**
 * The activation module: builds the shared `Session`, registers the chat
 * provider, tools, status bar, commands and views, and tears them down.
 * Everything else lives in the modules it wires together.
 */

import * as vscode from 'vscode'
import { runInBackground } from './background.ts'
import { EnginedChatProvider } from './chatProvider.ts'
import {
  restoreChatSettings,
  syncChatSettingsContext,
  useForAllChatFeatures,
} from './chatSettings.ts'
import {
  chooseDefaultModels,
  holdModel,
  registerEngineTreeCommands,
  releaseHold,
  showQuickPick,
  showUsageReport,
  warmModel,
} from './commands.ts'
import { EnginedInlineCompletionProvider, trackActiveEditor } from './completionProvider.ts'
import { COMPLETIONS_DOCUMENT_SELECTOR_SCHEMES } from './completions.ts'
import { getDoors } from './config.ts'
import { describeError } from './describeError.ts'
import { fetchAllDoors } from './doorClient.ts'
import { EngineExplorer } from './engineExplorer.ts'
import { connectAllEngineEvents, restartPollTimer, stopEngineEvents } from './pollDriver.ts'
import { ModelPoller } from './polling.ts'
import { resolveRoleRow } from './routes.ts'
import { vscodeSearchHost } from './searchHost.ts'
import { SearchIndex } from './searchIndex.ts'
import type { Session } from './session.ts'
import { maybeShowUnreachableNotice, renderStatusBar, stopLoadingTimer } from './statusBar.ts'
import { TokenCountCache } from './tokenCount.ts'
import { registerTools } from './workspaceTools.ts'

/** Right-aligned status bar items sort by priority; 100 sits among the language-status items. */
const STATUS_BAR_PRIORITY = 100

/** A door that has not answered a model listing in this long counts as unreachable for that poll. */
const POLL_TIMEOUT_MS = 5000

let session: Session | undefined

function createSession(context: vscode.ExtensionContext): Session {
  const output = vscode.window.createOutputChannel('engined')
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    STATUS_BAR_PRIORITY,
  )
  statusBarItem.command = 'engined.showQuickPick'
  statusBarItem.show()

  const log = (line: string): void => output.appendLine(`[${new Date().toISOString()}] ${line}`)
  const background = (work: PromiseLike<unknown>): void =>
    runInBackground(work, (error) => log(`background task failed: ${describeError(error)}`))
  const modelsChanged = new vscode.EventEmitter<void>()
  const heldEngineIds = new Set<string>()

  const poller = new ModelPoller(
    () =>
      fetchAllDoors(getDoors(), AbortSignal.timeout(POLL_TIMEOUT_MS)).then((poll) => {
        if (poll.doorStatus.length > 0 && poll.doorStatus.every((d) => !d.reachable)) {
          log('poll failed: no configured door is reachable')
          maybeShowUnreachableNotice(created)
        }
        return poll
      }),
    () => {
      created.doorReachable = poller.reachable
      renderStatusBar(created)
      modelsChanged.fire()
    },
  )
  const created: Session = {
    context,
    output,
    statusBarItem,
    poller,
    engineExplorer: new EngineExplorer(heldEngineIds, log, getDoors, () => poller.rows),
    searchIndex: new SearchIndex(
      context.storageUri ?? context.globalStorageUri,
      () => poller.rows,
      log,
      vscodeSearchHost,
    ),
    modelsChanged,
    log,
    background,
    tokenCountCache: new TokenCountCache(),
    loggedUnusableReasons: new Map(),
    heldEngineIds,
    sseStates: new Map(),
    recentDocuments: [],
    lastChatPrint: undefined,
    lastChatCall: undefined,
    lastBackgroundCall: undefined,
    lastCompletionCall: undefined,
    inFlightChat: undefined,
    loadingTimer: undefined,
    todayUsageCache: undefined,
    todayUsageFetchedAt: 0,
    todayUsageFetchInFlight: false,
    pollTimer: undefined,
    sseRefreshTimer: undefined,
    doorReachable: true,
    unreachableNoticeShown: false,
  }
  return created
}

function clearPollTimer(s: Session): void {
  if (s.pollTimer !== undefined) {
    clearInterval(s.pollTimer)
    s.pollTimer = undefined
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const s = createSession(context)
  session = s
  s.background(syncChatSettingsContext(s))
  restartPollTimer(s)
  if (vscode.window.activeTextEditor !== undefined) {
    trackActiveEditor(s, vscode.window.activeTextEditor)
  }
  s.background(s.engineExplorer.refresh())

  const watcher = vscode.workspace.createFileSystemWatcher('**/*')
  context.subscriptions.push(
    s.output,
    s.statusBarItem,
    s.engineExplorer,
    s.modelsChanged,
    vscode.window.onDidChangeActiveColorTheme(() => renderStatusBar(s)),
    vscode.window.registerTreeDataProvider('engined.engines', s.engineExplorer),
    vscode.lm.registerLanguageModelChatProvider('engined', new EnginedChatProvider(s)),
    vscode.languages.registerInlineCompletionItemProvider(
      COMPLETIONS_DOCUMENT_SELECTOR_SCHEMES.map((scheme) => ({ scheme, pattern: '**' })),
      new EnginedInlineCompletionProvider(s),
    ),
    vscode.window.onDidChangeActiveTextEditor((editor) => trackActiveEditor(s, editor)),
    ...registerTools({
      log: s.log,
      resolveRoleRow: (role, path) => resolveRoleRow(s, role, path),
      searchIndex: () => s.searchIndex,
    }),
    watcher,
    watcher.onDidChange((uri) => s.searchIndex.onFileChanged(uri, 'change')),
    watcher.onDidCreate((uri) => s.searchIndex.onFileChanged(uri, 'create')),
    watcher.onDidDelete((uri) => s.searchIndex.onFileChanged(uri, 'delete')),
    vscode.commands.registerCommand('engined.refreshModels', async () => {
      await s.poller.pollNow()
      s.modelsChanged.fire()
    }),
    vscode.commands.registerCommand('engined.showQuickPick', () => showQuickPick(s)),
    vscode.commands.registerCommand('engined.chooseDefaultModels', () => chooseDefaultModels(s)),
    vscode.commands.registerCommand('engined.showUsageReport', () => showUsageReport()),
    vscode.commands.registerCommand('engined.warmModel', () => warmModel(s)),
    vscode.commands.registerCommand('engined.useForAllChatFeatures', () =>
      useForAllChatFeatures(s),
    ),
    vscode.commands.registerCommand('engined.restoreChatSettings', () => restoreChatSettings(s)),
    vscode.commands.registerCommand('engined.showLog', () => s.output.show()),
    vscode.commands.registerCommand('engined.holdModel', () => holdModel(s)),
    vscode.commands.registerCommand('engined.releaseHold', () => releaseHold(s)),
    vscode.commands.registerCommand('engined.refreshEngines', () => s.engineExplorer.refresh()),
    ...registerEngineTreeCommands(s),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('engined.pollSeconds')) {
        restartPollTimer(s)
      }
      if (e.affectsConfiguration('engined.doors')) {
        stopEngineEvents(s)
        restartPollTimer(s)
        s.background(connectAllEngineEvents(s))
      }
      if (e.affectsConfiguration('engined.defaultModels')) {
        renderStatusBar(s)
      }
    }),
    new vscode.Disposable(() => {
      clearPollTimer(s)
      stopEngineEvents(s)
    }),
  )
  s.background(connectAllEngineEvents(s))
}

export function deactivate(): void {
  if (session === undefined) {
    return
  }
  clearPollTimer(session)
  stopEngineEvents(session)
  stopLoadingTimer(session)
}
