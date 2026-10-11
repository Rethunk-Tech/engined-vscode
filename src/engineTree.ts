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

/** One role that currently holds a lease or has callers queued behind it. A `model` field, when the door sends one, is ignored. */
interface EngineRole {
  role: string
  active: number
  waiting: number
}

interface EngineRow {
  id: string
  kind: string
  state: string
  disabled?: boolean
  fix?: string
  /** ISO-8601. Present on the wire only while a hold is still in the future; a past or unparseable value is not a hold. */
  held_until?: string
  /** ISO-8601. Present on a running engine with zero leases; absent otherwise. A past or equal value is not shown. */
  idle_until?: string
  /** Present only for roles that are running or queued. Absent on an idle engine and on a kind that has no leases. */
  roles?: EngineRole[]
  /** Requests holding this engine open. Audio engines report this without `roles`. */
  active_leases?: number
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
  /** The row's `held_until`, kept only while that timestamp is still ahead of `now`. */
  heldUntil?: string
}

/** An ISO-8601 instant still strictly ahead of `now`. Absent, past, equal, or unparseable is dropped. */
function futureInstant(value: string | undefined, now: number): string | undefined {
  if (value === undefined) {
    return undefined
  }
  const ms = Date.parse(value)
  return Number.isFinite(ms) && ms > now ? value : undefined
}

function heldLabel(heldUntil: string | undefined, heldBySession: boolean): string | undefined {
  if (heldUntil !== undefined) {
    return `held until ${heldUntil}`
  }
  return heldBySession ? 'held' : undefined
}

function idleLabel(idleUntil: string | undefined): string | undefined {
  return idleUntil === undefined ? undefined : `idle until ${idleUntil}`
}

function waitingTotal(roles: readonly EngineRole[] | undefined): number {
  if (roles === undefined) {
    return 0
  }
  let total = 0
  for (const role of roles) {
    if (role.waiting > 0) {
      total += role.waiting
    }
  }
  return total
}

/** Roles with a lease or a queue. Idle zeroes are omitted the same way the door omits them. */
function busyRoleLines(roles: readonly EngineRole[] | undefined): string[] {
  if (roles === undefined) {
    return []
  }
  const lines: string[] = []
  for (const role of roles) {
    if (role.active > 0 || role.waiting > 0) {
      lines.push(`${role.role} ${role.active} active, ${role.waiting} waiting`)
    }
  }
  return lines
}

function engineTooltip(engine: EngineRow, description: string): string {
  if (engine.state === 'unavailable' && engine.fix !== undefined) {
    return engine.fix
  }
  const roles = busyRoleLines(engine.roles)
  if (roles.length > 0) {
    return roles.join('\n')
  }
  if (engine.active_leases !== undefined && engine.active_leases > 0) {
    return `${description}\n${engine.active_leases} active`
  }
  return description
}

/**
 * Qualified ids Release Hold should offer: holds this session placed, plus
 * every engines-list row whose `held_until` is still ahead. The session set
 * covers a hold placed a moment ago, before the next list poll reports it.
 */
export function releaseHoldIds(
  sessionHeld: ReadonlySet<string>,
  listedHeld: readonly string[],
): string[] {
  return [...new Set([...sessionHeld, ...listedHeld])].sort()
}

/**
 * `GET /engined/v1/engines`'s rows -> what the tree shows. A row is held when
 * `held_until` is still in the future, or when this session placed the hold
 * and the list has not reported that field yet. When any `roles` entry has
 * `waiting` greater than zero, the description appends the sum as `N waiting`,
 * and the tooltip lists each busy role. A positive `active_leases` is the
 * tooltip when the engine reports no busy role. A future `idle_until` appends
 * `idle until <time>` the same way a hold appends its deadline; a past, equal,
 * or missing value adds nothing. `isRemote` answers, for one engine's raw
 * id, whether any row it backs reports a non-local egress -- `EngineStatus`
 * itself carries no egress, so that has to come from the model rows this
 * extension already polled.
 */
export function toEngineNodes(
  response: EnginesListResponse | undefined,
  context: {
    heldIds: ReadonlySet<string>
    door: Door
    doorCount: number
    isRemote?: (rawId: string) => boolean
    /** Defaults to `Date.now()`. Tests pass a fixed instant. */
    now?: number
  },
): EngineNode[] {
  const { heldIds, door, doorCount, isRemote = () => false, now = Date.now() } = context
  const engines = response?.engines ?? []
  return engines.map((engine) => {
    const id = qualifyId(door.name, engine.id, doorCount)
    const heldUntil = futureInstant(engine.held_until, now)
    const category = categorize(engine, isRemote(engine.id))
    const note = noteFor(category, engine.fix)
    const waiting = waitingTotal(engine.roles)
    const description = [
      engine.kind,
      engine.state,
      note,
      heldLabel(heldUntil, heldIds.has(id)),
      idleLabel(futureInstant(engine.idle_until, now)),
      waiting > 0 ? `${waiting} waiting` : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join(' · ')
    return {
      id,
      rawId: engine.id,
      door,
      label: engine.id,
      description,
      tooltip: engineTooltip(engine, description),
      contextValue: engine.state === 'unavailable' ? 'engine-unavailable' : 'engine',
      icon: stateIcon(engine.state),
      fix: engine.fix,
      hasResources: category === 'running',
      ...(heldUntil === undefined ? {} : { heldUntil }),
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
