/**
 * The only place that actually talks to the engined door over HTTP. No
 * `vscode` import: `extension.ts` supplies the URL and abort signal, which
 * keeps this file testable in isolation even though no test currently mocks
 * the network.
 */

import type { Door, DoorReachability, EnginedModelInfo, EnginedModelRow } from './door.ts'
import { mapAnswerableRows, mapModels } from './door.ts'

/** OpenAI `{error:{message}}` or the older `{error:"..."}` string. */
export function doorErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') {
    return error
  }
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === 'string') {
      return message
    }
  }
  return undefined
}

function messageFromRawBody(raw: string): string {
  try {
    const body = JSON.parse(raw) as { error?: unknown }
    return doorErrorMessage(body.error) ?? raw
  } catch {
    return raw
  }
}

export class DoorHttpError extends Error {
  constructor(
    readonly status: number,
    rawBody: string,
  ) {
    super(messageFromRawBody(rawBody))
  }
}

/** Message Copilot's chat view shows when the door answers 429 for an agentic-launch cap. */
export function agenticBusyMessage(retryAfterSeconds: number): string {
  return `engined is busy (agentic launches at capacity), retry in ${retryAfterSeconds} s`
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get('retry-after')
  if (raw === null) {
    return undefined
  }
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface ModelsPoll {
  /** The chat-answerable subset -- what the `LanguageModelChatProvider` reports. */
  chatModels: EnginedModelInfo[]
  /** Every answerable row, chat or not -- what a tool or the completions picker chooses from. */
  rows: EnginedModelRow[]
}

/** `GET /openai/v1/models` against one door, mapped both ways and qualified against it. Never triggers a model load: listing is always safe to poll. */
export async function fetchModels(
  door: Door,
  doorCount: number,
  signal?: AbortSignal,
): Promise<ModelsPoll> {
  const res = await fetch(`${door.url}/openai/v1/models`, { signal })
  if (!res.ok) {
    throw new DoorHttpError(res.status, await res.text())
  }
  const body = await res.json()
  return {
    chatModels: mapModels(body, door, doorCount),
    rows: mapAnswerableRows(body, door, doorCount),
  }
}

export interface DoorsPoll extends ModelsPoll {
  /** One entry per configured door, in `doors`' own order -- the status popup's one reachability line per door. */
  doorStatus: DoorReachability[]
}

/** Polls every configured door and merges the reachable ones' rows/models. A door that fails contributes nothing, not a thrown error -- one down door must not blank out the rest. */
export async function fetchAllDoors(
  doors: readonly Door[],
  signal?: AbortSignal,
): Promise<DoorsPoll> {
  const results = await Promise.allSettled(
    doors.map((door) => fetchModels(door, doors.length, signal)),
  )
  const chatModels: EnginedModelInfo[] = []
  const rows: EnginedModelRow[] = []
  const doorStatus: DoorReachability[] = doors.map((door, i) => {
    const result = results[i]
    if (result?.status === 'fulfilled') {
      chatModels.push(...result.value.chatModels)
      rows.push(...result.value.rows)
      return { door, reachable: true }
    }
    return { door, reachable: false }
  })
  return { chatModels, rows, doorStatus }
}

/** `GET /engined/v1/engines`, unparsed beyond JSON -- `engineTree.ts` maps it to tree rows. */
export async function fetchEngines(baseUrl: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${baseUrl}/engined/v1/engines`, { signal })
  if (!res.ok) {
    throw new DoorHttpError(res.status, await res.text())
  }
  return res.json()
}

/** `GET /engined/v1/engines/<id>/logs`, the engine's own stdout/stderr lines -- never a prompt or reply. */
export async function fetchEngineLogs(
  baseUrl: string,
  id: string,
  tail: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const res = await fetch(`${baseUrl}/engined/v1/engines/${id}/logs?tail=${tail}`, { signal })
  if (!res.ok) {
    throw new DoorHttpError(res.status, await res.text())
  }
  const body = (await res.json()) as { lines?: string[] }
  return body.lines ?? []
}

export interface EngineResources {
  memory_bytes: number | null
  graphics_bytes: number | null
}

/** `GET /engined/v1/engines/<id>/resources`. A stopped engine is 404 with `{error}`; that message is returned, not thrown, since "not running" is a normal answer here. */
export async function fetchEngineResources(
  baseUrl: string,
  id: string,
  signal?: AbortSignal,
): Promise<EngineResources | { error: string }> {
  const res = await fetch(`${baseUrl}/engined/v1/engines/${id}/resources`, { signal })
  const raw = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new DoorHttpError(res.status, raw)
  }
  if (parsed !== null && typeof parsed === 'object' && 'error' in parsed) {
    const message = doorErrorMessage((parsed as { error: unknown }).error)
    if (message !== undefined) {
      return { error: message }
    }
  }
  if (!res.ok) {
    throw new DoorHttpError(res.status, raw)
  }
  return parsed as EngineResources
}

/** `POST /engined/v1/engines/<id>/stop`. */
export async function stopEngine(baseUrl: string, id: string, signal?: AbortSignal): Promise<void> {
  await postJson(baseUrl, `/engined/v1/engines/${id}/stop`, {}, signal)
}

/** `POST /engined/v1/tokenize`: a vocab-only token count for a route that lists it in `serves`, no engine started. */
export async function postTokenize(
  baseUrl: string,
  model: string,
  content: string,
  signal?: AbortSignal,
): Promise<number> {
  const data = (await postJson(baseUrl, '/engined/v1/tokenize', { model, content }, signal)) as {
    tokens: number
  }
  return data.tokens
}

export interface StartRow {
  address: string
  engine: string
  upstream: string | null
  state: string
  started: boolean
  fix?: string
}

/** `POST /engined/v1/start`: starts (or reports) every route `model` resolves to. */
export async function startModel(
  baseUrl: string,
  model: string,
  signal?: AbortSignal,
): Promise<StartRow[]> {
  const data = (await postJson(baseUrl, '/engined/v1/start', { model }, signal)) as {
    data?: StartRow[]
  }
  return data.data ?? []
}

/** `POST /engined/v1/engines/<id>/hold`, optionally for fewer than engined's own default seconds. */
export async function holdEngine(
  baseUrl: string,
  id: string,
  seconds?: number,
  signal?: AbortSignal,
): Promise<void> {
  const query = seconds === undefined ? '' : `?seconds=${seconds}`
  await postJson(baseUrl, `/engined/v1/engines/${id}/hold${query}`, {}, signal)
}

/** `POST /engined/v1/engines/<id>/unhold`: ends a hold early. */
export async function unholdEngine(
  baseUrl: string,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  await postJson(baseUrl, `/engined/v1/engines/${id}/unhold`, {}, signal)
}

/** `GET /engined/v1/engines/events`: the live SSE body, unparsed -- `engineEvents.ts` reads the frames out of it. */
export async function openEngineEventsStream(
  baseUrl: string,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(`${baseUrl}/engined/v1/engines/events`, {
    signal,
    headers: { accept: 'text/event-stream' },
  })
  if (!res.ok || res.body === null) {
    throw new DoorHttpError(res.status, await res.text())
  }
  return res.body
}

export interface DoorResponse<T> {
  data: T
  headers: Headers
}

function busyError(status: number, seconds: number): DoorHttpError {
  return new DoorHttpError(
    status,
    JSON.stringify({ error: { message: agenticBusyMessage(seconds) } }),
  )
}

/** POST a chat completion. Non-2xx surfaces the door's own error text (never a generic status message) so the chat view shows what actually went wrong. Headers ride along so the caller can read `x-engined-route`/`-egress`/`-chain`, when engined sends them. A 429 from the agentic-launch cap retries once when `Retry-After` is at most 10 s. */
export async function postChatCompletion(
  baseUrl: string,
  body: unknown,
  signal: AbortSignal,
): Promise<{ body: ReadableStream<Uint8Array>; headers: Headers }> {
  const send = (): Promise<Response> =>
    fetch(`${baseUrl}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  let res = await send()
  if (res.status === 429) {
    const wait = retryAfterSeconds(res.headers)
    await res.arrayBuffer()
    if (wait !== undefined && wait <= 10) {
      await delay(wait * 1000, signal)
      res = await send()
    }
    if (res.status === 429) {
      throw busyError(429, retryAfterSeconds(res.headers) ?? wait ?? 0)
    }
  }
  if (!res.ok || res.body === null) {
    throw new DoorHttpError(res.status, await res.text())
  }
  return { body: res.body, headers: res.headers }
}

/** A JSON POST against an arbitrary door path, with response headers -- used where a caller needs to read them (route/egress on a completions reply). */
export async function postJsonWithHeaders(
  baseUrl: string,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<DoorResponse<unknown>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    throw new DoorHttpError(res.status, await res.text())
  }
  const data = res.headers.get('content-type')?.includes('application/json')
    ? await res.json()
    : await res.arrayBuffer()
  return { data, headers: res.headers }
}

/** A JSON POST against an arbitrary door path -- image generation/edit request, speech request. */
export async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return (await postJsonWithHeaders(baseUrl, path, body, signal)).data
}

/** `POST /openai/v1/embeddings`, unwrapped to one vector per input string, in `input`'s own order. */
export async function postEmbeddings(
  baseUrl: string,
  model: string,
  input: readonly string[],
  signal?: AbortSignal,
): Promise<(number[] | undefined)[]> {
  if (input.length === 0) {
    return []
  }
  const data = (await postJson(baseUrl, '/openai/v1/embeddings', { model, input }, signal)) as {
    data?: { embedding: number[]; index: number }[]
  }
  const vectors: (number[] | undefined)[] = new Array(input.length).fill(undefined)
  for (const row of data.data ?? []) {
    if (row.index >= 0 && row.index < vectors.length) {
      vectors[row.index] = row.embedding
    }
  }
  return vectors
}

export interface RerankResult {
  index: number
  score?: number
}

/** `POST /openai/v1/rerank`: a query against a document list, scored and ordered by the reranker's own reply. */
export async function postRerank(
  baseUrl: string,
  model: string,
  query: string,
  documents: readonly string[],
  signal?: AbortSignal,
): Promise<RerankResult[]> {
  const data = (await postJson(
    baseUrl,
    '/openai/v1/rerank',
    { model, query, documents },
    signal,
  )) as { results?: RerankResult[] }
  return data.results ?? []
}

export interface UsageRow {
  date: string
  route: string
  requests: number
  ok: number
  failed: number
  prompt_tokens?: number
  completion_tokens?: number
  cost_usd?: number
  duration_ms: number
  egress?: string
}

export type DoorUsage =
  | { door: Door; status: 'ok'; rows: UsageRow[] }
  | { door: Door; status: 'unsupported' }
  | { door: Door; status: 'unreachable' }

/** `GET /engined/v1/usage?days=N` against one door. A 404 (this door predates the route) and any other failure are reported on the result, never thrown -- one door's gap must not blank out the usage report. */
export async function fetchUsage(
  door: Door,
  days: number,
  signal?: AbortSignal,
): Promise<DoorUsage> {
  try {
    const res = await fetch(`${door.url}/engined/v1/usage?days=${days}`, { signal })
    if (res.status === 404) {
      return { door, status: 'unsupported' }
    }
    if (!res.ok) {
      return { door, status: 'unreachable' }
    }
    const body = (await res.json()) as { data: UsageRow[] }
    return { door, status: 'ok', rows: body.data }
  } catch {
    return { door, status: 'unreachable' }
  }
}

/** Every configured door's usage, in `doors`' own order. */
export async function fetchAllUsage(
  doors: readonly Door[],
  days: number,
  signal?: AbortSignal,
): Promise<DoorUsage[]> {
  return Promise.all(doors.map((door) => fetchUsage(door, days, signal)))
}

/** A multipart POST -- image edit, transcription. */
export async function postForm(
  baseUrl: string,
  path: string,
  form: FormData,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', body: form, signal })
  if (!res.ok) {
    throw new DoorHttpError(res.status, await res.text())
  }
  return res.headers.get('content-type')?.includes('application/json')
    ? res.json()
    : res.arrayBuffer()
}
