/**
 * The Engines `TreeDataProvider`, its item commands, and a dedicated
 * "engined: <engine> logs" output channel per engine. `engineTree.ts` holds
 * the pure JSON -> row mapping this file renders. A hold this session placed
 * is handed in as a plain `Set`; a hold another session placed arrives as
 * `held_until` on the engines list.
 */

import * as vscode from 'vscode'
import { DOOR_TIMEOUT_MS } from './constants.ts'
import { describeError } from './describeError.ts'
import type { Door, EnginedModelRow } from './door.ts'
import { fetchEngineLogs, fetchEngineResources, fetchEngines, stopEngine } from './doorClient.ts'
import type {
  DoorGroupNote,
  DoorListOutcome,
  EngineNode,
  EnginesListResponse,
} from './engineTree.ts'
import {
  doorGroupNote,
  enginesViewMessage,
  formatResourceLine,
  onlyRemoteEngineIds,
  toEngineNodes,
  truncateLogLines,
} from './engineTree.ts'

const LOG_TAIL = 500
const NO_NOTE: DoorGroupNote = {}

export type EngineTreeItem =
  | { kind: 'engine'; node: EngineNode }
  | { kind: 'resource'; text: string }
  | { kind: 'doorGroup'; door: Door }

export class EngineExplorer implements vscode.TreeDataProvider<EngineTreeItem> {
  readonly #emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.#emitter.event
  #nodes: EngineNode[] = []
  #doorNotes = new Map<string, DoorGroupNote>()
  readonly #heldIds: ReadonlySet<string>
  readonly #log: (line: string) => void
  readonly #logChannels = new Map<string, vscode.OutputChannel>()
  readonly #getDoors: () => Door[]
  readonly #getRows: () => readonly EnginedModelRow[]
  readonly #setMessage: (text: string | undefined) => void

  constructor(deps: {
    heldIds: ReadonlySet<string>
    log: (line: string) => void
    getDoors: () => Door[]
    getRows: () => readonly EnginedModelRow[]
    setMessage: (text: string | undefined) => void
  }) {
    this.#heldIds = deps.heldIds
    this.#log = deps.log
    this.#getDoors = deps.getDoors
    this.#getRows = deps.getRows
    this.#setMessage = deps.setMessage
  }

  /** Qualified ids whose latest engines-list row still has a future `held_until`. */
  listedHoldIds(): readonly string[] {
    return this.#nodes.flatMap((node) => (node.heldUntil === undefined ? [] : [node.id]))
  }

  dispose(): void {
    for (const channel of this.#logChannels.values()) {
      channel.dispose()
    }
  }

  async refresh(): Promise<void> {
    const doors = this.#getDoors()
    const rows = this.#getRows()
    const remoteEngineIds = onlyRemoteEngineIds(rows)
    const isRemote = (rawId: string) => remoteEngineIds.has(rawId)
    const results = await Promise.all(
      doors.map(async (door) => {
        try {
          const response = (await fetchEngines(
            door.url,
            AbortSignal.timeout(DOOR_TIMEOUT_MS),
          )) as EnginesListResponse
          return {
            name: door.name,
            outcome: { name: door.name, url: door.url, configError: response.config_error },
            note: doorGroupNote(response),
            nodes: toEngineNodes(response, {
              heldIds: this.#heldIds,
              door,
              doorCount: doors.length,
              isRemote,
            }),
          }
        } catch (error) {
          this.#log(`engines view: refresh failed for door "${door.name}": ${describeError(error)}`)
          return {
            name: door.name,
            outcome: { name: door.name, url: door.url, failure: describeError(error) },
            note: NO_NOTE,
            nodes: [],
          }
        }
      }),
    )
    this.#nodes = results.flatMap((result) => result.nodes)
    this.#doorNotes = new Map(
      results.flatMap((result) =>
        result.note.description === undefined ? [] : [[result.name, result.note] as const],
      ),
    )
    this.#setMessage(enginesViewMessage(results.map((result): DoorListOutcome => result.outcome)))
    this.#emitter.fire()
  }

  getTreeItem(element: EngineTreeItem): vscode.TreeItem {
    if (element.kind === 'resource') {
      return new vscode.TreeItem(element.text)
    }
    if (element.kind === 'doorGroup') {
      const item = new vscode.TreeItem(element.door.name, vscode.TreeItemCollapsibleState.Expanded)
      item.iconPath = new vscode.ThemeIcon('server')
      item.contextValue = 'doorGroup'
      const note = this.#doorNotes.get(element.door.name)
      if (note?.description !== undefined) {
        item.description = note.description
      }
      if (note?.tooltip !== undefined) {
        item.tooltip = note.tooltip
      }
      return item
    }
    const { node } = element
    const item = new vscode.TreeItem(
      node.label,
      node.hasResources
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    )
    item.description = node.description
    item.tooltip = node.tooltip
    item.contextValue = node.contextValue
    item.iconPath = new vscode.ThemeIcon(node.icon)
    return item
  }

  async getChildren(element?: EngineTreeItem): Promise<EngineTreeItem[]> {
    if (element === undefined) {
      const doors = this.#getDoors()
      if (doors.length > 1) {
        return doors.map((door) => ({ kind: 'doorGroup' as const, door }))
      }
      return this.#nodes.map((node) => ({ kind: 'engine' as const, node }))
    }
    if (element.kind === 'doorGroup') {
      return this.#nodes
        .filter((n) => n.door.name === element.door.name)
        .map((node) => ({ kind: 'engine' as const, node }))
    }
    if (element.kind !== 'engine' || !element.node.hasResources) {
      return []
    }
    try {
      const resources = await fetchEngineResources(
        element.node.door.url,
        element.node.rawId,
        AbortSignal.timeout(DOOR_TIMEOUT_MS),
      )
      return [{ kind: 'resource' as const, text: formatResourceLine(resources) }]
    } catch (error) {
      return [{ kind: 'resource' as const, text: describeError(error) }]
    }
  }

  nodeFor(id: string): EngineNode | undefined {
    return this.#nodes.find((n) => n.id === id)
  }

  #channelFor(id: string): vscode.OutputChannel {
    let channel = this.#logChannels.get(id)
    if (channel === undefined) {
      channel = vscode.window.createOutputChannel(`engined: ${id} logs`)
      this.#logChannels.set(id, channel)
    }
    return channel
  }

  async showLogs(node: EngineNode): Promise<void> {
    const channel = this.#channelFor(node.id)
    try {
      const lines = truncateLogLines(
        await fetchEngineLogs(
          node.door.url,
          node.rawId,
          LOG_TAIL,
          AbortSignal.timeout(DOOR_TIMEOUT_MS),
        ),
      )
      channel.clear()
      for (const line of lines) {
        channel.appendLine(line)
      }
      channel.show()
    } catch (error) {
      vscode.window.showErrorMessage(
        `engined: logs for "${node.id}" failed: ${describeError(error)}`,
      )
    }
  }

  async stop(node: EngineNode): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      `Stop engine "${node.id}"?`,
      { modal: true },
      'Stop',
    )
    if (confirmed !== 'Stop') {
      return
    }
    try {
      await stopEngine(node.door.url, node.rawId)
    } catch (error) {
      vscode.window.showErrorMessage(`engined: stop "${node.id}" failed: ${describeError(error)}`)
    }
    await this.refresh()
  }
}

export function copyFixCommand(fix: string | undefined): Thenable<void> {
  return vscode.env.clipboard.writeText(fix ?? '')
}
