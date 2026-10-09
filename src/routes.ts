/** Resolving a tool's or the completions picker's route through the one default-model rule. */

import { getDefaultModel } from './config.ts'
import type { DefaultModelResolution, ModelRole } from './defaultModels.ts'
import { logUnusableIfChanged, ROLE_PATH, resolveDefaultModel } from './defaultModels.ts'
import type { EnginedModelRow } from './door.ts'
import type { Session } from './session.ts'
import { ToolRouteError } from './toolRequests.ts'

/** The role's resolved row, or throws `ToolRouteError` naming the role when nothing qualifies at all. */
export function resolveRoleRow(s: Session, role: ModelRole, path?: string): EnginedModelRow {
  const resolved: DefaultModelResolution = resolveDefaultModel(
    s.poller.rows,
    role,
    getDefaultModel(role),
    path,
  )
  logUnusableIfChanged(s.loggedUnusableReasons, s.log, role, resolved.unusableReason)
  if (resolved.row === undefined) {
    throw new ToolRouteError(
      `no installed engined route serves ${role} (${path ?? ROLE_PATH[role]})`,
    )
  }
  return resolved.row
}
