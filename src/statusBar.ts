/** The status bar item: its text, tooltip, today's-usage cache, the loading ticker and the one-time unreachable notice. */

import * as vscode from 'vscode'
import { readSavedSettings } from './chatSettingsPlan.ts'
import { getDefaultModel, getDoors } from './config.ts'
import { LOADING_TICK_MS } from './constants.ts'
import { DEFAULT_MODEL_ROLES, resolveDefaultModel } from './defaultModels.ts'
import { describeError } from './describeError.ts'
import { fetchAllUsage } from './doorClient.ts'
import type { Session } from './session.ts'
import type { ThemeKind } from './status.ts'
import {
  buildTooltip,
  formatCallLine,
  formatWaitingText,
  hasExceededLoadingThreshold,
  TOOLTIP_COMMANDS,
} from './status.ts'
import { totalsFor } from './usageReport.ts'

const TODAY_USAGE_REFRESH_MS = 60_000

// --- polling and status bar ------------------------------------------------

function rowState(s: Session, modelId: string): string | undefined {
  return s.poller.models.find((m) => m.id === modelId)?.row.state
}

/** Scrolls the shipped README to its Troubleshooting section -- no network round trip needed for a local doc. */
async function revealReadmeTroubleshooting(s: Session): Promise<void> {
  const uri = vscode.Uri.joinPath(s.context.extensionUri, 'README.md')
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
export function maybeShowUnreachableNotice(s: Session): void {
  if (s.unreachableNoticeShown) {
    return
  }
  s.unreachableNoticeShown = true
  const urls = getDoors()
    .map((d) => d.url)
    .join(', ')
  vscode.window
    .showInformationMessage(`engined isn't reachable at ${urls}`, 'How to start it', 'Settings')
    .then((choice) => {
      if (choice === 'How to start it') {
        s.background(revealReadmeTroubleshooting(s))
      } else if (choice === 'Settings') {
        s.background(
          vscode.commands.executeCommand('workbench.action.openSettings', 'engined.doors'),
        )
      }
    })
}

/** `vscode.ColorThemeKind` collapsed to the two palettes the SVG meters ship (a static `data:` image can't read `var(--vscode-...)`); high-contrast reads fine off its nearer light/dark base. */
function themeKindFor(kind: vscode.ColorThemeKind): ThemeKind {
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
    ? 'light'
    : 'dark'
}

/** `GET /engined/v1/usage?days=1`, cached and refreshed at most every `TODAY_USAGE_REFRESH_MS` -- never awaited by a render, so a slow/unreachable door never blocks the tooltip. */
function refreshTodayUsageIfStale(s: Session): void {
  if (s.todayUsageFetchInFlight || Date.now() - s.todayUsageFetchedAt < TODAY_USAGE_REFRESH_MS) {
    return
  }
  s.todayUsageFetchInFlight = true
  fetchAllUsage(getDoors(), 1)
    .then((usages) => {
      const rows = usages.filter((u) => u.status === 'ok').flatMap((u) => u.rows)
      const t = totalsFor(rows)
      s.todayUsageCache = {
        requests: t.requests,
        promptTokens: t.promptTokens,
        completionTokens: t.completionTokens,
        costUsd: t.costUsd,
      }
      s.todayUsageFetchedAt = Date.now()
      renderStatusBar(s)
    })
    .catch((error: unknown) => s.log(`today usage: ${describeError(error)}`))
    .finally(() => {
      s.todayUsageFetchInFlight = false
    })
}

function tooltipMarkdown(s: Session): vscode.MarkdownString {
  const md = new vscode.MarkdownString(
    buildTooltip({
      themeKind: themeKindFor(vscode.window.activeColorTheme.kind),
      todayUsage: s.todayUsageCache,
      // Before the first poll resolves, `doorStatus` is empty -- assume every configured door
      // reachable, matching the sync default `renderStatusBar` shows at activation.
      doors: (s.poller.doorStatus.length > 0
        ? s.poller.doorStatus.map((d) => ({ door: d.door, reachable: d.reachable }))
        : getDoors().map((door) => ({ door, reachable: true }))
      ).map((d) => ({
        name: d.door.name,
        url: d.door.url,
        reachable: d.reachable,
      })),
      lastChat: s.lastChatCall,
      lastBackground: s.lastBackgroundCall,
      lastCompletion: s.lastCompletionCall,
      modelCount: s.poller.models.length,
      defaults: DEFAULT_MODEL_ROLES.map((r) => {
        const configuredId = getDefaultModel(r.role)
        const resolved = resolveDefaultModel(s.poller.rows, r.role, configuredId)
        return {
          label: r.popupLabel,
          resolvedName:
            resolved.row === undefined ? undefined : (resolved.row.display_name ?? resolved.row.id),
          configured: configuredId !== '',
          unusableConfigured: resolved.unusableReason === undefined ? undefined : configuredId,
        }
      }),
      heldEngines: [...s.heldEngineIds],
      chatSettingsRouted: readSavedSettings(s.context.globalState) !== undefined,
    }),
  )
  md.supportThemeIcons = true
  md.supportHtml = true
  md.isTrusted = { enabledCommands: Object.values(TOOLTIP_COMMANDS) }
  return md
}

export function renderStatusBar(s: Session): void {
  refreshTodayUsageIfStale(s)
  if (!s.doorReachable) {
    s.statusBarItem.text = '$(warning) engined unreachable'
    s.statusBarItem.tooltip = tooltipMarkdown(s)
    return
  }
  if (
    s.inFlightChat !== undefined &&
    s.inFlightChat.firstTokenAt === undefined &&
    (hasExceededLoadingThreshold(s.inFlightChat.startedAt, Date.now()) ||
      rowState(s, s.inFlightChat.modelId) !== 'running')
  ) {
    s.statusBarItem.text = formatWaitingText(
      rowState(s, s.inFlightChat.modelId),
      s.inFlightChat.modelId,
      s.inFlightChat.promptTokenEstimate,
    )
  } else if (s.lastChatCall === undefined) {
    s.statusBarItem.text = `$(server) engined (${s.poller.models.length})`
  } else {
    s.statusBarItem.text = formatCallLine(s.lastChatCall)
  }
  s.statusBarItem.tooltip = tooltipMarkdown(s)
}
export function startLoadingTimer(s: Session): void {
  if (s.loadingTimer !== undefined) {
    clearInterval(s.loadingTimer)
  }
  s.loadingTimer = setInterval(() => renderStatusBar(s), LOADING_TICK_MS)
}

export function stopLoadingTimer(s: Session): void {
  if (s.loadingTimer !== undefined) {
    clearInterval(s.loadingTimer)
    s.loadingTimer = undefined
  }
  s.inFlightChat = undefined
}
