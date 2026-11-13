/**
 * Reads for `engined.*` settings, isolated from `vscode.workspace` so the
 * defaults and shapes are one place -- `extension.ts` is the only caller.
 */

import * as vscode from 'vscode'
import {
  DEFAULT_MODEL_ROLES,
  type DefaultModelInspect,
  defaultModelFromInspect,
  type ModelRole,
  pendingWorkspaceDefault,
} from './defaultModels.ts'
import type { Door, EnginedModelRow, ReasoningLevel } from './door.ts'
import { doorsFromInspect, REASONING_LEVELS } from './door.ts'
import type { SplitOptions } from './promptSplit.ts'
import { DEFAULT_SPLIT } from './promptSplit.ts'
import { allowRemoteFromInspect } from './search.ts'

const DEFAULT_DOORS: Door[] = [{ name: 'local', url: 'http://127.0.0.1:29200' }]
const DEFAULT_POLL_SECONDS = 30
const DEFAULT_REASONING_EFFORT: ReasoningLevel = 'medium'

/** JSON of the workspace `engined.doors` value the user confirmed; an edited list needs asking again. */
let confirmedWorkspaceDoors: string | undefined
let workspaceAllowRemoteConfirmed = false
/** Per role, the workspace `engined.defaultModels.*` value the user confirmed, and the last one asked about (so a poll does not re-ask a declined value). */
const confirmedWorkspaceDefaults = new Map<ModelRole, string>()
const askedWorkspaceDefaults = new Map<ModelRole, string>()

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
  if (workspace !== undefined && JSON.stringify(workspace) === confirmedWorkspaceDoors) {
    return true
  }
  confirmedWorkspaceDoors = undefined
  if (workspace === undefined) {
    return false
  }
  const pick = await vscode.window.showWarningMessage(
    'This workspace sets engined.doors. Using it lets this folder choose which server chat, completions, and search talk to.',
    { modal: true },
    'Use workspace doors',
  )
  if (pick !== 'Use workspace doors') {
    return false
  }
  confirmedWorkspaceDoors = JSON.stringify(workspace)
  return true
}

/** Same gate as `confirmWorkspaceDoors`, for a workspace or folder `engined.search.allowRemote: true`. */
export async function confirmWorkspaceAllowRemote(): Promise<boolean> {
  const inspected = config().inspect<boolean>('search.allowRemote')
  const workspace = inspected?.workspaceValue ?? inspected?.workspaceFolderValue
  if (workspace !== true) {
    workspaceAllowRemoteConfirmed = false
    return false
  }
  const pick = await vscode.window.showWarningMessage(
    'This workspace sets engined.search.allowRemote. Using it lets this folder send its file contents to a non-local embedding or rerank route.',
    { modal: true },
    'Allow remote search',
  )
  workspaceAllowRemoteConfirmed = pick === 'Allow remote search'
  return workspaceAllowRemoteConfirmed
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
    confirmedWorkspaceDoors,
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
  const inspected = config().inspect<boolean>('search.allowRemote')
  return allowRemoteFromInspect(
    {
      globalValue: inspected?.globalValue,
      workspaceValue: inspected?.workspaceValue,
      workspaceFolderValue: inspected?.workspaceFolderValue,
    },
    workspaceAllowRemoteConfirmed,
  )
}

export function getSearchMaxChunks(): number {
  return config().get<number>('search.maxChunks', DEFAULT_SEARCH_MAX_CHUNKS)
}

function inspectDefaultModel(role: ModelRole): DefaultModelInspect {
  const inspected = config().inspect<string>(`defaultModels.${role}`)
  return {
    globalValue: inspected?.globalValue,
    workspaceValue: inspected?.workspaceValue,
    workspaceFolderValue: inspected?.workspaceFolderValue,
  }
}

/** Empty string means "automatic" -- see `defaultModels.ts` `resolveDefaultModel`. A workspace value that picks an off-machine route needs `confirmWorkspaceDefaultModels`. */
export function getDefaultModel(role: ModelRole, rows: readonly EnginedModelRow[]): string {
  return defaultModelFromInspect(
    role,
    inspectDefaultModel(role),
    confirmedWorkspaceDefaults.get(role),
    rows,
  )
}

/** Same gate as `confirmWorkspaceDoors`, per role, for a workspace `engined.defaultModels.*` that resolves to a non-local route. */
export async function confirmWorkspaceDefaultModels(
  rows: readonly EnginedModelRow[],
): Promise<void> {
  for (const { role } of DEFAULT_MODEL_ROLES) {
    const pending = pendingWorkspaceDefault(
      role,
      inspectDefaultModel(role),
      confirmedWorkspaceDefaults.get(role),
      rows,
    )
    if (pending === undefined || askedWorkspaceDefaults.get(role) === pending) {
      continue
    }
    askedWorkspaceDefaults.set(role, pending)
    const pick = await vscode.window.showWarningMessage(
      `This workspace sets engined.defaultModels.${role} to "${pending}", a route that leaves this machine. Using it sends this folder's ${role} requests off the machine.`,
      { modal: true },
      'Use workspace route',
    )
    if (pick === 'Use workspace route') {
      confirmedWorkspaceDefaults.set(role, pending)
    }
  }
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
