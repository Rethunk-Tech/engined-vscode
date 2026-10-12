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

/**
 * One role that currently holds a lease or has callers queued behind it.
 * `model`, when the door sends it, is the resident GGUF id, or the head of
 * the queue when `active` is still zero.
 */
interface EngineRole {
  role: string
  active: number
  waiting: number
  model?: string
}

/** One route this engine declares it can serve. `model` is that route's addressable id. */
interface EngineCapability {
  model?: string
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
  /**
   * Stop path for a running engine whose config generation `reload` has
   * replaced. Absent when the engine is not running, or when its shape still
   * matches. The value is the call that resolves it, e.g. `/engined/v1/engines/foo/stop`.
   */
  superseded?: string
  /** Present only for roles that are running or queued. Absent on an idle engine and on a kind that has no leases. */
  roles?: EngineRole[]
  /** Requests holding this engine open. Audio engines report this without `roles`. */
  active_leases?: number
  /**
   * Last start or stop failure. Shown only while `state` is `failed` or
   * `unavailable`. Absent, or present on any other state, adds nothing.
   */
  last_error?: string
  /**
   * Declared models this engine can be asked for, one entry per route.
   * Absent when it has no model-bearing routes. The tooltip lists these ids;
   * a live role's `model` is a different field and stays on its own line.
   */
  capabilities?: EngineCapability[]
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

function supersededLabel(superseded: string | undefined): string | undefined {
  return superseded === undefined ? undefined : `config stale ${superseded}`
}

/** A failed or unavailable engine's `last_error`. Any other state, or an absent field, adds nothing. */
function lastErrorLabel(engine: EngineRow): string | undefined {
  if (engine.state !== 'failed' && engine.state !== 'unavailable') {
    return undefined
  }
  const error = engine.last_error
  return error === undefined || error.length === 0 ? undefined : error
}

/**
 * The category note, except a `failed` engine that would otherwise read as
 * idle: it is not waiting to start on demand, and `last_error` is the note.
 */
function rowNote(engine: EngineRow, category: EngineCategory): string | undefined {
  if (engine.state === 'failed' && category === 'idle') {
    return undefined
  }
  return noteFor(category, engine.fix)
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

/** A door-sent model id. Absent or empty adds nothing to the row. */
function roleModel(role: EngineRole): string | undefined {
  const model = role.model
  return model === undefined || model.length === 0 ? undefined : model
}

/**
 * GGUF ids the door names for roles that are queued and not yet resident.
 * That is the queue head: nothing is active, so the id is the only model
 * the row can point at.
 */
function queueHeadModels(roles: readonly EngineRole[] | undefined): string[] {
  if (roles === undefined) {
    return []
  }
  const models: string[] = []
  for (const role of roles) {
    const model = roleModel(role)
    if (role.active === 0 && role.waiting > 0 && model !== undefined) {
      models.push(model)
    }
  }
  return models
}

/** Roles with a lease or a queue. Idle zeroes are omitted the same way the door omits them. */
function busyRoleLines(roles: readonly EngineRole[] | undefined): string[] {
  if (roles === undefined) {
    return []
  }
  const lines: string[] = []
  for (const role of roles) {
    if (role.active > 0 || role.waiting > 0) {
      const counts = `${role.role} ${role.active} active, ${role.waiting} waiting`
      const model = roleModel(role)
      lines.push(model === undefined ? counts : `${counts} · ${model}`)
    }
  }
  return lines
}

/** Declared model ids named in full before the rest collapse to a count. */
const CAPABILITY_MODELS_SHOWN = 4

function declaredModelIds(capabilities: readonly EngineCapability[]): string[] {
  const seen = new Set<string>()
  const models: string[] = []
  for (const capability of capabilities) {
    const { model } = capability
    if (model === undefined || model.length === 0 || seen.has(model)) {
      continue
    }
    seen.add(model)
    models.push(model)
  }
  return models
}

/** Compact tooltip line for declared models. Absent capabilities, or none with a model id, add nothing. */
function capabilitySummary(
  capabilities: readonly EngineCapability[] | undefined,
): string | undefined {
  if (capabilities === undefined || capabilities.length === 0) {
    return undefined
  }
  const models = declaredModelIds(capabilities)
  const [first] = models
  if (first === undefined) {
    return undefined
  }
  if (models.length <= CAPABILITY_MODELS_SHOWN) {
    return `models: ${models.join(', ')}`
  }
  return `${models.length} models, including ${first}`
}

function baseTooltip(engine: EngineRow, description: string): string {
  if (engine.state === 'unavailable' && engine.fix !== undefined) {
    const error = lastErrorLabel(engine)
    return error === undefined ? engine.fix : `${engine.fix}\n${error}`
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

function engineTooltip(engine: EngineRow, description: string): string {
  const text = baseTooltip(engine, description)
  const summary = capabilitySummary(engine.capabilities)
  return summary === undefined ? text : `${text}\n${summary}`
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
 * and the tooltip lists each busy role. A role's `model`, when the door sends
 * one, is appended on that tooltip line; when the role is queued and nothing
 * is active yet, the same id is also appended on the description (the queue
 * head). An absent `model` adds nothing. A `last_error` on a `failed` or
 * `unavailable` engine is appended; an absent field, or the same field on any
 * other state, adds nothing. When `capabilities` names declared models, the
 * tooltip appends a compact summary of those ids; an absent field adds
 * nothing, and that summary is not the live role model. A positive `active_leases` is the
 * tooltip when the engine reports no busy role. A future `idle_until` appends
 * `idle until <time>` the same way a hold appends its deadline; a past, equal,
 * or missing value adds nothing. A present `superseded` appends
 * `config stale <stop path>`; an absent field adds nothing. `isRemote`
 * answers, for one engine's raw id, whether any row it backs reports a
 * non-local egress -- `EngineStatus` itself carries no egress, so that has
 * to come from the model rows this extension already polled.
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
    const note = rowNote(engine, category)
    const waiting = waitingTotal(engine.roles)
    const description = [
      engine.kind,
      engine.state,
      note,
      heldLabel(heldUntil, heldIds.has(id)),
      idleLabel(futureInstant(engine.idle_until, now)),
      supersededLabel(engine.superseded),
      waiting > 0 ? `${waiting} waiting` : undefined,
      ...queueHeadModels(engine.roles),
      lastErrorLabel(engine),
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
