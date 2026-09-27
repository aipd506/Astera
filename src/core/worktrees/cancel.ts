/** Cancelling a worktree creation. One error shape for every stage, so the caller (and the renderer's
 *  worktreeErrors.ts) can tell "the person stopped it" from "it failed". */
export const CANCELLED_CODE = 'WORKTREE_CANCELLED'

export function cancelledError(): Error {
  return new Error(`${CANCELLED_CODE}: worktree creation was cancelled`)
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError()
}

export function isCancelledError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith(CANCELLED_CODE)
}
