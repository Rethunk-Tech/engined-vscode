/**
 * Model-list polling, decoupled from `vscode`'s timers and events so the
 * change-detection logic (fire only when the mapped list actually changed;
 * empty it after 3 consecutive failures) runs under `bun test`.
 */

import type { EnginedModelInfo } from './door.ts'
import { serializeModels } from './door.ts'

const CONSECUTIVE_FAILURES_TO_EMPTY = 3

export class ModelPoller {
  #fetchModels: () => Promise<EnginedModelInfo[]>
  #onChange: (models: EnginedModelInfo[]) => void
  #models: EnginedModelInfo[] = []
  #lastSerialized = ''
  #consecutiveFailures = 0

  constructor(
    fetchModels: () => Promise<EnginedModelInfo[]>,
    onChange: (models: EnginedModelInfo[]) => void,
  ) {
    this.#fetchModels = fetchModels
    this.#onChange = onChange
  }

  get models(): readonly EnginedModelInfo[] {
    return this.#models
  }

  /** False once 3 consecutive polls have failed -- the same threshold that empties `models`. */
  get reachable(): boolean {
    return this.#consecutiveFailures < CONSECUTIVE_FAILURES_TO_EMPTY
  }

  /** Poll once. A failed poll keeps the last list; the 3rd straight failure empties it. Fires `onChange` only when the reported list actually differs from last time. */
  async pollNow(): Promise<void> {
    let models: EnginedModelInfo[]
    try {
      models = await this.#fetchModels()
      this.#consecutiveFailures = 0
    } catch {
      this.#consecutiveFailures += 1
      if (this.#consecutiveFailures < CONSECUTIVE_FAILURES_TO_EMPTY) {
        return
      }
      models = []
    }
    const serialized = serializeModels(models)
    if (serialized === this.#lastSerialized) {
      return
    }
    this.#lastSerialized = serialized
    this.#models = models
    this.#onChange(models)
  }
}
