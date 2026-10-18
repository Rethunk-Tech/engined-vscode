/**
 * Request body and reply parse for `POST /engined/v1/tokenize`.
 * No `vscode` import -- `doorClient.ts` posts it.
 */

/** Body of `POST /engined/v1/tokenize`. */
export function tokenizeRequestBody(
  model: string,
  content: string,
): { model: string; content: string } {
  return { model, content }
}

/** Reads `tokens` from a tokenize JSON reply. */
export function parseTokenizeReply(data: unknown): number {
  if (data !== null && typeof data === 'object' && 'tokens' in data) {
    const { tokens } = data as { tokens: unknown }
    if (typeof tokens === 'number' && Number.isFinite(tokens)) {
      return tokens
    }
  }
  throw new Error('tokenize reply missing tokens')
}
