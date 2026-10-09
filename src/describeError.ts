import { HTTP_TOO_MANY_REQUESTS } from './constants.ts'
import { DoorHttpError } from './doorClient.ts'

/** The line chat views, logs and tool results show for a thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof DoorHttpError) {
    return error.status === HTTP_TOO_MANY_REQUESTS
      ? error.message
      : `HTTP ${error.status}: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}
