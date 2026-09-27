import type { UpdateStatus } from '../types'

/**
 * A deadline for the update check.
 *
 * `autoUpdater.checkForUpdates()` has none of its own: a feed that accepts the connection and never
 * answers (a captive portal, a proxy holding the request) left the titlebar saying "Checking for
 * updates…" for as long as the app ran, and a person who pressed the button got no answer at all.
 * The check itself is not cancelled — electron-updater offers no way to — but the app stops waiting
 * for it, says so in the log, and puts the screen back.
 */
export const UPDATE_CHECK_TIMEOUT_MS = 30_000

/** Runs the check and answers its result, or `'timedOut'` at the deadline (calling onTimeout once).
 *  A check that rejects before the deadline still rejects — the updater's error event reports it — and
 *  one that rejects after is observed here, so it never becomes an unhandled rejection. */
export function checkWithTimeout<T>(
  check: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<T | 'timedOut'> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<'timedOut'>((resolve) => {
    timer = setTimeout(() => {
      onTimeout()
      resolve('timedOut')
    }, timeoutMs)
  })
  let running: Promise<T>
  try {
    running = check()
  } catch (err) {
    running = Promise.reject(err)
  }
  running.catch(() => {}) // a rejection after the deadline has nobody else listening
  return Promise.race([running, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** What to push once a check has run out of time, given the last state pushed, whether the person
 *  asked for the check, and what was on screen when the check began (createUpdateStateTracker). Null
 *  means push nothing.
 *
 *  - An update that arrived during the check (available, downloading, downloaded, manual) is left
 *    alone — the check did its job and the late part is someone else's.
 *  - A download that was already finished before the check (downloaded, manual) comes back, for
 *    either kind of check: a periodic check over it must not hide the install button.
 *  - A check the person asked for otherwise gets an answer they can read: they are waiting on it.
 *  - An automatic check only undoes a "checking" it put up, back to what was there before (or
 *    `init`, which the titlebar shows as nothing). Automatic failures are not surfaced. */
export function afterCheckTimeout(
  lastState: UpdateStatus['state'] | null,
  userInitiated: boolean,
  before: UpdateStatus | null
): UpdateStatus | { state: 'error'; messageKey: 'update.checkTimedOut' } | null {
  if (lastState === 'available' || lastState === 'downloading' || lastState === 'downloaded' || lastState === 'manual')
    return null
  if (before && (before.state === 'downloaded' || before.state === 'manual')) return before
  if (userInitiated) return { state: 'error', messageKey: 'update.checkTimedOut' }
  return lastState === 'checking' ? (before ?? { state: 'init' }) : null
}

/** The update states main has pushed: the last one, and the one on screen when the current check
 *  began — what a timed-out check puts back. */
export function createUpdateStateTracker(): {
  record(s: UpdateStatus): void
  last(): UpdateStatus['state'] | null
  beforeCheck(): UpdateStatus | null
} {
  let last: UpdateStatus | null = null
  let before: UpdateStatus | null = null
  return {
    record(s) {
      if (s.state === 'checking' && last?.state !== 'checking') before = last
      last = s
    },
    last: () => last?.state ?? null,
    beforeCheck: () => before
  }
}
