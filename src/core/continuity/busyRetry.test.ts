import { describe, it, expect } from 'vitest'
import { JOURNAL_BUSY_RETRIES, JOURNAL_BUSY_RETRY_MS, retryBusy } from './busyRetry'

const busy = (): Error => Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })

describe('retryBusy (stage 3 T1)', () => {
  it('answers at once when the read works, and waits nothing', async () => {
    const sleeps: number[] = []
    expect(await retryBusy(() => 7, { sleep: async (ms) => void sleeps.push(ms) })).toEqual({ ok: true, value: 7 })
    expect(sleeps).toEqual([])
  })

  it('asks a busy journal again after a pause on the event loop, and the read that works answers', async () => {
    const sleeps: number[] = []
    const busyNotes: unknown[] = []
    let left = 2
    const r = await retryBusy(
      () => {
        if (left-- > 0) throw busy()
        return 'head'
      },
      { sleep: async (ms) => void sleeps.push(ms), onBusy: (e) => busyNotes.push(e) }
    )
    expect(r).toEqual({ ok: true, value: 'head' })
    expect(sleeps).toEqual([JOURNAL_BUSY_RETRY_MS, JOURNAL_BUSY_RETRY_MS])
    expect(busyNotes).toHaveLength(1)
  })

  it('busy past every retry is a failure that says busy; any other error fails at once', async () => {
    const sleeps: number[] = []
    const stuck = await retryBusy(() => {
      throw busy()
    }, { sleep: async (ms) => void sleeps.push(ms) })
    expect(stuck).toMatchObject({ ok: false, busy: true })
    expect(sleeps).toHaveLength(JOURNAL_BUSY_RETRIES)
    sleeps.length = 0
    const broken = await retryBusy(() => {
      throw new Error('no such table')
    }, { sleep: async (ms) => void sleeps.push(ms) })
    expect(broken).toMatchObject({ ok: false, busy: false })
    expect(sleeps).toEqual([])
  })

  it('stops at once, still busy, when its caller says to stop before a pause (stage 4 T6)', async () => {
    const sleeps: number[] = []
    let tries = 0
    const r = await retryBusy(
      () => {
        tries += 1
        throw busy()
      },
      { sleep: async (ms) => void sleeps.push(ms), stop: () => tries >= 3 }
    )
    expect(r).toMatchObject({ ok: false, busy: true })
    expect(tries).toBe(3)
    expect(sleeps).toHaveLength(2)
  })
})
