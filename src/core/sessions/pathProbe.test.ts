import { win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROBE_CACHE_TTL_MS,
  PROBE_CONCURRENCY,
  PROBE_TIMEOUT_MS,
  PathKeyedCache,
  createLimiter,
  createProber,
  findOnPath
} from './pathProbe'

/** A promise the test settles by hand — how a hung SMB call and its eventual answer are both played. */
function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the probe constants', () => {
  it('are the approved values: 1.5 s per probe, 4 at once, about 5 minutes of cache', () => {
    expect(PROBE_TIMEOUT_MS).toBe(1_500)
    expect(PROBE_CONCURRENCY).toBe(4)
    expect(PROBE_CACHE_TTL_MS).toBe(5 * 60_000)
  })
})

describe('createProber', () => {
  it('a path that answers is present, and one that refuses is absent', async () => {
    const probe = createProber({ access: async (p) => { if (p !== 'C:\\here') throw new Error('ENOENT') } })
    expect(await probe('C:\\here')).toBe('present')
    expect(await probe('C:\\gone')).toBe('absent')
  })

  it('a probe that never answers is cut at 1.5 s and counts as timed out, not before', async () => {
    vi.useFakeTimers()
    const probe = createProber({ access: () => new Promise<void>(() => {}), log: () => {} })
    let result: string | undefined
    void probe('Z:\\offline\\bash.exe').then((r) => (result = r))
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toBe('timeout')
  })

  it('logs a timed-out path once, however often it is probed', async () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const probe = createProber({ access: () => new Promise<void>(() => {}), log })
    const a = probe('Z:\\offline')
    const b = probe('Z:\\offline')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    expect(await a).toBe('timeout')
    expect(await b).toBe('timeout')
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0][0])).toContain('Z:\\offline')
  })

  it('a hung call that finally rejects after its timeout is swallowed, not left unhandled', async () => {
    vi.useFakeTimers()
    const hung = deferred()
    const probe = createProber({ access: () => hung.promise, log: () => {} })
    const r = probe('Z:\\late')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    expect(await r).toBe('timeout')
    vi.useRealTimers()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      hung.reject(new Error('EHOSTDOWN'))
      await flush()
      await new Promise((res) => setImmediate(res))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('never has more than four calls in flight, and holds a slot until a hung call really ends', async () => {
    vi.useFakeTimers()
    const calls: { p: string; d: ReturnType<typeof deferred<void>> }[] = []
    let inFlight = 0
    let peak = 0
    const access = (p: string) => {
      const d = deferred()
      calls.push({ p, d })
      inFlight++
      peak = Math.max(peak, inFlight)
      return d.promise.finally(() => inFlight--)
    }
    const probe = createProber({ access, limit: createLimiter(PROBE_CONCURRENCY), log: () => {} })
    const results = Array.from({ length: 10 }, (_, i) => probe(`C:\\p${i}`))
    await flush()
    expect(calls).toHaveLength(4)
    // The four time out, but their calls are still hung: nothing new may start on top of them.
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    expect(await results[0]).toBe('timeout')
    expect(calls).toHaveLength(4)
    // One hung call ends: one slot opens. The queued probes already timed out, so none of them spends it.
    calls[0].d.resolve()
    await flush()
    expect(peak).toBe(4)
    expect(calls).toHaveLength(4)
    // A fresh probe gets the free slot and answers.
    const fresh = probe('C:\\fresh')
    await flush()
    expect(calls).toHaveLength(5)
    calls[4].d.resolve()
    expect(await fresh).toBe('present')
    expect(peak).toBe(4)
  })
})

describe('createLimiter', () => {
  it('runs at most n tasks at once and starts the next as one finishes', async () => {
    const run = createLimiter(2)
    const ds = [deferred(), deferred(), deferred()]
    const started: number[] = []
    const all = ds.map((d, i) => run(async () => { started.push(i); await d.promise; return i }))
    await flush()
    expect(started).toEqual([0, 1])
    ds[1].resolve()
    await flush()
    expect(started).toEqual([0, 1, 2])
    ds[0].resolve()
    ds[2].resolve()
    expect(await Promise.all(all)).toEqual([0, 1, 2])
  })

  it('a task that throws frees its slot and passes the error to its own caller', async () => {
    const run = createLimiter(1)
    await expect(run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await run(async () => 7)).toBe(7)
  })
})

describe('PathKeyedCache', () => {
  it('computes once per PATH and key while fresh — the second spawn does not probe again', async () => {
    let t = 0
    const cache = new PathKeyedCache<string>(PROBE_CACHE_TTL_MS, () => t)
    const compute = vi.fn(async () => 'C:\\Git\\bin\\bash.exe')
    expect(await cache.get('C:\\a;Z:\\offline', 'gitBash', compute)).toBe('C:\\Git\\bin\\bash.exe')
    t += PROBE_CACHE_TTL_MS - 1
    expect(await cache.get('C:\\a;Z:\\offline', 'gitBash', compute)).toBe('C:\\Git\\bin\\bash.exe')
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('shares one computation between callers that ask while it runs', async () => {
    const cache = new PathKeyedCache<number>()
    const d = deferred<number>()
    const compute = vi.fn(() => d.promise)
    const a = cache.get('P', 'k', compute)
    const b = cache.get('P', 'k', compute)
    d.resolve(3)
    expect([await a, await b]).toEqual([3, 3])
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('computes again once the entry is older than the TTL', async () => {
    let t = 0
    const cache = new PathKeyedCache<number>(1000, () => t)
    let n = 0
    const compute = async () => ++n
    expect(await cache.get('P', 'k', compute)).toBe(1)
    t = 1000
    expect(await cache.get('P', 'k', compute)).toBe(2)
  })

  it('drops everything when the PATH string changes', async () => {
    const cache = new PathKeyedCache<number>()
    let n = 0
    const compute = async () => ++n
    expect(await cache.get('P1', 'k', compute)).toBe(1)
    expect(await cache.get('P2', 'k', compute)).toBe(2)
    expect(cache.peek('P1', 'k')).toBeUndefined()
    expect(await cache.get('P1', 'k', compute)).toBe(3)
  })

  it('does not keep a computation that failed', async () => {
    const cache = new PathKeyedCache<number>()
    await expect(cache.get('P', 'k', async () => { throw new Error('x') })).rejects.toThrow('x')
    expect(await cache.get('P', 'k', async () => 5)).toBe(5)
  })

  it('peek answers synchronously with a fresh settled value, and undefined otherwise', async () => {
    let t = 0
    const cache = new PathKeyedCache<string | null>(1000, () => t)
    expect(cache.peek('P', 'k')).toBeUndefined()
    const d = deferred<string | null>()
    const pending = cache.get('P', 'k', () => d.promise)
    expect(cache.peek('P', 'k')).toBeUndefined()
    d.resolve(null)
    await pending
    expect(cache.peek('P', 'k')).toBeNull()
    expect(cache.peek('Q', 'k')).toBeUndefined()
    t = 1000
    expect(cache.peek('P', 'k')).toBeUndefined()
  })
})

describe('findOnPath', () => {
  it('is true when any PATH directory holds the file, probing them all at once', async () => {
    const asked: string[] = []
    const probe = async (p: string) => {
      asked.push(p)
      return p === 'C:\\b\\pwsh.exe' ? ('present' as const) : ('absent' as const)
    }
    expect(await findOnPath('C:\\a;;C:\\b', 'pwsh.exe', probe, ';', win32.join)).toBe(true)
    expect(asked.sort()).toEqual(['C:\\a\\pwsh.exe', 'C:\\b\\pwsh.exe'])
    expect(await findOnPath('C:\\a', 'pwsh.exe', probe, ';', win32.join)).toBe(false)
  })

  it('a directory that times out counts as not holding the file', async () => {
    expect(await findOnPath('Z:\\off', 'cmd.exe', async () => 'timeout', ';', win32.join)).toBe(false)
  })
})
