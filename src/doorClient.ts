/**
 * The only place that actually talks to the engined door over HTTP. No
 * `vscode` import: `extension.ts` supplies the URL and abort signal, which
 * keeps this file testable in isolation even though no test currently mocks
 * the network.
 */

import type { EnginedModelInfo, EnginedModelRow } from './door.ts'
import { mapAnswerableRows, mapModels } from './door.ts'

export class DoorHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface ModelsPoll {
  /** The chat-answerable subset -- what the `LanguageModelChatProvider` reports. */
  chatModels: EnginedModelInfo[]
  /** Every answerable row, chat or not -- what a tool or the completions picker chooses from. */
  rows: EnginedModelRow[]
}

/** `GET /openai/v1/models`, mapped both ways. Never triggers a model load: listing is always safe to poll. */
export async function fetchModels(baseUrl: string, signal?: AbortSignal): Promise<ModelsPoll> {
  const res = await fetch(`${baseUrl}/openai/v1/models`, { signal })
  if (!res.ok) {
    throw new DoorHttpError(res.status, await res.text())
  }
  const body = await res.json()
  return { chatModels: mapModels(body), rows: mapAnswerableRows(body) }
}

export interface DoorResponse<T> {
  data: T
  headers: Headers
}

/** POST a chat completion. Non-2xx surfaces the door's own error text (never a generic status message) so the chat view shows what actually went wrong. Headers ride along so the caller can read `x-engined-route`/`-egress`/`-chain`, when engined sends them. */
export async function postChatCompletion(
  baseUrl: string,
  body: unknown,
  signal: AbortSignal,
): Promise<{ body: ReadableStream<Uint8Array>; headers: Headers }> {
  const res = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
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

/** A multipart POST -- image edit, transcription. */
export async function postForm(baseUrl: string, path: string, form: FormData): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', body: form })
  if (!res.ok) {
    throw new DoorHttpError(res.status, await res.text())
  }
  return res.headers.get('content-type')?.includes('application/json')
    ? res.json()
    : res.arrayBuffer()
}
