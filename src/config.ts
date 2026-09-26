/**
 * Reads for `engined.*` settings, isolated from `vscode.workspace` so the
 * defaults and shapes are one place -- `extension.ts` is the only caller.
 */

import * as vscode from 'vscode'
import type { ModelRole } from './defaultModels.ts'
import type { ReasoningLevel } from './door.ts'
import { REASONING_LEVELS } from './door.ts'

export const DEFAULT_URL = 'http://127.0.0.1:29200'
export const DEFAULT_POLL_SECONDS = 30
export const DEFAULT_REASONING_EFFORT: ReasoningLevel = 'medium'

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('engined')
}

export function getUrl(): string {
  return config().get<string>('url', DEFAULT_URL)
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
