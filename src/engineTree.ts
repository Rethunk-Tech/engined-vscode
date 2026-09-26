/**
 * Pure mapping from `GET /engined/v1/engines`' JSON to the rows the Engines
 * view renders, and from `GET /engined/v1/engines/<id>/resources`' JSON to
 * display lines. No `vscode` import -- `engineExplorer.ts` is the
 * `TreeDataProvider` built on this.
 */

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

export interface EngineNode {
  id: string
  label: string
  description: string
  tooltip: string
  /** Drives the `view/item/context` `when` clauses in `package.json` -- `engine-unavailable` gets the "Copy fix command" action, `engine` gets the rest. */
  contextValue: 'engine' | 'engine-unavailable'
  icon: string
  fix: string | undefined
}

/** `GET /engined/v1/engines`'s rows -> what the tree shows, `held` sourced from the session's own hold-tracking (see `AGENTS.md`'s Engines-view invariant). */
export function toEngineNodes(
  response: EnginesListResponse | undefined,
  heldIds: ReadonlySet<string>,
): EngineNode[] {
  const engines = response?.engines ?? []
  return engines.map((engine) => {
    const held = heldIds.has(engine.id)
    const description = [engine.kind, engine.state, ...(held ? ['held'] : [])].join(' · ')
    return {
      id: engine.id,
      label: engine.id,
      description,
      tooltip:
        engine.state === 'unavailable' && engine.fix !== undefined ? engine.fix : description,
      contextValue: engine.state === 'unavailable' ? 'engine-unavailable' : 'engine',
      icon: stateIcon(engine.state),
      fix: engine.fix,
    }
  })
}

/** `{lines: [...]}`'s lines, or `{error}` rendered as the one line it is -- an engine that isn't running answers `resources` with an error, not a crash. */
export function formatResourceLines(
  resources: Record<string, unknown> | { error: string },
): string[] {
  if ('error' in resources && typeof resources.error === 'string') {
    return [resources.error]
  }
  return Object.entries(resources).map(([key, value]) => `${key}: ${String(value)}`)
}

const MAX_LOG_LINES = 500

/** The engine's own log lines, truncated to the last `MAX_LOG_LINES` -- a defensive second cap alongside the door's own `?tail=`. */
export function truncateLogLines(lines: readonly string[]): string[] {
  return lines.length > MAX_LOG_LINES ? lines.slice(lines.length - MAX_LOG_LINES) : [...lines]
}
