/**
 * The Engines `TreeDataProvider`, its item commands, and a dedicated
 * "engined: <engine> logs" output channel per engine. `engineTree.ts` holds
 * the pure JSON -> row mapping this file renders; hold-tracking is owned by
 * `extension.ts` (see `AGENTS.md`'s Engines-view invariant) and handed in as
 * a plain `Set`.
 */

import * as vscode from 'vscode'
import type { Door, EnginedModelRow } from './door.ts'
import { fetchEngineLogs, fetchEngineResources, fetchEngines, stopEngine } from './doorClient.ts'
import type { EngineNode, EnginesListResponse } from './engineTree.ts'
import { formatResourceLine, toEngineNodes, truncateLogLines } from './engineTree.ts'

const LOG_TAIL = 500

export type EngineTreeItem =
  | { kind: 'engine'; node: EngineNode }
  | { kind: 'resource'; text: string }
  | { kind: 'doorGroup'; door: Door }

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class EngineExplorer implements vscode.TreeDataProvider<EngineTreeItem> {
  readonly #emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.#emitter.event
  #nodes: EngineNode[] = []
  readonly #heldIds: ReadonlySet<string>
  readonly #log: (line: string) => void
  readonly #logChannels = new Map<string, vscode.OutputChannel>()
  readonly #getDoors: () => Door[]
  readonly #getRows: () => readonly EnginedModelRow[]

  constructor(
    heldIds: ReadonlySet<string>,
    log: (line: string) => void,
    getDoors: () => Door[],
    getRows: () => readonly EnginedModelRow[],
  ) {
    this.#heldIds = heldIds
    this.#log = log
    this.#getDoors = getDoors
    this.#getRows = getRows
  }

  dispose(): void {
    for (const channel of this.#logChannels.values()) {
      channel.dispose()
    }
  }

  async refresh(): Promise<void> {
    const doors = this.#getDoors()
    const rows = this.#getRows()
    const remoteEngineIds = new Set(
      rows
        .filter((r) => r.engine !== undefined && r.egress !== undefined && r.egress !== 'none')
        .map((r) => r.engine as string),
    )
    const isRemote = (rawId: string) => remoteEngineIds.has(rawId)
    const results = await Promise.all(
      doors.map(async (door) => {
        try {
          const response = (await fetchEngines(door.url)) as EnginesListResponse
          return toEngineNodes(response, {
            heldIds: this.#heldIds,
            door,
            doorCount: doors.length,
            isRemote,
          })
        } catch (error) {
          this.#log(`engines view: refresh failed for door "${door.name}": ${describe(error)}`)
          return []
        }
      }),
    )
    this.#nodes = results.flat()
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
      const resources = await fetchEngineResources(element.node.door.url, element.node.rawId)
      return [{ kind: 'resource' as const, text: formatResourceLine(resources) }]
    } catch (error) {
      return [{ kind: 'resource' as const, text: describe(error) }]
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
      const lines = truncateLogLines(await fetchEngineLogs(node.door.url, node.rawId, LOG_TAIL))
      channel.clear()
      for (const line of lines) {
        channel.appendLine(line)
      }
      channel.show()
    } catch (error) {
      vscode.window.showErrorMessage(`engined: logs for "${node.id}" failed: ${describe(error)}`)
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
      vscode.window.showErrorMessage(`engined: stop "${node.id}" failed: ${describe(error)}`)
    }
    await this.refresh()
  }
}

export function copyFixCommand(fix: string | undefined): Thenable<void> {
  return vscode.env.clipboard.writeText(fix ?? '')
}
