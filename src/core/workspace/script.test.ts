import { afterEach, describe, it, expect, vi } from 'vitest'
import { LAUNCH_WAIT_MAX_MS, ScriptDeadline, ScriptSlots, gateHelpers, runWorkspaceScript } from './script'

describe('ScriptSlots', () => {
  it('holds one script per session', () => {
    const slots = new ScriptSlots()
    const a = slots.begin('s1')
    expect(a).not.toBeNull()
    expect(slots.begin('s1')).toBeNull()
    expect(slots.begin('s2')).not.toBeNull()
    expect(slots.isRunning('s1')).toBe(true)
    expect(slots.stop('s1')).toBe(true)
    expect(a!.signal.aborted).toBe(true)
    slots.end('s1', a!)
    expect(slots.isRunning('s1')).toBe(false)
    expect(slots.stop('s1')).toBe(false)
  })

  it('end with a stale controller does not free a newer run', () => {
    const slots = new ScriptSlots()
    const a = slots.begin('s1')!
    slots.end('s1', a)
    const b = slots.begin('s1')!
    slots.end('s1', a)
    expect(slots.isRunning('s1')).toBe(true)
    slots.end('s1', b)
  })
})

describe('runWorkspaceScript', () => {
  it('returns what the script logged, and reports each helper while it runs', async () => {
    const seen: Array<string | null> = []
    const stop = new AbortController()
    const r = await runWorkspaceScript({
      script: "await windows(); log('done')",
      stop: stop.signal,
      onHelper: (n) => seen.push(n),
      helpers: (ctx) => ({ windows: async () => { ctx.at = 'windows'; return [] } })
    })
    expect(r).toEqual({ log: ['done'] })
    expect(seen).toEqual(['windows', null])
  })

  it('a thrown error names the helper that was running', async () => {
    const r = await runWorkspaceScript({
      script: 'await launch({})',
      stop: new AbortController().signal,
      onHelper: () => {},
      helpers: (ctx) => ({ launch: async () => { ctx.at = 'launch'; throw new Error('launch: bad') } })
    })
    expect(r.error).toEqual({ message: 'launch: bad', at: 'launch' })
  })

  it('Stop ends the script at "stopped" and parks whatever the body calls next', async () => {
    const stop = new AbortController()
    const after = vi.fn()
    let release!: () => void
    const running = runWorkspaceScript({
      script: 'await wait(); await next()',
      stop: stop.signal,
      onHelper: () => {},
      helpers: (ctx) => ({
        wait: () => { ctx.at = 'wait'; return new Promise<void>((r) => { release = r }) },
        next: async () => after()
      })
    })
    await new Promise((r) => setTimeout(r, 10))
    stop.abort()
    const r = await running
    expect(r.error).toEqual({ message: 'stopped', at: 'stopped' })
    release()
    await new Promise((r) => setTimeout(r, 10))
    expect(after).not.toHaveBeenCalled()
  })

  it('the whole script has a deadline', async () => {
    const r = await runWorkspaceScript({
      script: 'await forever()',
      stop: new AbortController().signal,
      onHelper: () => {},
      timeoutMs: 30,
      helpers: () => ({ forever: () => new Promise(() => {}) })
    })
    expect(r.error?.at).toBe('timeout')
  })
})

describe('gateHelpers', () => {
  it('a synchronous helper throws once the run is over, an async one parks', () => {
    const ac = new AbortController()
    ac.abort()
    const g = gateHelpers({ help: () => 'x', launch: async () => 1 }, { at: 'script' }, ac.signal, () => {}) as Record<string, () => unknown>
    expect(() => g.help()).toThrow('stopped')
    expect(g.launch()).toBeInstanceOf(Promise)
  })

  it('a mirror listener that throws does not fail the helper', async () => {
    const g = gateHelpers({ url: async () => 'u' }, { at: 'script' }, new AbortController().signal, () => {
      throw new Error('mirror down')
    }) as Record<string, () => Promise<string>>
    await expect(g.url()).resolves.toBe('u')
  })
})

// The script's deadline counts only time outside launch waits (stage 4, task 2): a first dev build can
// take longer than a whole script may run, and the wait for it must not be what ends the script.
describe('ScriptDeadline', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const make = (timeoutMs = 60_000) => {
    vi.useFakeTimers()
    const expired = vi.fn()
    const clock = new ScriptDeadline({ timeoutMs, onExpire: expired })
    return { clock, expired }
  }

  // Stage 4 final review: with timeoutMs <= 0 it expired inside the constructor, before the caller had
  // wired what expiry should do (scriptWorker.ts sets `expire` after), so the script never timed out.
  it('with a timeout of 0 or less, expires on the next turn, after the caller has wired it', () => {
    for (const timeoutMs of [0, -5]) {
      vi.useFakeTimers()
      let expire = (): void => {}
      const hit = vi.fn()
      const clock = new ScriptDeadline({ timeoutMs, onExpire: () => expire() })
      expire = hit
      expect(hit).not.toHaveBeenCalled()
      vi.advanceTimersByTime(0)
      expect(hit).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(600_000)
      expect(hit).toHaveBeenCalledTimes(1)
      clock.dispose()
      vi.useRealTimers()
    }
  })

  it('a deadline disposed before that turn never expires', () => {
    const { clock, expired } = make(0)
    clock.dispose()
    vi.advanceTimersByTime(1_000)
    expect(expired).not.toHaveBeenCalled()
  })

  it('the cap on launch waits is five minutes, and a launch may ask for all of it', () => {
    expect(LAUNCH_WAIT_MAX_MS).toBe(300_000)
  })

  it('with no launch wait, expires at the timeout, once', () => {
    const { clock, expired } = make()
    vi.advanceTimersByTime(59_999)
    expect(expired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(expired).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(600_000)
    expect(expired).toHaveBeenCalledTimes(1)
    clock.dispose()
  })

  it('a launch wait of 90 s does not count: the script still has its 60 s after it', () => {
    const { clock, expired } = make()
    vi.advanceTimersByTime(10_000)
    const wait = clock.launchWait()
    // What the wait may last: the rest of the launch cap plus the script's own time left.
    expect(wait.leftMs).toBe(LAUNCH_WAIT_MAX_MS + 50_000)
    vi.advanceTimersByTime(90_000)
    expect(expired).not.toHaveBeenCalled()
    wait.end()
    vi.advanceTimersByTime(49_999)
    expect(expired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(expired).toHaveBeenCalledTimes(1)
    clock.dispose()
  })

  it('a busy loop after a long launch is still cut at 60 s of time outside launch waits', () => {
    const { clock, expired } = make()
    const wait = clock.launchWait()
    vi.advanceTimersByTime(200_000)
    wait.end()
    // The script spins from here: nothing it does stops the clock again.
    vi.advanceTimersByTime(60_000)
    expect(expired).toHaveBeenCalledTimes(1)
    clock.dispose()
  })

  it('launch waits past the cap count against the script again, so a wait never holds it forever', () => {
    const { clock, expired } = make()
    const wait = clock.launchWait()
    vi.advanceTimersByTime(LAUNCH_WAIT_MAX_MS + 59_999)
    expect(expired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(expired).toHaveBeenCalledTimes(1)
    wait.end()
    clock.dispose()
  })

  it('the cap is for the whole run: a second wait gets only what the first left', () => {
    const { clock, expired } = make()
    const first = clock.launchWait()
    vi.advanceTimersByTime(250_000)
    first.end()
    const second = clock.launchWait()
    expect(second.leftMs).toBe(50_000 + 60_000)
    vi.advanceTimersByTime(110_000)
    expect(expired).toHaveBeenCalledTimes(1)
    second.end()
    clock.dispose()
  })

  it('two waits at once pause the clock once, until both end; end is idempotent', () => {
    const { clock, expired } = make()
    const a = clock.launchWait()
    const b = clock.launchWait()
    vi.advanceTimersByTime(100_000)
    a.end()
    a.end()
    vi.advanceTimersByTime(100_000)
    expect(expired).not.toHaveBeenCalled()
    b.end()
    vi.advanceTimersByTime(60_000)
    expect(expired).toHaveBeenCalledTimes(1)
    clock.dispose()
  })

  it('a launch wait begun after the run is over may last nothing, so a leftover launch never waits minutes', () => {
    const { clock, expired } = make()
    clock.dispose()
    const wait = clock.launchWait()
    expect(wait.leftMs).toBe(0)
    wait.end()
    vi.advanceTimersByTime(LAUNCH_WAIT_MAX_MS * 2)
    expect(expired).not.toHaveBeenCalled()
  })

  it('dispose stops the clock: nothing expires after it', () => {
    const { clock, expired } = make()
    const wait = clock.launchWait()
    clock.dispose()
    wait.end()
    vi.advanceTimersByTime(LAUNCH_WAIT_MAX_MS * 2)
    expect(expired).not.toHaveBeenCalled()
  })
})
