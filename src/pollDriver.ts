/** The model-list poll timer and the per-door engine-events streams that make polling a fallback. */

import { getDoors, getPollSeconds } from './config.ts'
import { MS_PER_SECOND } from './constants.ts'
import { describeError } from './describeError.ts'
import type { Door } from './door.ts'
import { openEngineEventsStream } from './doorClient.ts'
import { backoffMs, parseSseChunk } from './engineEvents.ts'
import { effectivePollSeconds } from './polling.ts'
import type { DoorSseState, Session } from './session.ts'

const SSE_REFRESH_DEBOUNCE_MS = 500

function doorSseState(s: Session, door: Door): DoorSseState {
  let state = s.sseStates.get(door.name)
  if (state === undefined) {
    state = { attempt: 0, connected: false }
    s.sseStates.set(door.name, state)
  }
  return state
}

function anySseConnected(s: Session): boolean {
  return [...s.sseStates.values()].some((state) => state.connected)
}

function effectivePollMs(s: Session): number {
  return effectivePollSeconds(getPollSeconds(), anySseConnected(s)) * MS_PER_SECOND
}

export function restartPollTimer(s: Session): void {
  if (s.pollTimer !== undefined) {
    clearInterval(s.pollTimer)
    s.pollTimer = undefined
  }
  const ms = effectivePollMs(s)
  if (ms > 0) {
    s.pollTimer = setInterval(() => {
      if (!s.poller.busy) {
        s.background(s.poller.pollNow())
      }
    }, ms)
  }
  s.background(s.poller.pollNow())
}

/** Re-polls at most every `SSE_REFRESH_DEBOUNCE_MS` -- a burst of events (several engines changing at once) triggers one refetch, not one per frame. */
function scheduleSseRefresh(s: Session): void {
  if (s.sseRefreshTimer !== undefined) {
    clearTimeout(s.sseRefreshTimer)
  }
  s.sseRefreshTimer = setTimeout(() => {
    s.sseRefreshTimer = undefined
    s.background(s.poller.pollNow())
    s.background(s.engineExplorer.refresh())
  }, SSE_REFRESH_DEBOUNCE_MS)
}

function scheduleSseReconnect(s: Session, door: Door): void {
  const state = doorSseState(s, door)
  if (state.reconnectTimer !== undefined) {
    return
  }
  const reconnectDelayMs = backoffMs(state.attempt)
  state.attempt += 1
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = undefined
    s.background(connectEngineEvents(s, door))
  }, reconnectDelayMs)
}

/** Opens `GET /engined/v1/engines/events` against one door and stays connected until it errors or the extension deactivates, reconnecting with backoff either way. */
async function connectEngineEvents(s: Session, door: Door): Promise<void> {
  const state = doorSseState(s, door)
  const controller = new AbortController()
  state.abort = controller
  let stream: ReadableStream<Uint8Array>
  try {
    stream = await openEngineEventsStream(door.url, controller.signal)
  } catch (error) {
    if (!controller.signal.aborted) {
      s.log(`engine events stream (${door.name}): ${describeError(error)}`)
      scheduleSseReconnect(s, door)
    }
    return
  }
  state.connected = true
  state.attempt = 0
  restartPollTimer(s)
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseSseChunk(buffer)
      buffer = parsed.rest
      if (parsed.frames.length > 0) {
        scheduleSseRefresh(s)
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      s.log(`engine events stream error (${door.name}): ${describeError(error)}`)
    }
  }
  state.connected = false
  restartPollTimer(s)
  if (!controller.signal.aborted) {
    scheduleSseReconnect(s, door)
  }
}

/** Connects the events stream for every configured door. */
export async function connectAllEngineEvents(s: Session): Promise<void> {
  await Promise.all(getDoors().map((door) => connectEngineEvents(s, door)))
}

export function stopEngineEvents(s: Session): void {
  for (const state of s.sseStates.values()) {
    state.abort?.abort()
    state.abort = undefined
    state.connected = false
    if (state.reconnectTimer !== undefined) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = undefined
    }
  }
  if (s.sseRefreshTimer !== undefined) {
    clearTimeout(s.sseRefreshTimer)
    s.sseRefreshTimer = undefined
  }
}
