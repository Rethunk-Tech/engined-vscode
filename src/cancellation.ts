/** The part of a `vscode.CancellationToken` the tools read; any token satisfies it. */
export interface CancellationLike {
  readonly isCancellationRequested: boolean
  onCancellationRequested(listener: () => void): unknown
}

/** An `AbortSignal` that fires when the user cancels the tool call. */
export function cancellationSignal(token: CancellationLike): AbortSignal {
  const controller = new AbortController()
  if (token.isCancellationRequested) {
    controller.abort()
  } else {
    token.onCancellationRequested(() => controller.abort())
  }
  return controller.signal
}
