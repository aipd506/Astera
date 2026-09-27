import { describe, it, expect, vi } from 'vitest'
import { ScriptSlots, gateHelpers, runWorkspaceScript } from './script'

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
