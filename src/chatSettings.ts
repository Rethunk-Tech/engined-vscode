/** `engined.useForAllChatFeatures` / `engined.restoreChatSettings`: route every chat default to an engined model and put the previous values back. */

import * as vscode from 'vscode'
import type { SettingWrite } from './chatSettingsPlan.ts'
import {
  buildChatSettingsPlan,
  buildRestorePlan,
  describePlan,
  readSavedSettings,
  SAVED_CHAT_SETTINGS_KEY,
} from './chatSettingsPlan.ts'
import { CHAT_SETTINGS_ROUTED_CONTEXT } from './constants.ts'
import type { Session } from './session.ts'
import { renderStatusBar } from './statusBar.ts'

/** Publishes whether chat is routed to engined, so the restore command's `when` clause can see it. */
export async function syncChatSettingsContext(s: Session): Promise<void> {
  await vscode.commands.executeCommand(
    'setContext',
    CHAT_SETTINGS_ROUTED_CONTEXT,
    readSavedSettings(s.context.globalState) !== undefined,
  )
}

async function writeUserSettings(writes: readonly SettingWrite[]): Promise<void> {
  const config = vscode.workspace.getConfiguration()
  for (const w of writes) {
    await config.update(w.key, w.value, vscode.ConfigurationTarget.Global)
  }
}

export async function useForAllChatFeatures(s: Session): Promise<void> {
  if (readSavedSettings(s.context.globalState) !== undefined) {
    vscode.window.showInformationMessage(
      'Chat features already route to engined. Run "engined: Restore Previous Chat Settings" first to switch models.',
    )
    return
  }
  const candidates = [...s.poller.models].sort(
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
  await s.context.globalState.update(SAVED_CHAT_SETTINGS_KEY, saved)
  await writeUserSettings(plan)
  await vscode.commands.executeCommand('setContext', CHAT_SETTINGS_ROUTED_CONTEXT, true)
  s.log(`routed ${plan.length} chat settings to ${pick.model.id}`)
  renderStatusBar(s)
}

export async function restoreChatSettings(s: Session): Promise<void> {
  const saved = readSavedSettings(s.context.globalState)
  if (saved === undefined) {
    return
  }
  await writeUserSettings(buildRestorePlan(saved))
  await s.context.globalState.update(SAVED_CHAT_SETTINGS_KEY, undefined)
  await vscode.commands.executeCommand('setContext', CHAT_SETTINGS_ROUTED_CONTEXT, false)
  s.log(`restored ${saved.length} chat settings`)
  renderStatusBar(s)
}
