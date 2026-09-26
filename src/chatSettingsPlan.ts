/**
 * The settings `engined.useForAllChatFeatures` writes, and how to put them back.
 * A stable-API extension cannot hide another vendor's models, so this steers every
 * setting that picks a model by default. Each key's value format is the one VS Code
 * itself resolves it with: `chat.defaultModel` matches a bare model id, the utility
 * keys store `vendor/id`, and the agent defaults store the qualified display name.
 */

export interface SettingWrite {
  readonly key: string
  readonly value: unknown
}

/** A key's user-scope value before the switch; `undefined` means it was unset. */
export interface SavedSetting {
  readonly key: string
  readonly previous: unknown
}

export interface PlanModel {
  readonly id: string
  readonly name: string
}

export function buildChatSettingsPlan(model: PlanModel): SettingWrite[] {
  return [
    { key: 'chat.byokUtilityModelDefault', value: 'mainAgent' },
    { key: 'chat.defaultModel', value: model.id },
    { key: 'chat.utilityModel', value: `engined/${model.id}` },
    { key: 'chat.utilitySmallModel', value: `engined/${model.id}` },
    { key: 'chat.planAgent.defaultModel', value: `${model.name} (engined)` },
    { key: 'chat.exploreAgent.defaultModel', value: `${model.name} (engined)` },
    { key: 'github.copilot.enable', value: { '*': false } },
  ]
}

/** One line per key for the confirmation dialog, so nothing is written unseen. */
export function describePlan(plan: readonly SettingWrite[]): string {
  return plan.map((w) => `${w.key} = ${JSON.stringify(w.value)}`).join('\n')
}

/** Restoring writes each saved value back; `undefined` removes the user-scope value. */
export function buildRestorePlan(saved: readonly SavedSetting[]): SettingWrite[] {
  return saved.map((s) => ({ key: s.key, value: s.previous }))
}
