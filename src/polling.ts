/**
 * Model-list polling, decoupled from `vscode`'s timers and events so the
 * change-detection logic (fire only when the mapped list actually changed;
 * empty it after 3 consecutive failures) runs under `bun test`.
 */

import type { DoorReachability, EnginedModelInfo, EnginedModelRow } from './door.ts'
import { serializeModels, serializeRows } from './door.ts'

const CONSECUTIVE_FAILURES_TO_EMPTY = 3

export interface ModelsPoll {
  chatModels: EnginedModelInfo[]
  rows: EnginedModelRow[]
  /** One entry per configured door, in the caller's own order. */
  doorStatus: readonly DoorReachability[]
}

export class ModelPoller {
  #fetch: () => Promise<ModelsPoll>
  #onChange: (chatModels: EnginedModelInfo[]) => void
  #chatModels: EnginedModelInfo[] = []
  #rows: EnginedModelRow[] = []
  #doorStatus: readonly DoorReachability[] = []
  #lastSerialized = ''
  #consecutiveFailures = 0

  constructor(
    fetch: () => Promise<ModelsPoll>,
    onChange: (chatModels: EnginedModelInfo[]) => void,
  ) {
    this.#fetch = fetch
    this.#onChange = onChange
  }

  /** The chat-answerable subset -- what the `LanguageModelChatProvider` reports. */
  get models(): readonly EnginedModelInfo[] {
    return this.#chatModels
  }

  /** Every answerable row, chat or not -- what a tool or the completions picker chooses a route from. */
  get rows(): readonly EnginedModelRow[] {
    return this.#rows
  }

  /** Per-door reachability from the last poll -- the status popup's one line per door. */
  get doorStatus(): readonly DoorReachability[] {
    return this.#doorStatus
  }

  /** False once 3 consecutive polls found every door unreachable -- the same threshold that empties `models`/`rows`. */
  get reachable(): boolean {
    return this.#consecutiveFailures < CONSECUTIVE_FAILURES_TO_EMPTY
  }

  /** Poll once. Every configured door unreachable (including a thrown fetch) counts as one failure; the 3rd straight failure empties the lists. Fires `onChange` only when the reported chat models or rows actually differ from last time. */
  async pollNow(): Promise<void> {
    let poll: ModelsPoll
    let failed: boolean
    try {
      poll = await this.#fetch()
      failed = poll.doorStatus.length > 0 && poll.doorStatus.every((d) => !d.reachable)
    } catch {
      failed = true
      poll = {
        chatModels: [],
        rows: [],
        doorStatus: this.#doorStatus.map((d) => ({ ...d, reachable: false })),
      }
    }
    this.#doorStatus = poll.doorStatus
    if (failed) {
      this.#consecutiveFailures += 1
      if (this.#consecutiveFailures < CONSECUTIVE_FAILURES_TO_EMPTY) {
        return
      }
      poll.chatModels = []
      poll.rows = []
    } else {
      this.#consecutiveFailures = 0
    }
    const serialized = `${serializeModels(poll.chatModels)}|${serializeRows(poll.rows)}`
    if (serialized === this.#lastSerialized) {
      return
    }
    this.#lastSerialized = serialized
    this.#chatModels = poll.chatModels
    this.#rows = poll.rows
    this.#onChange(poll.chatModels)
  }
}
