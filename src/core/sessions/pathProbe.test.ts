import { win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOGGED_PATHS_MAX,
  PROBE_CACHE_TTL_MS,
  PROBE_CONCURRENCY,
  PROBE_DEGRADED_TTL_MS,
  PROBE_STUCK_CEILING_MS,
  PROBE_TIMEOUT_MS,
  PathKeyedCache,
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

/**
 * A model of the libuv threadpool as the probes see it: every call is one thread until it settles.
 * Paths on a dead root (by rootOf) hang until the test settles them; the rest answer at once. It
 * records the peak of calls in flight, overall and per root, for the probes it was built for.
 */
function threadpool(deadRoots: string[], present: (p: string) => boolean = () => true) {
  const started: string[] = []
  const hung: { p: string; d: ReturnType<typeof deferred<void>> }[] = []
  const inFlight = new Map<string, number>()
  let total = 0
  let peakTotal = 0
  let peakPerRoot = 0
  const access = (p: string): Promise<void> => {
    started.push(p)
    const root = rootOf(p)
    total++
    inFlight.set(root, (inFlight.get(root) ?? 0) + 1)
    peakTotal = Math.max(peakTotal, total)
    peakPerRoot = Math.max(peakPerRoot, inFlight.get(root)!)
    const done = () => {
      total--
      inFlight.set(root, inFlight.get(root)! - 1)
    }
    let call: Promise<void>
    if (deadRoots.includes(root)) {
      const d = deferred<void>()
      hung.push({ p, d })
      call = d.promise
    } else {
      call = present(p) ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
    }
    return call.finally(done)
  }
  return {
    access,
    started,
    hung,
    peak: () => ({ total: peakTotal, perRoot: peakPerRoot }),
    inFlight: () => total
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the probe constants', () => {
  it('are the approved values: 1.5 s per probe, 2 PATH calls in flight, 5 minutes of cache, 10 s with a timeout in it, a 2-minute stuck ceiling', () => {
    expect(PROBE_TIMEOUT_MS).toBe(1_500)
    expect(PROBE_CONCURRENCY).toBe(2)
    expect(PROBE_CACHE_TTL_MS).toBe(5 * 60_000)
    expect(PROBE_DEGRADED_TTL_MS).toBe(10_000)
    expect(PROBE_STUCK_CEILING_MS).toBe(2 * 60_000)
  })
})

describe('rootOf', () => {
  it('is the drive or the UNC share on Windows paths, and the first two segments on POSIX ones', () => {
    expect(rootOf('Z:\\tools\\bin\\bash.exe')).toBe('z:\\')
    expect(rootOf('/mnt/nas/proj/x')).toBe('/mnt/nas')
    expect(rootOf('/usr/bin')).toBe('/usr/bin')
  })

  it('gives every spelling of one drive or share the same key', () => {
    for (const p of ['Z:', 'z:', 'Z:\\', 'z:/', 'Z:tools', 'Z:\\Tools\\x', '\\\\?\\Z:\\tools']) expect(rootOf(p)).toBe('z:\\')
    for (const p of ['\\\\nas\\share', '\\\\NAS\\Share\\', '//nas/share/proj', '\\\\nas\\SHARE\\a\\b', '\\\\?\\UNC\\nas\\share\\x'])
      expect(rootOf(p)).toBe('\\\\nas\\share\\')
    expect(rootOf('\\\\nas\\other')).not.toBe(rootOf('\\\\nas\\share'))
  })
})

describe('createProber', () => {
  it('a path that answers is present, and one that refuses is absent', async () => {
    const probe = createProber({ access: async (p) => { if (p !== 'C:\\here') throw new Error('ENOENT') }, pool: createProbePool() })
    expect(await probe('C:\\here')).toBe('present')
    expect(await probe('C:\\gone')).toBe('absent')
  })

  it('a probe that never answers is cut 1.5 s after its call starts, not before', async () => {
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
    const log = vi.fn()
    const probe = createProber({ access: async () => {}, log, pool: createProbePool() })
    // Every probe after the first two is refused without a call (two calls are stuck), and each is logged.
    const pool = threadpool(['\\\\srv0\\share\\', '\\\\srv1\\share\\'])
    const stuck = createProber({ access: pool.access, log, pool: createProbePool() })
    vi.useFakeTimers()
    const first = [stuck('\\\\srv0\\share\\x'), stuck('\\\\srv1\\share\\x')]
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    await Promise.all(first)
    for (let i = 0; i < LOGGED_PATHS_MAX + 5; i++) await stuck(`C:\\p${i}`)
    expect(log.mock.calls.length).toBeGreaterThan(LOGGED_PATHS_MAX)
    expect(stuck.loggedCount()).toBeLessThanOrEqual(LOGGED_PATHS_MAX)
    expect(await probe('C:\\x')).toBe('present')
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
})

describe('the PATH probe pool, against a model of the threadpool', () => {
  it('never has more than 2 calls in flight, nor more than 1 per root, however many dead roots PATH holds', async () => {
    vi.useFakeTimers()
    const dead = ['z:\\', 'y:\\', '\\\\nas\\share\\', 'x:\\']
    const tp = threadpool(dead)
    const probe = createProber({ access: tp.access, pool: createProbePool(), log: () => {} })
    const paths: string[] = []
    for (const d of ['Z:', 'Y:', '\\\\nas\\share', 'X:']) for (const dir of ['a\\bin', 'b\\cmd', 'c']) for (const f of ['git.exe', 'bash.exe']) paths.push(`${d}\\${dir}\\${f}`)
    for (let i = 0; i < 8; i++) paths.push(`C:\\local${i}\\bash.exe`)
    const results = paths.map((p) => probe(p))
    // Walk the clock past every timeout; the hung calls never settle.
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS / 2)
    const answered = await Promise.all(results)
    expect(answered).toHaveLength(paths.length)
    expect(tp.peak().total).toBeLessThanOrEqual(2)
    expect(tp.peak().perRoot).toBe(1)
    // Two stuck calls in all, whatever the number of dead roots: the rest never reached the disk.
    expect(tp.hung).toHaveLength(2)
    expect(tp.inFlight()).toBe(2)
  })

  it('a second probe on a root waits for the first, and answers timeout at once when the first times out', async () => {
    vi.useFakeTimers()
    const tp = threadpool(['z:\\'])
    const probe = createProber({ access: tp.access, pool: createProbePool(), log: () => {} })
    const a = probe('Z:\\a\\git.exe')
    const b = probe('Z:\\b\\git.exe')
    const c = probe('C:\\Windows\\System32\\cmd.exe')
    await flush()
    expect(tp.started).toEqual(['Z:\\a\\git.exe', 'C:\\Windows\\System32\\cmd.exe'])
    expect(await c).toBe('present')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    expect([await a, await b]).toEqual(['timeout', 'timeout'])
    expect(tp.started).toHaveLength(2)
  })

  it('a reachable path queued behind a stuck root is found: its own time starts when its call starts', async () => {
    vi.useFakeTimers()
    const tp = threadpool(['z:\\'])
    const probe = createProber({ access: tp.access, pool: createProbePool(), log: () => {} })
    const hung = ['Z:\\a\\pwsh.exe', 'Z:\\b\\pwsh.exe', 'Z:\\a\\powershell.exe', 'Z:\\b\\powershell.exe'].map((p) => probe(p))
    const local = probe('C:\\Windows\\System32\\cmd.exe')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    expect(await Promise.all(hung)).toEqual(Array(4).fill('timeout'))
    expect(await local).toBe('present')
    expect(tp.hung).toHaveLength(1)
  })

  it('once two calls are stuck, PATH probes answer timeout without a call until one of them settles', async () => {
    vi.useFakeTimers()
    const dead = ['z:\\', 'y:\\']
    const tp = threadpool(dead)
    const probe = createProber({ access: tp.access, pool: createProbePool(), log: () => {} })
    const first = [probe('Z:\\a'), probe('Y:\\a')]
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    await Promise.all(first)
    expect(await probe('C:\\healthy')).toBe('timeout')
    expect(tp.started).toEqual(['Z:\\a', 'Y:\\a'])
    // Z: comes back: its call settles, one slot is free again, and the root may be asked again.
    dead.splice(0, 1)
    tp.hung[0].d.resolve()
    await flush()
    expect(await probe('C:\\healthy')).toBe('present')
    expect(await probe('Z:\\b')).toBe('present')
  })

  it('a stuck call is let go after the ceiling (a POSIX hard mount), logged once, and its root may be asked again', async () => {
    vi.useFakeTimers()
    const tp = threadpool(['/mnt/nas'])
    const log = vi.fn()
    const probe = createProber({ access: tp.access, pool: createProbePool(), log })
    const a = probe('/mnt/nas/bin/bash')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    expect(await a).toBe('timeout')
    expect(await probe('/mnt/nas/other')).toBe('timeout')
    expect(tp.started).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(PROBE_STUCK_CEILING_MS)
    const ceilingLines = log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('ceiling'))
    expect(ceilingLines).toHaveLength(1)
    void probe('/mnt/nas/again')
    await flush()
    expect(tp.started).toEqual(['/mnt/nas/bin/bash', '/mnt/nas/again'])
    // The old call settling late must not free a second slot.
    tp.hung[0].d.resolve()
    await flush()
    await vi.advanceTimersByTimeAsync(PROBE_STUCK_CEILING_MS * 2)
    expect(log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('ceiling'))).toHaveLength(2)
  })
})

describe('the cwd probe', () => {
  it('is issued at once while PATH roots hang, and answers', async () => {
    vi.useFakeTimers()
    const tp = threadpool(['z:\\', 'y:\\'])
    const pool = createProbePool()
    const pathProbe = createProber({ access: tp.access, pool, log: () => {} })
    const cwdProbe = createProber({ access: tp.access, pool, log: () => {}, skipQueue: true })
    const hung = ['Z:\\a', 'Z:\\b', 'Y:\\a', 'Y:\\b', 'X:\\a'].map((p) => pathProbe(p))
    await flush()
    const r = cwdProbe('C:\\work\\proj')
    await flush()
    expect(tp.started).toContain('C:\\work\\proj')
    expect(await r).toBe('present')
    // And again once both PATH calls are stuck.
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    await Promise.all(hung)
    expect(await cwdProbe('C:\\work\\other')).toBe('present')
    expect(tp.started).toContain('C:\\work\\other')
  })

  it('answers timeout at once for a folder on a root with a stuck call', async () => {
    vi.useFakeTimers()
    const tp = threadpool(['z:\\'])
    const pool = createProbePool()
    const pathProbe = createProber({ access: tp.access, pool, log: () => {} })
    const cwdProbe = createProber({ access: tp.access, pool, log: () => {}, skipQueue: true })
    const a = pathProbe('Z:\\bin\\git.exe')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    await a
    expect(await cwdProbe('z:/projects/app')).toBe('timeout')
    expect(tp.started).toEqual(['Z:\\bin\\git.exe'])
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
