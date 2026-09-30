import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  checkWithTimeout,
  afterCheckTimeout,
  createUpdateStateTracker,
  UPDATE_CHECK_TIMEOUT_MS
} from './checkTimeout'

afterEach(() => {
  vi.useRealTimers()
})

// autoUpdater.checkForUpdates() had no deadline: a feed that never answered left the titlebar on
// "Checking for updates…" for good.
describe('checkWithTimeout', () => {
  it('the deadline is about 30 s', () => {
    expect(UPDATE_CHECK_TIMEOUT_MS).toBe(30_000)
  })

  it('answers the check when it finishes first', async () => {
    const onTimeout = vi.fn()
    await expect(checkWithTimeout(async () => 'result', 1_000, onTimeout)).resolves.toBe('result')
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('answers timedOut at the deadline and reports it once', async () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    let answer: unknown = null
    void checkWithTimeout(() => new Promise(() => {}), UPDATE_CHECK_TIMEOUT_MS, onTimeout).then(
      (a) => (answer = a)
    )
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS - 1)
    expect(answer).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(answer).toBe('timedOut')
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('a check that rejects still rejects (the error event reports it), and a late rejection is handled', async () => {
    await expect(
      checkWithTimeout(() => Promise.reject(new Error('net')), 1_000, () => {})
    ).rejects.toThrow('net')

    vi.useFakeTimers()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      let reject: (e: Error) => void = () => {}
      const late = new Promise<never>((_, r) => (reject = r))
      const raced = checkWithTimeout(() => late, 10, () => {})
      await vi.advanceTimersByTimeAsync(10)
      await expect(raced).resolves.toBe('timedOut')
      reject(new Error('late'))
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
      await new Promise((r) => setTimeout(r, 0))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

// What the titlebar and the settings modal are told when a check runs out of time.
describe('afterCheckTimeout', () => {
  const init = { state: 'init' as const, version: '1.0.0' }
  const downloaded = { state: 'downloaded' as const, version: '1.1.0' }

  it('a check the person asked for ends in an error they can read', () => {
    expect(afterCheckTimeout('checking', true, init)).toEqual({ state: 'error', messageKey: 'update.checkTimedOut' })
  })
  it('an automatic check puts back what was on screen before it — automatic failures are not surfaced', () => {
    expect(afterCheckTimeout('checking', false, init)).toEqual(init)
    expect(afterCheckTimeout('checking', false, null)).toEqual({ state: 'init' })
  })
  // A periodic check over a finished download must not hide the install button.
  it('a finished download before the check comes back, for either kind of check', () => {
    expect(afterCheckTimeout('checking', false, downloaded)).toEqual(downloaded)
    expect(afterCheckTimeout('checking', true, downloaded)).toEqual(downloaded)
    const manual = { state: 'manual' as const, version: '1.1.0' }
    expect(afterCheckTimeout('checking', false, manual)).toEqual(manual)
  })
  it('a check the person asked for is answered even if "checking" was never announced', () => {
    expect(afterCheckTimeout(null, true, null)).toEqual({ state: 'error', messageKey: 'update.checkTimedOut' })
    expect(afterCheckTimeout('uptodate', true, null)).toEqual({ state: 'error', messageKey: 'update.checkTimedOut' })
  })
  it('an automatic check that never showed "checking" leaves the screen alone', () => {
    expect(afterCheckTimeout('uptodate', false, init)).toBeNull()
    expect(afterCheckTimeout(null, false, null)).toBeNull()
  })
  it('nothing is pushed when an update is already on its way (a late event, a download under way)', () => {
    for (const s of ['available', 'downloading', 'downloaded', 'manual'] as const) {
      expect(afterCheckTimeout(s, true, init)).toBeNull()
      expect(afterCheckTimeout(s, false, init)).toBeNull()
    }
  })
})

describe('createUpdateStateTracker', () => {
  it('remembers the last state and what was on screen when a check began', () => {
    const tr = createUpdateStateTracker()
    expect(tr.last()).toBeNull()
    expect(tr.beforeCheck()).toBeNull()
    tr.record({ state: 'downloaded', version: '1.1.0' })
    tr.record({ state: 'checking' })
    expect(tr.last()).toBe('checking')
    expect(tr.beforeCheck()).toEqual({ state: 'downloaded', version: '1.1.0' })
    // a second "checking" in a row does not overwrite it with "checking"
    tr.record({ state: 'checking' })
    expect(tr.beforeCheck()).toEqual({ state: 'downloaded', version: '1.1.0' })
  })
})
