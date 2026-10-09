/**
 * The activation module's shared state, built once in `activate` and passed
 * to every module that needs it (the same role `ToolHost` and `SearchHost`
 * play for the tools and the search index).
 */

import type * as vscode from 'vscode'
import type { ModelRole } from './defaultModels.ts'
import type { EngineExplorer } from './engineExplorer.ts'
import type { ModelPoller } from './polling.ts'
import type { FingerprintInput } from './promptFingerprint.ts'
import type { SearchIndex } from './searchIndex.ts'
import type { CallRecord, TodayUsage } from './status.ts'
import type { TokenCountCache } from './tokenCount.ts'

/** One events connection per door, keyed by door name -- each reconnects independently. */
export interface DoorSseState {
  abort?: AbortController
  attempt: number
  connected: boolean
  reconnectTimer?: ReturnType<typeof setTimeout>
}

export interface InFlightChat {
  modelId: string
  startedAt: number
  promptTokenEstimate: number
  firstTokenAt?: number
}

export interface Session {
  readonly context: vscode.ExtensionContext
  readonly output: vscode.OutputChannel
  readonly statusBarItem: vscode.StatusBarItem
  readonly poller: ModelPoller
  readonly engineExplorer: EngineExplorer
  readonly searchIndex: SearchIndex
  /** Fired when the model list the chat provider offers has changed. */
  readonly modelsChanged: vscode.EventEmitter<void>
  readonly log: (line: string) => void
  /** Starts `work` without awaiting it; a failure lands in the output channel instead of an unhandled rejection. */
  readonly background: (work: PromiseLike<unknown>) => void
  readonly tokenCountCache: TokenCountCache
  /** Every setting a saved defaultModel reason was logged for, so a repeated request logs it once per change rather than once per call. */
  readonly loggedUnusableReasons: Map<ModelRole, string>
  /** Engine ids this session has itself put on hold -- `GET /engined/v1/engines` reports no held-until field, so a hold placed elsewhere is invisible here. */
  readonly heldEngineIds: Set<string>
  readonly sseStates: Map<string, DoorSseState>
  /** Most-recently-active documents this session, most recent first; excludes whichever is currently active. */
  readonly recentDocuments: vscode.TextDocument[]
  /** The last tool-carrying chat request, in memory only, to locate where the next one diverges. */
  lastChatPrint: FingerprintInput | undefined
  lastChatCall: CallRecord | undefined
  /** The last tool-less chat request -- Copilot's own title/summary calls, never the status-bar source. */
  lastBackgroundCall: CallRecord | undefined
  lastCompletionCall: CallRecord | undefined
  inFlightChat: InFlightChat | undefined
  loadingTimer: ReturnType<typeof setInterval> | undefined
  todayUsageCache: TodayUsage | undefined
  todayUsageFetchedAt: number
  todayUsageFetchInFlight: boolean
  pollTimer: ReturnType<typeof setInterval> | undefined
  sseRefreshTimer: ReturnType<typeof setTimeout> | undefined
  doorReachable: boolean
  /** Shown once per session, on the first failed poll -- never repeated even if the door stays down. */
  unreachableNoticeShown: boolean
}
