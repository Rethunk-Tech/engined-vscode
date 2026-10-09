/**
 * Terminates an exhaustive `switch`. The parameter is `never`, so adding a
 * variant to the discriminated union turns the default branch into a compile
 * error instead of a silent fallthrough.
 */
export function unreachable(value: never): never {
  throw new Error(`Unhandled variant: ${String(value)}`)
}
