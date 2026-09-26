/**
 * Model-list polling, decoupled from `vscode`'s timers and events so the
 * change-detection logic (fire only when the mapped list actually changed;
 * empty it after 3 consecutive failures) runs under `bun test`.
 */

import type { EnginedModelInfo, EnginedModelRow } from './door.ts'
import { serializeModels, serializeRows } from './door.ts'

const CONSECUTIVE_FAILURES_TO_EMPTY = 3

export interface ModelsPoll {
  chatModels: EnginedModelInfo[]
  rows: EnginedModelRow[]
}

export class ModelPoller {
  #fetch: () => Promise<ModelsPoll>
  #onChange: (chatModels: EnginedModelInfo[]) => void
  #chatModels: EnginedModelInfo[] = []
  #rows: EnginedModelRow[] = []
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

  /** False once 3 consecutive polls have failed -- the same threshold that empties `models`/`rows`. */
  get reachable(): boolean {
    return this.#consecutiveFailures < CONSECUTIVE_FAILURES_TO_EMPTY
  }

  /** Poll once. A failed poll keeps the last lists; the 3rd straight failure empties them. Fires `onChange` only when the reported chat models or rows actually differ from last time. */
  async pollNow(): Promise<void> {
    let poll: ModelsPoll
    try {
      poll = await this.#fetch()
      this.#consecutiveFailures = 0
    } catch {
      this.#consecutiveFailures += 1
      if (this.#consecutiveFailures < CONSECUTIVE_FAILURES_TO_EMPTY) {
        return
      }
      poll = { chatModels: [], rows: [] }
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
