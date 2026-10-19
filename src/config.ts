/**
 * Reads for `engined.*` settings, isolated from `vscode.workspace` so the
 * defaults and shapes are one place -- `extension.ts` is the only caller.
 */

import * as vscode from 'vscode'
import type { ModelRole } from './defaultModels.ts'
import type { Door, ReasoningLevel } from './door.ts'
import { doorsFromInspect, REASONING_LEVELS } from './door.ts'
import type { SplitOptions } from './promptSplit.ts'
import { DEFAULT_SPLIT } from './promptSplit.ts'

const DEFAULT_DOORS: Door[] = [{ name: 'local', url: 'http://127.0.0.1:29200' }]
const DEFAULT_POLL_SECONDS = 30
const DEFAULT_REASONING_EFFORT: ReasoningLevel = 'medium'

let workspaceDoorsConfirmed = false

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('engined')
}

/**
 * When the workspace (or a folder) sets `engined.doors`, ask before those
 * URLs are used — `.vscode/settings.json` can otherwise point every request
 * at an attacker after the folder is trusted.
 */
export async function confirmWorkspaceDoors(): Promise<boolean> {
  const inspected = config().inspect<Door[]>('doors')
  const workspace = inspected?.workspaceValue ?? inspected?.workspaceFolderValue
  if (workspace === undefined) {
    workspaceDoorsConfirmed = false
    return false
  }
  const pick = await vscode.window.showWarningMessage(
    'This workspace sets engined.doors. Using it lets this folder choose which server chat, completions, and search talk to.',
    { modal: true },
    'Use workspace doors',
  )
  workspaceDoorsConfirmed = pick === 'Use workspace doors'
  return workspaceDoorsConfirmed
}

/** `engined.doors`, or the single local default when unset/empty. Workspace/folder values need `confirmWorkspaceDoors`. */
export function getDoors(): Door[] {
  const inspected = config().inspect<Door[]>('doors')
  return doorsFromInspect(
    {
      globalValue: inspected?.globalValue,
      workspaceValue: inspected?.workspaceValue,
      workspaceFolderValue: inspected?.workspaceFolderValue,
      defaultValue: inspected?.defaultValue,
    },
    workspaceDoorsConfirmed,
    DEFAULT_DOORS,
  )
}

export function getPollSeconds(): number {
  return config().get<number>('pollSeconds', DEFAULT_POLL_SECONDS)
}

export function getReasoningEffort(): ReasoningLevel {
  const value = config().get<string>('reasoningEffort', DEFAULT_REASONING_EFFORT)
  return REASONING_LEVELS.includes(value as ReasoningLevel)
    ? (value as ReasoningLevel)
    : DEFAULT_REASONING_EFFORT
}

export function getReasoningEffortByModel(): Record<string, ReasoningLevel> {
  const raw = config().get<Record<string, string>>('reasoningEffortByModel', {})
  const out: Record<string, ReasoningLevel> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (REASONING_LEVELS.includes(value as ReasoningLevel)) {
      out[id] = value as ReasoningLevel
    }
  }
  return out
}

export function getCompletionsEnabled(): boolean {
  return config().get<boolean>('completions.enabled', true)
}

export function getNeighbourContextEnabled(): boolean {
  return config().get<boolean>('completions.neighbourContext', true)
}

/** Pause ghost-text requests while the completion model is queued behind another job. On by default. */
export function getCompletionsPauseOnContention(): boolean {
  return config().get<boolean>('completions.pauseOnContention', true)
}

/** VS Code language ids that skip inline completions. Empty by default. */
export function getCompletionsDisabledLanguages(): string[] {
  return config().get<string[]>('completions.disabledLanguages', [])
}

/** Offer ghost text inside comments. On by default; false skips the request when the cursor is in a comment. */
export function getCompletionsInComments(): boolean {
  return config().get<boolean>('completions.inComments', true)
}

const DEFAULT_SEARCH_MAX_CHUNKS = 20_000

/** Whether `engined_search` may embed/rerank through a non-local route. Off by default -- workspace content otherwise never leaves the machine. */
export function getSearchAllowRemote(): boolean {
  return config().get<boolean>('search.allowRemote', false)
}

export function getSearchMaxChunks(): number {
  return config().get<number>('search.maxChunks', DEFAULT_SEARCH_MAX_CHUNKS)
}

/** Empty string means "automatic" -- see `defaultModels.ts` `resolveDefaultModel`. */
export function getDefaultModel(role: ModelRole): string {
  return config().get<string>(`defaultModels.${role}`, '')
}

export async function setDefaultModel(role: ModelRole, modelId: string): Promise<void> {
  await config().update(`defaultModels.${role}`, modelId, vscode.ConfigurationTarget.Global)
}

export async function setReasoningEffort(level: ReasoningLevel, modelId?: string): Promise<void> {
  if (modelId === undefined) {
    await config().update('reasoningEffort', level, vscode.ConfigurationTarget.Global)
    return
  }
  const byModel = getReasoningEffortByModel()
  byModel[modelId] = level
  await config().update('reasoningEffortByModel', byModel, vscode.ConfigurationTarget.Global)
}

export function getSplitOptions(): SplitOptions {
  return {
    chunkChars: Math.max(0, config().get<number>('chat.splitChunkChars', DEFAULT_SPLIT.chunkChars)),
    splitAboveChars: Math.max(
      0,
      config().get<number>('chat.splitAboveChars', DEFAULT_SPLIT.splitAboveChars),
    ),
  }
}
