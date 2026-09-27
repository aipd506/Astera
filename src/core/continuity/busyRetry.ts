// Asking a busy journal again without freezing the thread that asks (stage 3 T1). `node:sqlite` is
// synchronous, so a read waits at most its connection's busy timeout (the reader's is short,
// READER_BUSY_TIMEOUT_MS); the pauses between tries are the event loop's, so nothing freezes while the
// Host's writer finishes. Past the last try the answer is a failure that says busy, which a caller reads
// as "cannot say", never as "nothing there".
import { isBusyError } from './journal'

/** How many times a busy read is asked again, and the pause before each. */
export const JOURNAL_BUSY_RETRIES = 8
export const JOURNAL_BUSY_RETRY_MS = 250

export type Retried<T> = { ok: true; value: T } | { ok: false; busy: boolean; error: unknown }

export async function retryBusy<T>(
  read: () => T,
  o: {
    /** The pause; a timer when left out. Tests pass one that does not wait. */
    sleep?(ms: number): Promise<void>
    /** Called once, at the first busy answer: a spell of them is one log line. */
    onBusy?(err: unknown): void
  } = {}
): Promise<Retried<T>> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (let attempt = 0; ; attempt++) {
    try {
      return { ok: true, value: read() }
    } catch (err) {
      const busy = isBusyError(err)
      if (!busy || attempt >= JOURNAL_BUSY_RETRIES) return { ok: false, busy, error: err }
      if (attempt === 0) o.onBusy?.(err)
      await sleep(JOURNAL_BUSY_RETRY_MS)
    }
  }
}
