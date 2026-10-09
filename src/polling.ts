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
  readonly #fetch: () => Promise<ModelsPoll>
  readonly #onChange: (chatModels: EnginedModelInfo[]) => void
  #chatModels: EnginedModelInfo[] = []
  #rows: EnginedModelRow[] = []
  #doorStatus: readonly DoorReachability[] = []
  #lastSerialized = ''
  #consecutiveFailures = 0
  #queue: Promise<void> = Promise.resolve()
  #pending = 0

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

  /** True while a poll is running or queued -- a timer tick should skip rather than stack another. */
  get busy(): boolean {
    return this.#pending > 0
  }

  /** Polls run one at a time in call order, so an older poll's result can never overwrite a newer one. */
  pollNow(): Promise<void> {
    this.#pending += 1
    const run = this.#queue.then(() => this.#pollOnce())
    this.#queue = run.finally(() => {
      this.#pending -= 1
    })
    return run
  }

  /** One poll. Every configured door unreachable (including a thrown fetch) counts as one failure; the 3rd straight failure empties the lists. Fires `onChange` only when the reported chat models or rows actually differ from last time. */
  async #pollOnce(): Promise<void> {
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

/** Poll interval floor while the events stream is up -- it is the fallback, not the primary signal, once frames are actually arriving. */
const CONNECTED_POLL_FLOOR_SECONDS = 300

/** Effective poll period in seconds: the configured one (0 disables polling), floored while the events stream is delivering frames. */
export function effectivePollSeconds(configured: number, eventsConnected: boolean): number {
  if (configured <= 0) {
    return 0
  }
  return eventsConnected ? Math.max(configured, CONNECTED_POLL_FLOOR_SECONDS) : configured
}
