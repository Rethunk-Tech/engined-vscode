/** The command-palette and Engines-view commands: warm, hold, release, effort, default models, usage report, and selection token count. */

import * as vscode from 'vscode'
import { getDoors, setDefaultModel, setReasoningEffort } from './config.ts'
import { ENABLE_CONFIGSVC_COMMAND, resolveConfigUi, runEnginedConfigsvcUrl } from './configUi.ts'
import { DOOR_TIMEOUT_MS, STATUS_QUICK_PICK } from './constants.ts'
import { DEFAULT_MODEL_ROLES, qualifyingRows } from './defaultModels.ts'
import { describeError } from './describeError.ts'
import type { ReasoningLevel } from './door.ts'
import { doorByName, qualifiedEngineIds, REASONING_LEVELS, splitQualifiedId } from './door.ts'
import { fetchAllUsage, holdEngine, postTokenize, startModel, unholdEngine } from './doorClient.ts'
import type { EngineTreeItem } from './engineExplorer.ts'
import { copyFixCommand } from './engineExplorer.ts'
import { emptyListedMessage, releaseHoldIds } from './engineTree.ts'
import type { Session } from './session.ts'
import { renderStatusBar } from './statusBar.ts'
import { buildUsageReport } from './usageReport.ts'

/** `engined: Warm Model`: pick any answerable row and `POST /engined/v1/start` it against the door that owns it. */
export async function warmModel(s: Session): Promise<void> {
  const empty = emptyListedMessage('models', s.poller.rows.length)
  if (empty !== undefined) {
    vscode.window.showInformationMessage(empty)
    return
  }
  const multiDoor = getDoors().length > 1
  const pick = await vscode.window.showQuickPick(
    s.poller.rows.map((row) => ({
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
    s.log(
      `warmed ${pick.row.id}: ${rows.map((r) => `${r.address}=${r.state}`).join(', ') || 'no routes'}`,
    )
  } catch (error) {
    const message = `warm ${pick.row.id} failed: ${describeError(error)}`
    s.log(message)
    vscode.window.showErrorMessage(`engined: ${message}`)
  }
  await s.poller.pollNow()
}

/** `engined: Hold Model`: stop an engine and keep it stopped so another process can load the same weights. */
export async function holdModel(s: Session): Promise<void> {
  const engines = qualifiedEngineIds(s.poller.rows, getDoors().length)
  const empty = emptyListedMessage('engines', engines.length)
  if (empty !== undefined) {
    vscode.window.showInformationMessage(empty)
    return
  }
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
    s.heldEngineIds.add(engine.id)
    renderStatusBar(s)
  } catch (error) {
    vscode.window.showErrorMessage(`engined: hold "${id}" failed: ${describeError(error)}`)
  }
  await s.poller.pollNow()
}

/** `engined: Release Hold`: this session's holds, plus every engines-list row still reporting a future `held_until`. */
export async function releaseHold(s: Session): Promise<void> {
  const ids = releaseHoldIds(s.heldEngineIds, s.engineExplorer.listedHoldIds())
  if (ids.length === 0) {
    vscode.window.showInformationMessage('engined: no engines are held')
    return
  }
  const id = await vscode.window.showQuickPick(ids, {
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
    s.heldEngineIds.delete(id)
    renderStatusBar(s)
    await s.engineExplorer.refresh()
  } catch (error) {
    vscode.window.showErrorMessage(`engined: release hold "${id}" failed: ${describeError(error)}`)
  }
  await s.poller.pollNow()
}

export async function showQuickPick(s: Session): Promise<void> {
  const pick = await vscode.window.showQuickPick([...STATUS_QUICK_PICK], { title: 'engined' })
  if (pick === undefined) {
    return
  }
  if (pick.action === 'refresh') {
    await s.poller.pollNow()
    s.modelsChanged.fire()
  } else if (pick.action === 'warm') {
    await warmModel(s)
  } else if (pick.action === 'hold') {
    await holdModel(s)
  } else if (pick.action === 'unhold') {
    await releaseHold(s)
  } else if (pick.action === 'log') {
    s.output.show()
  } else if (pick.action === 'effort-global') {
    await pickAndSetEffort()
  } else if (pick.action === 'default-models') {
    await chooseDefaultModels(s)
  } else if (pick.action === 'usage') {
    await showUsageReport()
  } else {
    const model = await vscode.window.showQuickPick(
      s.poller.models.map((m) => m.name),
      { title: 'Model' },
    )
    const id = s.poller.models.find((m) => m.name === model)?.id
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

/** `engined.chooseDefaultModels`: pick a role, then a qualifying row (or Automatic), and write `engined.defaultModels.<role>` at user scope. */
export async function chooseDefaultModels(s: Session): Promise<void> {
  const rolePick = await vscode.window.showQuickPick(
    DEFAULT_MODEL_ROLES.map((r) => ({ label: r.chooserLabel, role: r.role })),
    { title: 'engined: Choose default models -- role' },
  )
  if (rolePick === undefined) {
    return
  }
  const qualifying = qualifyingRows(s.poller.rows, rolePick.role)
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
  s.loggedUnusableReasons.delete(rolePick.role)
}

const DAY_CHOICE_WEEK = 7
const DAY_CHOICE_MONTH = 30
const USAGE_REPORT_DAY_CHOICES = [1, DAY_CHOICE_WEEK, DAY_CHOICE_MONTH] as const

/** `engined: Usage Report`: pick a day range, fetch `/engined/v1/usage` from every configured door, and show the result as a read-only Markdown preview. */
export async function showUsageReport(): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    USAGE_REPORT_DAY_CHOICES.map((days) => ({
      label: `${days} day${days === 1 ? '' : 's'}`,
      days,
    })),
    { title: 'engined: Usage report' },
  )
  if (pick === undefined) {
    return
  }
  const usages = await fetchAllUsage(getDoors(), pick.days)
  const report = buildUsageReport(usages, pick.days)
  usageReport = report
  usageReportChanged.fire(USAGE_REPORT_URI)
  await vscode.commands.executeCommand('markdown.showPreview', USAGE_REPORT_URI)
}

const USAGE_REPORT_SCHEME = 'engined-usage'
const USAGE_REPORT_URI = vscode.Uri.from({ scheme: USAGE_REPORT_SCHEME, path: '/Usage report.md' })
const usageReportChanged = new vscode.EventEmitter<vscode.Uri>()
let usageReport = ''

/** Serves the latest usage report as a read-only document; an untitled one is dirty and editable, and VS Code keeps resurrecting its tab. */
export function registerUsageReportProvider(): vscode.Disposable[] {
  return [
    usageReportChanged,
    vscode.workspace.registerTextDocumentContentProvider(USAGE_REPORT_SCHEME, {
      onDidChange: usageReportChanged.event,
      provideTextDocumentContent: () => usageReport,
    }),
  ]
}

// --- activation ---------------------------------------------------------

/** The tree-item commands: each gets the clicked `EngineTreeItem` and ignores anything that is not an engine row. */
export function registerEngineTreeCommands(s: Session): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('engined.showEngineLogs', (item: EngineTreeItem) => {
      if (item.kind === 'engine') {
        return s.engineExplorer.showLogs(item.node)
      }
      return
    }),
    vscode.commands.registerCommand('engined.stopEngine', (item: EngineTreeItem) => {
      if (item.kind === 'engine') {
        return s.engineExplorer.stop(item.node)
      }
      return
    }),
    vscode.commands.registerCommand('engined.warmEngine', async (item: EngineTreeItem) => {
      if (item.kind !== 'engine') {
        return
      }
      const row = s.poller.rows.find(
        (r) => r.engine === item.node.rawId && r.door.name === item.node.door.name,
      )
      if (row === undefined) {
        vscode.window.showErrorMessage(`engined: no known model route for engine "${item.node.id}"`)
        return
      }
      try {
        await startModel(row.door.url, row.routeId)
      } catch (error) {
        vscode.window.showErrorMessage(`engined: warm "${row.id}" failed: ${describeError(error)}`)
      }
      await s.poller.pollNow()
      await s.engineExplorer.refresh()
    }),
    vscode.commands.registerCommand('engined.holdEngine', async (item: EngineTreeItem) => {
      if (item.kind !== 'engine') {
        return
      }
      try {
        await holdEngine(item.node.door.url, item.node.rawId)
        s.heldEngineIds.add(item.node.id)
        renderStatusBar(s)
      } catch (error) {
        vscode.window.showErrorMessage(
          `engined: hold "${item.node.id}" failed: ${describeError(error)}`,
        )
      }
      await s.engineExplorer.refresh()
    }),
    vscode.commands.registerCommand('engined.releaseHoldEngine', async (item: EngineTreeItem) => {
      if (item.kind !== 'engine') {
        return
      }
      try {
        await unholdEngine(item.node.door.url, item.node.rawId)
        s.heldEngineIds.delete(item.node.id)
        renderStatusBar(s)
      } catch (error) {
        vscode.window.showErrorMessage(
          `engined: release hold "${item.node.id}" failed: ${describeError(error)}`,
        )
      }
      await s.engineExplorer.refresh()
    }),
    vscode.commands.registerCommand('engined.copyFixCommand', (item: EngineTreeItem) => {
      if (item.kind === 'engine') {
        return copyFixCommand(item.node.fix)
      }
      return
    }),
    vscode.commands.registerCommand('engined.obtainEngine', (item: EngineTreeItem) => {
      if (item.kind === 'engine') {
        return s.engineExplorer.obtain(item.node)
      }
      return
    }),
  ]
}

/** `engined: Count Selection Tokens`: vocab-only count of the selection (or the whole document) via the chat-picker model. */
export async function countSelectionTokens(s: Session, bar: vscode.StatusBarItem): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (editor === undefined) {
    vscode.window.showInformationMessage('engined: no active editor')
    return
  }
  const scoped = !editor.selection.isEmpty
  const content = scoped ? editor.document.getText(editor.selection) : editor.document.getText()
  const lastRoute = s.lastChatCall?.route
  const listed = s.poller.models
  const picked =
    (lastRoute !== undefined
      ? listed.find((m) => m.id === lastRoute || m.row.id === lastRoute)
      : undefined) ?? listed[0]
  if (picked === undefined) {
    vscode.window.showErrorMessage('engined: no chat model is available to tokenize against')
    return
  }
  const row = picked.row
  try {
    const tokens = await postTokenize(
      row.door.url,
      row.routeId,
      content,
      AbortSignal.timeout(DOOR_TIMEOUT_MS),
    )
    const message = `${tokens} tokens (${scoped ? 'selection' : 'document'}, ${row.id})`
    bar.text = `$(symbol-numeric) ${tokens}`
    bar.tooltip = `engined: ${message}`
    bar.command = 'engined.countSelectionTokens'
    bar.show()
    vscode.window.showInformationMessage(`engined: ${message}`)
  } catch (error) {
    const message = `tokenize failed: ${describeError(error)}`
    s.log(message)
    vscode.window.showErrorMessage(`engined: ${message}`)
  }
}

/** `engined: Open Config UI`: opens the URL (with its one-time token) `engined --configsvc-url` prints; the URL is never logged. */
export async function openConfigUi(): Promise<void> {
  const result = await resolveConfigUi(runEnginedConfigsvcUrl)
  if ('url' in result) {
    await vscode.env.openExternal(vscode.Uri.parse(result.url))
    return
  }
  const copy = 'Copy enable command'
  const pick = await vscode.window.showWarningMessage(`engined: ${result.message}`, copy)
  if (pick === copy) {
    await vscode.env.clipboard.writeText(ENABLE_CONFIGSVC_COMMAND)
  }
}
