import { postJsonWithHeaders } from './doorClient.ts'

const OBTAIN_EXIT_EVENT = /^event: exit\ndata: (.*)$/m

/**
 * `POST /engined/v1/engines/<id>/obtain`: pull a missing image or artifact. The door streams the
 * command's output as SSE and ends with an `exit` event; throws when that event is absent or its
 * `exitCode` is not 0.
 */
export async function obtainEngine(
  baseUrl: string,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  const { data } = await postJsonWithHeaders(
    baseUrl,
    `/engined/v1/engines/${encodeURIComponent(id)}/obtain`,
    {},
    signal,
  )
  const text = data instanceof ArrayBuffer ? new TextDecoder().decode(data) : ''
  const exit = OBTAIN_EXIT_EVENT.exec(text)?.[1]
  const exitCode =
    exit === undefined ? undefined : (JSON.parse(exit) as { exitCode?: number }).exitCode
  if (exitCode !== 0) {
    throw new Error(`obtain exited with code ${exitCode ?? 'unknown'}`)
  }
}
