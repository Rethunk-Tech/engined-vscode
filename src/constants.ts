export const HTTP_NOT_FOUND = 404
export const HTTP_TOO_MANY_REQUESTS = 429

export const MS_PER_SECOND = 1000

/** Door GETs that must not hang the poller, usage refresh, or Engines view. */
export const DOOR_TIMEOUT_MS = 5000

export const BYTES_PER_KIB = 1024

/** Decimal thousand: the "k" in "30k tokens". */
export const THOUSAND = 1000
export const LOADING_TICK_MS = 300
export const CHAT_SETTINGS_ROUTED_CONTEXT = 'engined.chatSettingsRouted'

/** Status-bar click menu. `commands.ts` `showQuickPick` renders this list. */
export const STATUS_QUICK_PICK = [
  { label: 'Refresh models', action: 'refresh' },
  { label: 'Warm model', action: 'warm' },
  { label: 'Hold engine', action: 'hold' },
  { label: 'Release hold', action: 'unhold' },
  { label: 'Set reasoning effort (global)', action: 'effort-global' },
  { label: 'Set reasoning effort for a model', action: 'effort-model' },
  { label: 'Choose default models', action: 'default-models' },
  { label: 'Usage report', action: 'usage' },
  { label: 'Show log', action: 'log' },
] as const
