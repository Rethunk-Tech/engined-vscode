/**
 * Starts `work` without waiting for it. A rejection goes to `onError` rather than
 * surfacing as an unhandled rejection that VS Code's extension host reports as a crash.
 */
export function runInBackground(
  work: PromiseLike<unknown>,
  onError: (error: unknown) => void,
): void {
  work.then(undefined, onError)
}
