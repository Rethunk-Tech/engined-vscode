/**
 * The single selection rule behind every `engined.defaultModels.*` setting:
 * the configured row wins when it is still installed, not unavailable, and
 * serves the role's path (matching vision kind for ocr/vision); otherwise
 * the first qualifying row is the automatic pick. No `vscode` import --
 * `extension.ts` supplies the latest poll and the setting's value.
 */

import type { EnginedModelRow } from './door.ts'

export type ModelRole = 'image' | 'ocr' | 'vision' | 'completion' | 'speech' | 'transcription'

/** The door path each role needs. `image` also covers edits -- a caller building an edit passes that path explicitly. */
export const ROLE_PATH: Record<ModelRole, string> = {
  image: '/openai/v1/images/generations',
  ocr: '/openai/v1/chat/completions',
  vision: '/openai/v1/chat/completions',
  completion: '/openai/v1/completions',
  speech: '/openai/v1/audio/speech',
  transcription: '/openai/v1/audio/transcriptions',
}

function qualifies(row: EnginedModelRow, role: ModelRole, path: string): boolean {
  if (row.state === 'unavailable' || !row.serves.includes(path)) {
    return false
  }
  if (role === 'ocr') {
    return row.role === 'vision' && row.vision === 'read'
  }
  if (role === 'vision') {
    return row.role === 'vision' && row.vision === 'describe'
  }
  return true
}

/** Every row usable for `role`, in `rows`' own order. */
export function qualifyingRows(
  rows: readonly EnginedModelRow[],
  role: ModelRole,
  path: string = ROLE_PATH[role],
): EnginedModelRow[] {
  return rows.filter((row) => qualifies(row, role, path))
}

export interface DefaultModelResolution {
  row: EnginedModelRow | undefined
  /** Set only when `configuredId` was non-empty but is not currently usable for `role`. */
  unusableReason?: string
}

/**
 * The configured id if it still qualifies for `role`, else the first
 * qualifying row (the automatic pick), with a reason string when the
 * configured id fell through to automatic.
 */
export function resolveDefaultModel(
  rows: readonly EnginedModelRow[],
  role: ModelRole,
  configuredId: string,
  path: string = ROLE_PATH[role],
): DefaultModelResolution {
  const qualifying = qualifyingRows(rows, role, path)
  if (configuredId === '') {
    return { row: qualifying[0] }
  }
  const configured = qualifying.find((row) => row.id === configuredId)
  if (configured !== undefined) {
    return { row: configured }
  }
  const existing = rows.find((row) => row.id === configuredId)
  const reason =
    existing === undefined
      ? `"${configuredId}" is not an installed engined route`
      : existing.state === 'unavailable'
        ? `"${configuredId}" is unavailable`
        : `"${configuredId}" does not qualify for ${role} (needs ${path})`
  return { row: qualifying[0], unusableReason: reason }
}
