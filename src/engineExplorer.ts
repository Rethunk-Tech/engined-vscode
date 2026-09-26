/**
 * The Engines `TreeDataProvider`, its item commands, and a dedicated
 * "engined: <engine> logs" output channel per engine. `engineTree.ts` holds
 * the pure JSON -> row mapping this file renders; hold-tracking is owned by
 * `extension.ts` (see `AGENTS.md`'s Engines-view invariant) and handed in as
 * a plain `Set`.
 */

import * as vscode from 'vscode'
import { getUrl } from './config.ts'
import { fetchEngineLogs, fetchEngineResources, fetchEngines, stopEngine } from './doorClient.ts'
import type { EngineNode, EnginesListResponse } from './engineTree.ts'
import { formatResourceLines, toEngineNodes, truncateLogLines } from './engineTree.ts'

const LOG_TAIL = 500

export type EngineTreeItem =
  | { kind: 'engine'; node: EngineNode }
  | { kind: 'resource'; text: string }

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class EngineExplorer implements vscode.TreeDataProvider<EngineTreeItem> {
  #emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.#emitter.event
  #nodes: EngineNode[] = []
  #heldIds: ReadonlySet<string>
  #log: (line: string) => void
  #logChannels = new Map<string, vscode.OutputChannel>()

  constructor(heldIds: ReadonlySet<string>, log: (line: string) => void) {
    this.#heldIds = heldIds
    this.#log = log
  }

  dispose(): void {
    for (const channel of this.#logChannels.values()) {
      channel.dispose()
    }
  }

  async refresh(): Promise<void> {
    try {
      const response = (await fetchEngines(getUrl())) as EnginesListResponse
      this.#nodes = toEngineNodes(response, this.#heldIds)
    } catch (error) {
      this.#log(`engines view: refresh failed: ${describe(error)}`)
      this.#nodes = []
    }
    this.#emitter.fire()
  }

  getTreeItem(element: EngineTreeItem): vscode.TreeItem {
    if (element.kind === 'resource') {
      return new vscode.TreeItem(element.text)
    }
    const node = element.node
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed)
    item.description = node.description
    item.tooltip = node.tooltip
    item.contextValue = node.contextValue
    item.iconPath = new vscode.ThemeIcon(node.icon)
    return item
  }

  async getChildren(element?: EngineTreeItem): Promise<EngineTreeItem[]> {
    if (element === undefined) {
      return this.#nodes.map((node) => ({ kind: 'engine' as const, node }))
    }
    if (element.kind !== 'engine') {
      return []
    }
    try {
      const resources = await fetchEngineResources(getUrl(), element.node.id)
      return formatResourceLines(resources).map((text) => ({ kind: 'resource' as const, text }))
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

  async showLogs(id: string): Promise<void> {
    const channel = this.#channelFor(id)
    try {
      const lines = truncateLogLines(await fetchEngineLogs(getUrl(), id, LOG_TAIL))
      channel.clear()
      for (const line of lines) {
        channel.appendLine(line)
      }
      channel.show()
    } catch (error) {
      void vscode.window.showErrorMessage(`engined: logs for "${id}" failed: ${describe(error)}`)
    }
  }

  async stop(id: string): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      `Stop engine "${id}"?`,
      { modal: true },
      'Stop',
    )
    if (confirmed !== 'Stop') {
      return
    }
    try {
      await stopEngine(getUrl(), id)
    } catch (error) {
      void vscode.window.showErrorMessage(`engined: stop "${id}" failed: ${describe(error)}`)
    }
    await this.refresh()
  }
}

export function copyFixCommand(fix: string | undefined): Thenable<void> {
  return vscode.env.clipboard.writeText(fix ?? '')
}
