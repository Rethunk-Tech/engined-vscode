/**
 * The only place that actually talks to the engined door over HTTP. No
 * `vscode` import: `extension.ts` supplies the URL and abort signal, which
 * keeps this file testable in isolation even though no test currently mocks
 * the network.
 */

import type { EnginedModelInfo } from './door.ts'
import { mapModels } from './door.ts'

export class DoorHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** `GET /openai/v1/models`, mapped to what this extension exposes. Never triggers a model load: listing is always safe to poll. */
export async function fetchModels(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<EnginedModelInfo[]> {
  const res = await fetch(`${baseUrl}/openai/v1/models`, { signal })
  if (!res.ok) {
    throw new DoorHttpError(res.status, await res.text())
  }
  return mapModels(await res.json())
}

/** POST a chat completion. Non-2xx surfaces the door's own error text (never a generic status message) so the chat view shows what actually went wrong. */
export async function postChatCompletion(
  baseUrl: string,
  body: unknown,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || res.body === null) {
    throw new DoorHttpError(res.status, await res.text())
  }
  return res.body
}

/** A JSON POST against an arbitrary door path -- image generation/edit request, speech request, completions request. */
export async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    throw new DoorHttpError(res.status, await res.text())
  }
  return res.headers.get('content-type')?.includes('application/json')
    ? res.json()
    : res.arrayBuffer()
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
