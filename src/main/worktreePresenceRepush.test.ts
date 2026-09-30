import { describe, expect, it, vi } from 'vitest'
import { createPresenceRepush } from './worktreePresenceRepush'

/** Collects scheduled callbacks so the test decides when they run. */
function manualScheduler(): { schedule: (fn: () => void) => void; run: () => void; size: () => number } {
  const q: Array<() => void> = []
  return { schedule: (fn) => q.push(fn), run: () => q.splice(0).forEach((f) => f()), size: () => q.length }
}

describe('createPresenceRepush', () => {
  it('coalesces several answers into one push of the state current at fire time', () => {
    const sched = manualScheduler()
    let state: { v: number } | null = { v: 1 }
    const push = vi.fn()
    const onChange = createPresenceRepush({ current: () => state, push, log: () => {}, schedule: sched.schedule })
    onChange()
    onChange()
    onChange()
    expect(sched.size()).toBe(1)
    state = { v: 2 }
    sched.run()
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith({ v: 2 })
    // After it fired, the next answer schedules again
    onChange()
    expect(sched.size()).toBe(1)
  })

  it('pushes nothing when there is no state yet', () => {
    const sched = manualScheduler()
    const push = vi.fn()
    const onChange = createPresenceRepush({ current: () => null, push, log: () => {}, schedule: sched.schedule })
    onChange()
    sched.run()
    expect(push).not.toHaveBeenCalled()
  })

  it('a throwing state read or push is logged, never thrown out of the timer', () => {
    const sched = manualScheduler()
    const log = vi.fn()
    const onChange = createPresenceRepush({
      current: () => {
        throw new Error('mirror not loaded')
      },
      push: () => {},
      log,
      schedule: sched.schedule
    })
    onChange()
    expect(() => sched.run()).not.toThrow()
    expect(log).toHaveBeenCalledTimes(1)
    // and the latch was released, so a later answer schedules again
    onChange()
    expect(sched.size()).toBe(1)
  })
})
