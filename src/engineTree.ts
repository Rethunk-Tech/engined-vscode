/**
 * Pure mapping from `GET /engined/v1/engines`' JSON to the rows the Engines
 * view renders, and from `GET /engined/v1/engines/<id>/resources`' JSON to
 * a display line. No `vscode` import -- `engineExplorer.ts` is the
 * `TreeDataProvider` built on this.
 */

import { BYTES_PER_KIB } from './constants.ts'
import type { Door } from './door.ts'
import { qualifyId } from './door.ts'
import { doorErrorMessage } from './doorClient.ts'
import { unreachable } from './unreachable.ts'

export interface EngineRow {
  id: string
  kind: string
  state: string
  disabled?: boolean
  fix?: string
}

export interface EnginesListResponse {
  engines: EngineRow[]
}

/** A codicon id (no `$()` wrapper -- that's the markdown/package.json spelling; `vscode.ThemeIcon` takes the bare id) per engine state. */
export function stateIcon(state: string): string {
  switch (state) {
    case 'running':
      return 'pass-filled'
    case 'warming':
      return 'sync~spin'
    case 'unavailable':
      return 'error'
    default:
      return 'circle-outline'
  }
}

/**
 * `agentic-cli` never has a container to inspect; `unavailable` never runs
 * one right now; `remote` (a row this engine backs reports a non-local
 * egress) has no container this door can reach into either; only a running,
 * local container-kind engine has resources worth fetching.
 */
type EngineCategory = 'agentic-cli' | 'remote' | 'unavailable' | 'idle' | 'running'

function categorize(engine: EngineRow, remote: boolean): EngineCategory {
  if (engine.kind === 'agentic-cli') {
    return 'agentic-cli'
  }
  if (engine.state === 'unavailable') {
    return 'unavailable'
  }
  if (remote) {
    return 'remote'
  }
  return engine.state === 'running' ? 'running' : 'idle'
}

/** The one-line explanation shown instead of a raw `resources` error, or `undefined` for a running local container (its resources are the children). */
function noteFor(category: EngineCategory, fix: string | undefined): string | undefined {
  switch (category) {
    case 'agentic-cli':
      return 'agent CLI, no container'
    case 'remote':
      return 'remote API'
    case 'unavailable':
      return fix
    case 'idle':
      return 'idle, starts on demand'
    case 'running':
      return undefined
    default:
      return unreachable(category)
  }
}

export interface EngineNode {
  /** Qualified against `door` -- plain with one door, `<door name>/<engine id>` with more than one. */
  id: string
  /** The door's own engine id, unqualified -- what a resources/logs/stop/hold call must send. */
  rawId: string
  door: Door
  label: string
  description: string
  tooltip: string
  /** Drives the `view/item/context` `when` clauses in `package.json` -- `engine-unavailable` gets the "Copy fix command" action, `engine` gets the rest. */
  contextValue: 'engine' | 'engine-unavailable'
  icon: string
  fix: string | undefined
  /** Only a running, local container-kind engine has anything a `resources` fetch could answer. */
  hasResources: boolean
}

/**
 * `GET /engined/v1/engines`'s rows -> what the tree shows, `held` sourced
 * from the session's own hold-tracking (see `AGENTS.md`'s Engines-view
 * invariant). `isRemote` answers, for one engine's raw id, whether any row
 * it backs reports a non-local egress -- `EngineStatus` itself carries no
 * egress, so that has to come from the model rows this extension already
 * polled.
 */
export function toEngineNodes(
  response: EnginesListResponse | undefined,
  context: {
    heldIds: ReadonlySet<string>
    door: Door
    doorCount: number
    isRemote?: (rawId: string) => boolean
  },
): EngineNode[] {
  const { heldIds, door, doorCount, isRemote = () => false } = context
  const engines = response?.engines ?? []
  return engines.map((engine) => {
    const held = heldIds.has(qualifyId(door.name, engine.id, doorCount))
    const category = categorize(engine, isRemote(engine.id))
    const note = noteFor(category, engine.fix)
    const description = [engine.kind, engine.state, note, held ? 'held' : undefined]
      .filter((part): part is string => part !== undefined)
      .join(' · ')
    return {
      id: qualifyId(door.name, engine.id, doorCount),
      rawId: engine.id,
      door,
      label: engine.id,
      description,
      tooltip:
        engine.state === 'unavailable' && engine.fix !== undefined ? engine.fix : description,
      contextValue: engine.state === 'unavailable' ? 'engine-unavailable' : 'engine',
      icon: stateIcon(engine.state),
      fix: engine.fix,
      hasResources: category === 'running',
    }
  })
}

const KIB = BYTES_PER_KIB
const MIB = KIB * BYTES_PER_KIB
const GIB = MIB * BYTES_PER_KIB

/** 1024-based, one decimal from GiB up -- `30026362880` -> `28.0 GiB`, `350208` -> `342 KiB`. */
function formatBytes(bytes: number): string {
  if (bytes >= GIB) {
    return `${(bytes / GIB).toFixed(1)} GiB`
  }
  if (bytes >= MIB) {
    return `${Math.round(bytes / MIB)} MiB`
  }
  return `${Math.round(bytes / KIB)} KiB`
}

/** engined's `EngineResources` (`memory_bytes`/`graphics_bytes`, either nullable) -> `"RAM 334 MiB · GPU 28.0 GiB"`, or `{error}`'s message as the one line it is. */
export function formatResourceLine(
  resources: { memory_bytes: number | null; graphics_bytes: number | null } | { error: unknown },
): string {
  if ('error' in resources) {
    return doorErrorMessage(resources.error) ?? String(resources.error)
  }
  const parts: string[] = []
  if (resources.memory_bytes !== null) {
    parts.push(`RAM ${formatBytes(resources.memory_bytes)}`)
  }
  if (resources.graphics_bytes !== null) {
    parts.push(`GPU ${formatBytes(resources.graphics_bytes)}`)
  }
  return parts.length > 0 ? parts.join(' · ') : 'no resource data'
}

const MAX_LOG_LINES = 500

/** The engine's own log lines, truncated to the last `MAX_LOG_LINES` -- a defensive second cap alongside the door's own `?tail=`. */
export function truncateLogLines(lines: readonly string[]): string[] {
  return lines.length > MAX_LOG_LINES ? lines.slice(lines.length - MAX_LOG_LINES) : [...lines]
}
