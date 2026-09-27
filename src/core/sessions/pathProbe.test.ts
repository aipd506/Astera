import { win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOGGED_PATHS_MAX,
  PROBE_CACHE_TTL_MS,
  PROBE_CONCURRENCY,
  PROBE_DEGRADED_TTL_MS,
  PROBE_STUCK_CEILING_MS,
  PROBE_TIMEOUT_MS,
  PROBE_STUCK_MAX,
  PathKeyedCache,
  ProbeBudget,
  createProbePool,
  processProbeBudget,
  createProber,
  findOnPath,
  rootOf
} from './pathProbe'
import { createActionPresenceCheck, createPresenceCheck } from '../worktrees/presence'

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
function threadpool(deadRoots: string[], present: (p: string) => boolean = () => true, threads = 4) {
  const started: string[] = []
  const hung: { p: string; d: ReturnType<typeof deferred<void>> }[] = []
  const inFlight = new Map<string, number>()
  let total = 0
  let peakTotal = 0
  let peakPerRoot = 0
  // libuv's pool: a call runs only on a free thread, and waits for one otherwise. A local call stuck
  // behind hung ones never runs, so the prober's timer cuts it — a starved thread shows as a timeout.
  let running = 0
  const waiting: (() => void)[] = []
  const freeThread = (): void => {
    running--
    waiting.shift()?.()
  }
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
    const run = (): Promise<void> => {
      running++
      let call: Promise<void>
      if (deadRoots.includes(root)) {
        const d = deferred<void>()
        hung.push({ p, d })
        call = d.promise
      } else {
        call = present(p) ? Promise.resolve() : Promise.reject(new Error('ENOENT'))
      }
      return call.finally(freeThread)
    }
    const call = running < threads ? run() : new Promise<void>((res, rej) => waiting.push(() => void run().then(res, rej)))
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
  // The budget is process-wide: calls a test left hung must not count against the next test.
  processProbeBudget().reset()
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
  it('the harness shows a starved thread: a local call behind 4 hung calls times out', async () => {
    vi.useFakeTimers()
    const tp = threadpool(['z:\\'])
    for (const p of ['Z:\\1', 'Z:\\2', 'Z:\\3', 'Z:\\4']) void tp.access(p).catch(() => {})
    const probe = createProber({ access: tp.access, pool: createProbePool(), log: () => {}, skipQueue: true })
    const r = probe('C:\\work\\proj')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    expect(await r).toBe('timeout')
  })

  it('makes one call per root at a time: probes on the same folder share its answer, others on that root answer timeout with it', async () => {
    vi.useFakeTimers()
    const tp = threadpool(['w:\\'])
    const cwdProbe = createProber({ access: tp.access, pool: createProbePool(), log: () => {}, skipQueue: true })
    const same = [cwdProbe('W:\\proj'), cwdProbe('W:\\proj'), cwdProbe('W:\\proj')]
    const other = [cwdProbe('W:\\other'), cwdProbe('w:/third')]
    await flush()
    expect(tp.started).toEqual(['W:\\proj'])
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    expect(await Promise.all(same)).toEqual(['timeout', 'timeout', 'timeout'])
    expect(await Promise.all(other)).toEqual(['timeout', 'timeout'])
    expect(tp.started).toEqual(['W:\\proj'])
  })

  it('a probe on the same root but another folder makes its own call once the first one answers', async () => {
    const tp = threadpool([], (p) => p !== 'C:\\gone')
    const cwdProbe = createProber({ access: tp.access, pool: createProbePool(), log: () => {}, skipQueue: true })
    const a = cwdProbe('C:\\gone')
    const b = cwdProbe('C:\\here')
    const c = cwdProbe('C:\\gone')
    expect([await a, await b, await c]).toEqual(['absent', 'present', 'absent'])
    expect(tp.started.filter((p) => p === 'C:\\gone')).toHaveLength(1)
    expect(tp.started).toContain('C:\\here')
  })

  it('confirms a local folder while 2 PATH calls are stuck and several cwd probes hit one offline folder at once', async () => {
    vi.useFakeTimers()
    const tp = threadpool(['z:\\', 'y:\\', 'w:\\'])
    const pool = createProbePool()
    const pathProbe = createProber({ access: tp.access, pool, log: () => {} })
    const cwdProbe = createProber({ access: tp.access, pool, log: () => {}, skipQueue: true })
    // C: has answered before (the app's own folders are on it). With the process-wide budget, a root
    // never heard from is refused once 3 calls are stuck or in flight on unknown roots; C: is not.
    expect(await cwdProbe('C:\\Users')).toBe('present')
    // Two dead PATH roots: two calls stuck, two threads left.
    const stuck = [pathProbe('Z:\\bin\\git.exe'), pathProbe('Y:\\bin\\git.exe')]
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    await Promise.all(stuck)
    // A roll, the Host spawner and a retry all prepare the same offline folder within the same 1.5 s.
    const offline = [cwdProbe('W:\\proj'), cwdProbe('W:\\proj'), cwdProbe('W:\\proj'), cwdProbe('W:\\proj\\sub')]
    await flush()
    // Meanwhile a session on a local folder is prepared.
    const local = cwdProbe('C:\\work\\proj')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    expect(await local).toBe('present')
    expect(await Promise.all(offline)).toEqual(Array(4).fill('timeout'))
    expect(tp.started.filter((p) => p.startsWith('W:'))).toHaveLength(1)
  })

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
    expect(await findOnPath('C:\\a;;C:\\b', 'pwsh.exe', probe, ';', win32.join)).toEqual({
      found: true,
      timedOut: false,
      at: 'C:\\b\\pwsh.exe'
    })
    expect(asked.sort()).toEqual(['C:\\a\\pwsh.exe', 'C:\\b\\pwsh.exe'])
    expect(await findOnPath('C:\\a', 'pwsh.exe', probe, ';', win32.join)).toEqual({ found: false, timedOut: false, at: null })
  })

  it('a directory that times out counts as not holding the file, and says a timeout was in it', async () => {
    expect(await findOnPath('Z:\\off', 'cmd.exe', async () => 'timeout', ';', win32.join)).toEqual({
      found: false,
      timedOut: true,
      at: null
    })
  })

  it('says where the file is: the first directory, in PATH order, that holds it', async () => {
    const probe = async (p: string) => (p.startsWith('C:\\a') ? ('absent' as const) : ('present' as const))
    expect((await findOnPath('C:\\a;D:\\b;C:\\c', 'pwsh.exe', probe, ';', win32.join)).at).toBe('D:\\b\\pwsh.exe')
  })
})

// Review round 2, I1. Every lane used to keep its own stuck calls: the PATH pool, the session folder's
// lane, the worktree sweep and the worktree action lane. One dead root could then hold a thread in each
// of them, more than libuv's 4, and each further dead root added more. They now share one budget.
describe('the process-wide probe budget, across every lane', () => {
  const lanes = (budget: ProbeBudget, access: (p: string) => Promise<void>) => {
    const pathPool = createProbePool(PROBE_CONCURRENCY, PROBE_STUCK_CEILING_MS, budget)
    return {
      path: createProber({ access, pool: pathPool, log: () => {} }),
      cwd: createProber({ access, pool: pathPool, log: () => {}, skipQueue: true }),
      sweep: createPresenceCheck({ access, pool: createProbePool(1, PROBE_STUCK_CEILING_MS, budget), log: () => {} }),
      action: createActionPresenceCheck({ access, pool: createProbePool(PROBE_CONCURRENCY, PROBE_STUCK_CEILING_MS, budget), log: () => {} })
    }
  }

  // The action lane is asked by a person, so it may take the one extra slot past the cap (enter's
  // pastCap): the bound across every lane is PROBE_STUCK_MAX + 1, and it is exactly that — the
  // background lanes alone keep to PROBE_STUCK_MAX (the next test).
  it('dead roots across all lanes never hold more than one stuck call per root, nor more than 3 + the one extra slot in all', async () => {
    vi.useFakeTimers()
    const dead = ['z:\\', 'y:\\', 'x:\\', 'w:\\', 'v:\\']
    const tp = threadpool(dead)
    const budget = new ProbeBudget()
    const l = lanes(budget, tp.access)
    const asks: Promise<unknown>[] = []
    for (let round = 0; round < 3; round++) {
      for (const d of ['Z:', 'Y:', 'X:', 'W:', 'V:']) {
        asks.push(l.path(`${d}\\bin\\git.exe`), l.cwd(`${d}\\proj`), l.sweep(`${d}\\wt\\a`), l.action(`${d}\\wt\\b`))
      }
      for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS / 2)
    }
    await Promise.all(asks)
    expect(tp.peak().perRoot).toBe(1)
    expect(tp.hung.length).toBeLessThanOrEqual(PROBE_STUCK_MAX + 1)
    expect(tp.inFlight()).toBeLessThanOrEqual(PROBE_STUCK_MAX + 1)
    expect(budget.stuckCount()).toBeLessThanOrEqual(PROBE_STUCK_MAX + 1)
    await vi.advanceTimersByTimeAsync(PROBE_STUCK_CEILING_MS)
  })

  it('the background lanes alone never hold more than 3 stuck calls, however many roots are dead', async () => {
    vi.useFakeTimers()
    const tp = threadpool(['Z:/', 'Y:/', 'X:/', 'W:/', 'V:/'].map(rootOf))
    const budget = new ProbeBudget()
    const l = lanes(budget, tp.access)
    const asks: Promise<unknown>[] = []
    for (let round = 0; round < 3; round++) {
      for (const d of ['Z:', 'Y:', 'X:', 'W:', 'V:']) asks.push(l.path(`${d}/bin/git.exe`), l.cwd(`${d}/proj`), l.sweep(`${d}/wt/a`))
      for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS / 2)
    }
    await Promise.all(asks)
    expect(tp.peak().perRoot).toBe(1)
    expect(tp.hung.length).toBeLessThanOrEqual(PROBE_STUCK_MAX)
    expect(budget.stuckCount()).toBeLessThanOrEqual(PROBE_STUCK_MAX)
    await vi.advanceTimersByTimeAsync(PROBE_STUCK_CEILING_MS)
  })

  it('past the cap there is one extra slot: while its call is stuck, a second person on another unknown root is refused without a call', async () => {
    vi.useFakeTimers()
    const tp = threadpool(['Z:/', 'Y:/', 'X:/', 'W:/', 'V:/'].map(rootOf))
    const budget = new ProbeBudget()
    const l = lanes(budget, tp.access)
    const first = [l.path('Z:/bin/git.exe'), l.sweep('Y:/wt/a'), l.cwd('X:/proj')]
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    await Promise.all(first)
    expect(budget.stuckCount()).toBe(PROBE_STUCK_MAX)
    const w = l.action('W:/wt/b')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    expect(await w).toBe('unreachable')
    expect(budget.stuckCount()).toBe(PROBE_STUCK_MAX + 1)
    const before = tp.started.length
    const v = l.action('V:/wt/c')
    await vi.advanceTimersByTimeAsync(0)
    expect(await v).toBe('refused')
    expect(tp.started.length).toBe(before)
    await vi.advanceTimersByTimeAsync(PROBE_STUCK_CEILING_MS)
  })

  it('keeps answering a root that answered recently while 3 calls are stuck, and refuses others without a call', async () => {
    vi.useFakeTimers()
    const tp = threadpool(['z:\\', 'y:\\', 'x:\\'])
    const budget = new ProbeBudget()
    const l = lanes(budget, tp.access)
    expect(await l.cwd('C:\\work\\proj')).toBe('present')
    const stuck = [l.path('Z:\\bin\\git.exe'), l.sweep('Y:\\wt\\a'), l.action('X:\\wt\\b')]
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    await Promise.all(stuck)
    expect(budget.stuckCount()).toBe(3)
    const local = [l.cwd('C:\\work\\other'), l.action('C:\\wt\\c'), l.path('C:\\Windows\\cmd.exe')]
    await vi.advanceTimersByTimeAsync(0)
    expect(await local[0]).toBe('present')
    expect(await local[1]).toBe('present')
    expect(await local[2]).toBe('present')
    const before = tp.started.length
    const unknownRoot = l.cwd('Q:\\never')
    await vi.advanceTimersByTimeAsync(0)
    expect(await unknownRoot).toBe('timeout')
    expect(tp.started.length).toBe(before)
    await vi.advanceTimersByTimeAsync(PROBE_STUCK_CEILING_MS)
  })

  it('a root stuck in one lane answers at once, without a call, in every other lane', async () => {
    vi.useFakeTimers()
    const tp = threadpool(['z:\\'])
    const l = lanes(new ProbeBudget(), tp.access)
    const first = l.sweep('Z:\\wt\\a')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    expect(await first).toBe('unreachable')
    const others = [l.path('Z:\\bin\\git.exe'), l.cwd('Z:\\proj'), l.action('Z:\\wt\\b')]
    await vi.advanceTimersByTimeAsync(0)
    expect(await Promise.all(others)).toEqual(['timeout', 'timeout', 'refused'])
    expect(tp.started).toEqual(['Z:\\wt\\a'])
    await vi.advanceTimersByTimeAsync(PROBE_STUCK_CEILING_MS)
  })

  it('the headers state the real budget', async () => {
    const { readFileSync } = await import('node:fs')
    const probeSrc = readFileSync(new URL('./pathProbe.ts', import.meta.url), 'utf8')
    const presenceSrc = readFileSync(new URL('../worktrees/presence.ts', import.meta.url), 'utf8')
    expect(PROBE_STUCK_MAX).toBe(3)
    expect(probeSrc).toContain('PROBE_STUCK_MAX (3) stuck calls in the whole process')
    expect(presenceSrc).toContain('PROBE_STUCK_MAX (3) stuck calls in the whole process')
    expect(presenceSrc).not.toContain('The thread budget is 2 PATH + 1 worktree')
  })
})

// Stage 2 final review (the deferred T1 minor): a timeout forgets that the root answered before, so a
// root that died after answering is not let past PROBE_STUCK_MAX again once its stuck call lets go.
describe('ProbeBudget, a root that answered and then timed out', () => {
  it('is no longer treated as known to be alive', async () => {
    const budget = new ProbeBudget(1)
    const first = await budget.enter('z:\\')
    if (typeof first === 'string') throw new Error(first)
    first.answered() // z: is alive
    const second = await budget.enter('z:\\')
    if (typeof second === 'string') throw new Error(second)
    second.timedOut() // and now it is not
    second.release()
    const other = await budget.enter('y:\\')
    if (typeof other === 'string') throw new Error(other)
    other.timedOut() // the one stuck call the budget allows
    // Before: z: still counted as fresh and was let past the cap. Now it is refused without a call.
    expect(typeof (await budget.enter('z:\\'))).toBe('string')
  })
})

// Stage 4 T1: one budgeted look at a folder before an operation issues unbudgeted fs calls under it.
describe('gateRoot', () => {
  it('lets a present or absent folder through, and names a timeout "not reachable"', async () => {
    const { gateRoot, isRootUnreachable } = await import('./pathProbe')
    await expect(gateRoot('C:/a', async () => 'present')).resolves.toBe('present')
    await expect(gateRoot('C:/a', async () => 'absent')).resolves.toBe('absent')
    const err = await gateRoot('Z:/dead', async () => 'timeout').catch((e: unknown) => e)
    expect(String(err)).toMatch(/ROOT_UNREACHABLE: folder not reachable: Z:\/dead/)
    expect(isRootUnreachable(err)).toBe(true)
    expect(isRootUnreachable(new Error('ENOENT'))).toBe(false)
    expect(isRootUnreachable(new Error('WORKTREE_ROOT_UNREACHABLE: x'))).toBe(false)
  })

  it('refuses a root the process budget holds as stuck without making a call', async () => {
    const { gateRoot, createProber, createProbePool, ProbeBudget, rootOf } = await import('./pathProbe')
    const budget = new ProbeBudget()
    const ticket = await budget.enter(rootOf('Z:/dead'))
    if (typeof ticket === 'string') throw new Error(ticket)
    ticket.timedOut()
    const access = vi.fn(async () => {})
    const probe = createProber({ access, skipQueue: true, pool: createProbePool(2, 60_000, budget), log: () => {} })
    await expect(gateRoot('Z:/dead/project', probe)).rejects.toThrow(/ROOT_UNREACHABLE/)
    expect(access).not.toHaveBeenCalled()
  })
})

// Stage 4 T1 review (Important): once PROBE_STUCK_MAX calls are stuck, the budget refused every root
// that had not answered in the last 5 minutes — a local D: included, so with three dead VPN drives a
// delete in D:/proj failed as "not reachable" and could never recover, since it never got a call. A
// refusal by the cap is not a stuck root: a person's operation (gateRoot) gets its one call past the cap.
describe('gateRoot past the stuck-call cap', () => {
  const stickRoots = async (budget: { enter(r: string): Promise<unknown> }, roots: string[]): Promise<void> => {
    for (const r of roots) {
      const t = (await budget.enter(r)) as { timedOut(): void } | string
      if (typeof t === 'string') throw new Error(t)
      t.timedOut()
    }
  }

  it('a fresh local root gets its call with the cap reached, while a background probe is still refused', async () => {
    const { gateRoot, createProber, createProbePool, ProbeBudget, PROBE_STUCK_MAX } = await import('./pathProbe')
    const budget = new ProbeBudget()
    await stickRoots(budget, ['Z:/', 'Y:/', 'X:/'].map(rootOf).slice(0, PROBE_STUCK_MAX))
    expect(budget.stuckCount()).toBe(PROBE_STUCK_MAX)
    const pool = createProbePool(2, 60_000, budget)
    const access = vi.fn(async () => {})
    const background = createProber({ access, skipQueue: true, pool, log: () => {} })
    expect(await background('D:/proj')).toBe('timeout')
    expect(access).not.toHaveBeenCalled()
    const person = createProber({ access, skipQueue: true, pool, log: () => {}, pastCap: true })
    await expect(gateRoot('D:/proj', person)).resolves.toBe('present')
    expect(access).toHaveBeenCalledTimes(1)
  })

  it('the default gate is the one that goes past the cap', async () => {
    const { gateRoot, processProbeBudget } = await import('./pathProbe')
    const budget = processProbeBudget()
    try {
      await stickRoots(budget, ['Q:/', 'R:/', 'S:/'].map(rootOf))
      await expect(gateRoot(process.cwd())).resolves.toBe('present')
    } finally {
      budget.reset()
    }
  })

  it('a root that is itself stuck is still refused at once, past the cap or not', async () => {
    const { gateRoot, createProber, createProbePool, ProbeBudget } = await import('./pathProbe')
    const budget = new ProbeBudget()
    await stickRoots(budget, [rootOf('D:/proj')])
    const access = vi.fn(async () => {})
    const person = createProber({ access, skipQueue: true, pool: createProbePool(2, 60_000, budget), log: () => {}, pastCap: true })
    await expect(gateRoot('D:/proj', person)).rejects.toThrow(/ROOT_UNREACHABLE/)
    expect(access).not.toHaveBeenCalled()
  })
})

// Stage 4 T1 review (minor 1): two probes of different kinds on the same path (an access, and a stat
// that answers present only for a file) must not take each other's answer while one is in flight.
describe('the session-folder lane shares an answer only between probes of the same kind', () => {
  it('a directory is present to an access probe and absent to an is-a-file probe asked at the same time', async () => {
    const { createProber, createProbePool, ProbeBudget } = await import('./pathProbe')
    const pool = createProbePool(2, 60_000, new ProbeBudget())
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const access = createProber({ access: async () => { await gate }, skipQueue: true, pool, log: () => {} })
    const isFile = createProber({
      access: async () => {
        throw new Error('not a file')
      },
      skipQueue: true,
      pool,
      log: () => {}
    })
    const a = access('C:/proj/src')
    const b = isFile('C:/proj/src')
    release()
    expect(await a).toBe('present')
    expect(await b).toBe('absent')
  })
})
