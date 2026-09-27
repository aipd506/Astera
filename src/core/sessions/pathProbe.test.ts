import { win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOGGED_PATHS_MAX,
  PROBE_CACHE_TTL_MS,
  PROBE_CONCURRENCY,
  PROBE_DEGRADED_TTL_MS,
  PROBE_TIMEOUT_MS,
  PathKeyedCache,
  createLimiter,
  createProbePool,
  createProber,
  findOnPath,
  rootOf
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

/** An access that hangs for every path on Z: (an offline drive) and answers at once elsewhere. */
function offlineZ(present: (p: string) => boolean = () => true) {
  const hung: { p: string; d: ReturnType<typeof deferred<void>> }[] = []
  const started: string[] = []
  const access = (p: string): Promise<void> => {
    started.push(p)
    if (p.toUpperCase().startsWith('Z:')) {
      const d = deferred<void>()
      hung.push({ p, d })
      return d.promise
    }
    return present(p) ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
  }
  return { access, hung, started }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the probe constants', () => {
  it('are the approved values: 1.5 s per probe, 4 at once, about 5 minutes of cache, 10 s for a result with a timeout in it', () => {
    expect(PROBE_TIMEOUT_MS).toBe(1_500)
    expect(PROBE_CONCURRENCY).toBe(4)
    expect(PROBE_CACHE_TTL_MS).toBe(5 * 60_000)
    expect(PROBE_DEGRADED_TTL_MS).toBe(10_000)
  })
})

describe('rootOf', () => {
  it('is the drive or the UNC share on Windows paths, and the first two segments on POSIX ones', () => {
    expect(rootOf('Z:\\tools\\bin\\bash.exe')).toBe('z:\\')
    expect(rootOf('z:/tools')).toBe('z:\\')
    expect(rootOf('\\\\nas\\share\\proj\\x')).toBe('\\\\nas\\share\\')
    expect(rootOf('/mnt/nas/proj/x')).toBe('/mnt/nas')
    expect(rootOf('/usr/bin')).toBe('/usr/bin')
  })
})

describe('createProber', () => {
  it('a path that answers is present, and one that refuses is absent', async () => {
    const probe = createProber({ access: async (p) => { if (p !== 'C:\\here') throw new Error('ENOENT') }, pool: createProbePool() })
    expect(await probe('C:\\here')).toBe('present')
    expect(await probe('C:\\gone')).toBe('absent')
  })

  it('a probe that never answers is cut at 1.5 s and counts as timed out, not before', async () => {
    vi.useFakeTimers()
    const probe = createProber({ access: () => new Promise<void>(() => {}), log: () => {}, pool: createProbePool() })
    let result: string | undefined
    void probe('Z:\\offline\\bash.exe').then((r) => (result = r))
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toBe('timeout')
  })

  it('logs a timed-out path once, however often it is probed, through the injected log', async () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const probe = createProber({ access: () => new Promise<void>(() => {}), log, pool: createProbePool() })
    const a = probe('Z:\\offline')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    expect(await a).toBe('timeout')
    expect(await probe('Z:\\offline')).toBe('timeout')
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0][0])).toContain('Z:\\offline')
  })

  it('keeps no more than LOGGED_PATHS_MAX paths in its logged-once memory', async () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const probe = createProber({ access: () => new Promise<void>(() => {}), log, pool: createProbePool(10_000) })
    // Distinct roots, so none is short-circuited by another's hung call.
    const ps = Array.from({ length: LOGGED_PATHS_MAX + 1 }, (_, i) => probe(`\\\\srv${i}\\share\\x`))
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    await Promise.all(ps)
    expect(log).toHaveBeenCalledTimes(LOGGED_PATHS_MAX + 1)
    expect(probe.loggedCount()).toBeLessThanOrEqual(LOGGED_PATHS_MAX)
  })

  it('a hung call that finally rejects after its timeout is swallowed, not left unhandled', async () => {
    vi.useFakeTimers()
    const hung = deferred()
    const probe = createProber({ access: () => hung.promise, log: () => {}, pool: createProbePool() })
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

  it('never has more than four calls in flight that are still within their time', async () => {
    let inFlight = 0
    let peak = 0
    const ds: ReturnType<typeof deferred<void>>[] = []
    const access = () => {
      const d = deferred<void>()
      ds.push(d)
      inFlight++
      peak = Math.max(peak, inFlight)
      return d.promise.finally(() => inFlight--)
    }
    const probe = createProber({ access, pool: createProbePool(PROBE_CONCURRENCY), log: () => {} })
    const results = Array.from({ length: 10 }, (_, i) => probe(`C:\\p${i}`))
    await flush()
    expect(ds).toHaveLength(4)
    for (let i = 0; i < 10; i++) {
      ds[i].resolve()
      await flush()
    }
    expect(await Promise.all(results)).toEqual(Array(10).fill('present'))
    expect(peak).toBe(4)
  })

  it('a reachable path queued behind four hung probes is found: its time starts when its call starts', async () => {
    vi.useFakeTimers()
    const z = offlineZ()
    const probe = createProber({ access: z.access, pool: createProbePool(PROBE_CONCURRENCY), log: () => {} })
    const hung = ['Z:\\a\\pwsh.exe', 'Z:\\b\\pwsh.exe', 'Z:\\a\\powershell.exe', 'Z:\\b\\powershell.exe'].map((p) => probe(p))
    let local: string | undefined
    void probe('C:\\Windows\\System32\\cmd.exe').then((r) => (local = r))
    await flush()
    expect(z.started).toHaveLength(4)
    // The four are cut at 1.5 s and give their slots back although their calls still hang.
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    expect(await Promise.all(hung)).toEqual(Array(4).fill('timeout'))
    await flush()
    expect(local).toBe('present')
  })

  it('a root with a call still hung answers timeout at once, without another call, until that call ends', async () => {
    vi.useFakeTimers()
    const z = offlineZ()
    const probe = createProber({ access: z.access, pool: createProbePool(), log: () => {} })
    const first = probe('Z:\\a')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    expect(await first).toBe('timeout')
    expect(await probe('Z:\\b')).toBe('timeout')
    expect(z.started).toEqual(['Z:\\a'])
    // The drive comes back: the hung call ends, and the root may be asked again.
    z.hung[0].d.resolve()
    await flush()
    const again = probe('Z:\\b')
    await flush()
    expect(z.started).toEqual(['Z:\\a', 'Z:\\b'])
    z.hung[1].d.resolve()
    expect(await again).toBe('present')
  })

  it('a probe that skips the queue (the cwd) answers while four queued probes hang', async () => {
    vi.useFakeTimers()
    const z = offlineZ()
    const pool = createProbePool(PROBE_CONCURRENCY)
    const pathProbe = createProber({ access: z.access, pool, log: () => {} })
    const cwdProbe = createProber({ access: z.access, pool, log: () => {}, skipQueue: true })
    const hung = ['Z:\\1', 'Z:\\2', 'Z:\\3', 'Z:\\4', 'Z:\\5'].map((p) => pathProbe(p))
    await flush()
    expect(await cwdProbe('C:\\work\\proj')).toBe('present')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    await Promise.all(hung)
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

  it('keeps a result for the shorter time its ttlOf gives — one with a timeout in it', async () => {
    let t = 0
    const cache = new PathKeyedCache<{ v: number; timedOut: boolean }>(PROBE_CACHE_TTL_MS, () => t)
    let n = 0
    const compute = async () => ({ v: ++n, timedOut: n === 1 })
    const ttlOf = (r: { timedOut: boolean }) => (r.timedOut ? PROBE_DEGRADED_TTL_MS : PROBE_CACHE_TTL_MS)
    expect((await cache.get('P', 'k', compute, ttlOf)).v).toBe(1)
    t += PROBE_DEGRADED_TTL_MS - 1
    expect((await cache.get('P', 'k', compute, ttlOf)).v).toBe(1)
    t += 1
    expect((await cache.get('P', 'k', compute, ttlOf)).v).toBe(2)
    t += PROBE_DEGRADED_TTL_MS
    expect((await cache.get('P', 'k', compute, ttlOf)).v).toBe(2)
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
  it('is found when any PATH directory holds the file, probing them all at once', async () => {
    const asked: string[] = []
    const probe = async (p: string) => {
      asked.push(p)
      return p === 'C:\\b\\pwsh.exe' ? ('present' as const) : ('absent' as const)
    }
    expect(await findOnPath('C:\\a;;C:\\b', 'pwsh.exe', probe, ';', win32.join)).toEqual({ found: true, timedOut: false })
    expect(asked.sort()).toEqual(['C:\\a\\pwsh.exe', 'C:\\b\\pwsh.exe'])
    expect(await findOnPath('C:\\a', 'pwsh.exe', probe, ';', win32.join)).toEqual({ found: false, timedOut: false })
  })

  it('a directory that times out counts as not holding the file, and says a timeout was in it', async () => {
    expect(await findOnPath('Z:\\off', 'cmd.exe', async () => 'timeout', ';', win32.join)).toEqual({ found: false, timedOut: true })
  })
})
