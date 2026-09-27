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

/** What to push once a check has run out of time, given the last state pushed and whether the person
 *  asked for the check. Null means push nothing.
 *
 *  - An update already on its way (available, downloading, downloaded, manual) is left alone — the
 *    check did its job and the late part is someone else's.
 *  - A check the person asked for gets an answer they can read, whatever the screen said before:
 *    they are waiting on the settings button.
 *  - An automatic check only clears a "checking" it put up. Automatic failures are not surfaced (the
 *    error handler's rule), so it goes back to `init`, which the titlebar shows as nothing. */
export function afterCheckTimeout(
  lastState: UpdateStatus['state'] | null,
  userInitiated: boolean
): { state: 'error'; messageKey: 'update.checkTimedOut' } | { state: 'init' } | null {
  if (lastState === 'available' || lastState === 'downloading' || lastState === 'downloaded' || lastState === 'manual')
    return null
  if (userInitiated) return { state: 'error', messageKey: 'update.checkTimedOut' }
  return lastState === 'checking' ? { state: 'init' } : null
}
