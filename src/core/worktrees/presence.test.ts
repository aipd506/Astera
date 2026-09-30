import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProbePool, createProber, processProbeBudget, ProbeBudget, rootOf, PROBE_STUCK_CEILING_MS, PROBE_TIMEOUT_MS } from '../sessions/pathProbe'
import { askUntilAnswered, ASK_TRIES, createActionPresenceCheck, createPresenceCheck, PresenceCache, type CheckResult, type Presence } from './presence'

const enoent = (): Error => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
const eperm = (): Error => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })

afterEach(() => {
  vi.useRealTimers()
  // The budget is process-wide: calls a test left hung must not count against the next test.
  processProbeBudget().reset()
})

describe('createPresenceCheck', () => {
  it('a folder that answers is present', async () => {
    const check = createPresenceCheck({ access: async () => {}, pool: createProbePool(), log: () => {} })
    expect(await check('C:\\wt\\a')).toBe('present')
  })

  it('ENOENT on a folder whose drive answers is missing', async () => {
    const check = createPresenceCheck({
      access: async (p) => {
        if (p === 'C:\\wt\\gone') throw enoent()
      },
      pool: createProbePool(),
      log: () => {}
    })
    expect(await check('C:\\wt\\gone')).toBe('missing')
  })

  // 드라이브 문자 자체가 사라졌다(USB 를 뽑았다, 매핑이 풀렸다) — 폴더가 지워졌다는 증거가 아니다
  it('ENOENT when the drive itself is gone is unreachable, not missing', async () => {
    const check = createPresenceCheck({
      access: async () => {
        throw enoent()
      },
      pool: createProbePool(),
      log: () => {}
    })
    expect(await check('E:\\wt\\a')).toBe('unreachable')
  })

  it('any error other than ENOENT is unreachable', async () => {
    const check = createPresenceCheck({
      access: async (p) => {
        if (p === 'C:\\wt\\locked') throw eperm()
      },
      pool: createProbePool(),
      log: () => {}
    })
    expect(await check('C:\\wt\\locked')).toBe('unreachable')
  })

  it('a hung folder is unreachable after the probe limit, and never rejects', async () => {
    vi.useFakeTimers()
    const check = createPresenceCheck({ access: () => new Promise<void>(() => {}), pool: createProbePool(), log: () => {} })
    const r = check('\\\\nas\\share\\wt\\a')
    let got: CheckResult | null = null
    void r.then((v) => (got = v))
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1)
    expect(got).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(got).toBe('unreachable')
  })
})

describe('PresenceCache', () => {
  it('answers unknown before the first check, synchronously, and schedules one', async () => {
    let resolve!: (v: Presence) => void
    const check = vi.fn(() => new Promise<Presence>((r) => (resolve = r)))
    const cache = new PresenceCache({ check })
    expect(cache.peek('C:\\wt\\a')).toBe('unknown')
    // peek 는 확인을 예약만 한다 — 부른 쪽(푸시 경로)에서는 확인 코드가 한 줄도 돌지 않는다
    expect(check).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(check).toHaveBeenCalledTimes(1)
    // 두 번째 peek 는 진행 중인 확인을 공유한다
    expect(cache.peek('C:\\wt\\a')).toBe('unknown')
    expect(check).toHaveBeenCalledTimes(1)
    resolve('missing')
    await new Promise((r) => setTimeout(r, 0))
    expect(cache.peek('C:\\wt\\a')).toBe('missing')
  })

  it('tells onChange when a value first lands or changes, and not when it stays', async () => {
    let next: Presence = 'present'
    const onChange = vi.fn()
    const cache = new PresenceCache({ check: async () => next, onChange })
    await cache.refresh('C:\\wt\\a')
    expect(onChange).toHaveBeenCalledTimes(1)
    await cache.refresh('C:\\wt\\a')
    expect(onChange).toHaveBeenCalledTimes(1)
    next = 'unreachable'
    await cache.refresh('C:\\wt\\a')
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(cache.peek('C:\\wt\\a')).toBe('unreachable')
  })

  it('a check that rejects or an onChange that throws leaves nothing unhandled', async () => {
    const cache = new PresenceCache({
      check: async () => {
        throw new Error('boom')
      },
      onChange: () => {
        throw new Error('listener')
      },
      log: () => {}
    })
    expect(await cache.refresh('C:\\wt\\a')).toBe('unreachable')
  })

  it('a sweep refreshes every known path plus the ones it is given', async () => {
    const seen: string[] = []
    const cache = new PresenceCache({
      check: async (p) => {
        seen.push(p)
        return 'present'
      }
    })
    await cache.refresh('C:\\wt\\a')
    seen.length = 0
    await cache.sweep(['C:\\wt\\b'])
    expect(seen.sort()).toEqual(['C:\\wt\\a', 'C:\\wt\\b'])
    expect(cache.peek('C:\\wt\\b')).toBe('present')
  })

  it('start runs a sweep on each interval until stopped', async () => {
    vi.useFakeTimers()
    const check = vi.fn(async (): Promise<Presence> => 'present')
    const cache = new PresenceCache({ check })
    const stop = cache.start(1000, () => ['C:\\wt\\a'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(check).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(check).toHaveBeenCalledTimes(2)
  })
})

/** An access that answers from a set of present paths, ENOENT for everything else. */
const only =
  (...present: string[]) =>
  async (p: string): Promise<void> => {
    if (!present.includes(p)) throw enoent()
  }

// POSIX 에서 rootOf 는 앞의 두 조각뿐이라 "드라이브가 답한다"의 증거가 못 된다 — 폴더의 부모가 답해야 한다
describe('createPresenceCheck — POSIX parents', () => {
  it('an unplugged USB drive (its mount dir gone) is unreachable, not missing', async () => {
    const check = createPresenceCheck({ access: only('/media', '/media/u'), pool: createProbePool(), log: () => {} })
    expect(await check('/media/u/USB/wts/a')).toBe('unreachable')
  })

  it('an empty nofail mountpoint is unreachable, not missing', async () => {
    const check = createPresenceCheck({ access: only('/mnt', '/mnt/nas'), pool: createProbePool(), log: () => {} })
    expect(await check('/mnt/nas/wts/a')).toBe('unreachable')
  })

  it('a folder removed from a parent that answers is missing', async () => {
    const check = createPresenceCheck({ access: only('/home', '/home/u', '/home/u/wts'), pool: createProbePool(), log: () => {} })
    expect(await check('/home/u/wts/a')).toBe('missing')
  })
})

describe('the worktree slot is outside the PATH cap', () => {
  // I1: a stuck worktree check used to hold one of the PATH pool's two slots. One dead PATH root then
  // filled the cap, and the Git Bash install probe on C: was refused, so a session spawned without Git
  // Bash. The default check has its own slot now.
  it('a stuck worktree check plus one dead PATH root still leaves a PATH probe on a live drive answered', async () => {
    vi.useFakeTimers()
    const check = createPresenceCheck({ access: () => new Promise<void>(() => {}), log: () => {} })
    void check('\\\\nas1\\s\\wt\\a')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    // The process-wide PATH pool: the prober below uses it by default, as defaultProbe does.
    const deadPath = createProber({ access: () => new Promise<void>(() => {}), log: () => {} })
    void deadPath('Z:\\tools\\bash.exe')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    const live = createProber({ access: async () => {}, log: () => {} })
    const answer = live('C:\\Program Files\\Git\\bin\\bash.exe')
    await vi.advanceTimersByTimeAsync(0)
    expect(await answer).toBe('present')
    // Let the stuck calls go, so nothing is left counting in the shared pool.
    await vi.advanceTimersByTimeAsync(PROBE_STUCK_CEILING_MS)
  })
})

describe('an injected access that throws synchronously', () => {
  // m2: the worktree slot must be released even then, or every later check waits forever.
  it('releases the worktree slot, so the next check still answers', async () => {
    let first = true
    const check = createPresenceCheck({
      access: (p) => {
        if (first) {
          first = false
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        }
        return p ? Promise.resolve() : Promise.reject(new Error('no'))
      },
      pool: createProbePool(),
      log: () => {}
    })
    expect(await check('C:\\wt\\a')).toBe('unreachable')
    const next = await Promise.race([check('C:\\wt\\b'), new Promise((r) => setTimeout(() => r('hung'), 500))])
    expect(next).toBe('present')
  })
})

describe('refusals and the worktree sub-cap', () => {
  it('a check the shared pool refuses (no call made) keeps a known present', async () => {
    vi.useFakeTimers()
    const pool = createProbePool(1)
    let calls = 0
    const check = createPresenceCheck({
      access: async () => {
        calls++
      },
      pool,
      log: () => {}
    })
    const cache = new PresenceCache({ check })
    expect(await cache.refresh('C:\wt\a')).toBe('present')
    // A PATH probe on another root hangs, so the pool (cap 1) refuses everything after it without a call
    const hung = createProber({ access: () => new Promise<void>(() => {}), pool, log: () => {} })
    void hung('\\nas\share\bin\git.exe')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    const before = calls
    await cache.refresh('C:\wt\a')
    expect(calls).toBe(before) // refused: no call was made
    expect(cache.peek('C:\wt\a')).toBe('present')
  })

  it('a refusal with no earlier answer stays unknown', async () => {
    vi.useFakeTimers()
    const pool = createProbePool(1)
    const hung = createProber({ access: () => new Promise<void>(() => {}), pool, log: () => {} })
    void hung('\\nas\share\bin\git.exe')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    const cache = new PresenceCache({ check: createPresenceCheck({ access: async () => {}, pool, log: () => {} }) })
    await cache.refresh('C:\wt\a')
    expect(cache.peek('C:\wt\a')).toBe('unknown')
  })

  it('two dead worktree roots never hold more than one pool slot, and a stuck root is not re-probed', async () => {
    vi.useFakeTimers()
    let outstanding = 0
    let most = 0
    const touched: string[] = []
    const check = createPresenceCheck({
      access: (p) => {
        touched.push(p)
        outstanding++
        most = Math.max(most, outstanding)
        return new Promise<void>(() => {})
      },
      pool: createProbePool(),
      log: () => {}
    })
    const cache = new PresenceCache({ check })
    void cache.sweep(['\\nas1\s\wt\a', '\\nas2\s\wt\b'])
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS * 4)
    expect(most).toBe(1)
    // The next sweep skips the stuck root: no second call on \nas1
    const n = touched.length
    await cache.sweep()
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS * 4)
    expect(touched.length).toBe(n)
    expect(most).toBe(1)
  })
})

// The action lane: checks a person or a merge is waiting on (create, remove, run-delete, the merge
// markers). The sweep's one slot is for the whole process, so while it hung on a dead Z: share every
// other check, on any drive, was refused, and a merge into C: stopped on a Gate. The action lane is
// one call per root at a time instead: a stuck Z: never touches C:.
describe('createActionPresenceCheck', () => {
  const hungOnZ = (p: string): Promise<void> => (/^z:/i.test(p) ? new Promise<void>(() => {}) : Promise.resolve())

  it('a stuck call on Z: does not refuse or delay a check on C:', async () => {
    vi.useFakeTimers()
    const check = createActionPresenceCheck({ access: hungOnZ, log: () => {} })
    const z = check('Z:/wt/a')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    expect(await z).toBe('unreachable')
    const c = check('C:/wt/b')
    await vi.advanceTimersByTimeAsync(0)
    expect(await c).toBe('present')
    await vi.advanceTimersByTimeAsync(PROBE_STUCK_CEILING_MS)
  })

  it('a stuck sweep check on Z: does not refuse an action check on C:', async () => {
    vi.useFakeTimers()
    const sweep = createPresenceCheck({ access: hungOnZ, log: () => {} })
    void sweep('Z:/wt/a')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    expect(await sweep('C:/wt/b')).toBe('refused') // the sweep's own slot, as before
    const action = createActionPresenceCheck({ access: hungOnZ, log: () => {} })
    const c = action('C:/wt/b')
    await vi.advanceTimersByTimeAsync(0)
    expect(await c).toBe('present')
    await vi.advanceTimersByTimeAsync(PROBE_STUCK_CEILING_MS)
  })

  it('a root that timed out is tried again once its call settles (no five-minute rest)', async () => {
    vi.useFakeTimers()
    let release: () => void = () => {}
    let hang = true
    const check = createActionPresenceCheck({
      access: (p) => (hang && /^z:/i.test(p) ? new Promise<void>((r) => (release = r)) : Promise.resolve()),
      log: () => {}
    })
    const first = check('Z:/wt/a')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    expect(await first).toBe('unreachable')
    hang = false
    release()
    await vi.advanceTimersByTimeAsync(0)
    const again = check('Z:/wt/a')
    await vi.advanceTimersByTimeAsync(0)
    expect(await again).toBe('present')
  })
})

describe('askUntilAnswered', () => {
  it('a refusal is retried, within a bound, and the first real answer is kept', async () => {
    vi.useFakeTimers()
    const answers: CheckResult[] = ['refused', 'refused', 'missing']
    const r = askUntilAnswered(async () => answers.shift() ?? 'present', 'C:/x')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    expect(await r).toBe('missing')
  })
  it('gives up after its tries and says refused, never unreachable', async () => {
    vi.useFakeTimers()
    let n = 0
    const r = askUntilAnswered(async () => { n++; return 'refused' }, 'C:/x')
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS * 2)
    expect(await r).toBe('refused')
    expect(n).toBe(ASK_TRIES)
  })
  it('a check that rejects is unreachable, never missing', async () => {
    expect(await askUntilAnswered(async () => { throw new Error('boom') }, 'C:/x')).toBe('unreachable')
  })
})

// Stage 4 T1 review follow-up: a check a person waits on (the action lane) gets its call past the
// stuck-call cap; the sweep's background lane stays under it.
describe('the stuck-call cap and the two lanes', () => {
  it('with three roots stuck, the action lane asks a fresh root and the sweep lane is refused', async () => {
    const budget = new ProbeBudget()
    for (const r of ['Q:/', 'R:/', 'S:/'].map(rootOf)) {
      const t = await budget.enter(r)
      if (typeof t === 'string') throw new Error(t)
      t.timedOut()
    }
    const access = vi.fn(async () => {})
    const action = createActionPresenceCheck({ access, pool: createProbePool(1, PROBE_STUCK_CEILING_MS, budget), log: () => {} })
    expect(await action('D:/wt/a')).toBe('present')
    expect(access).toHaveBeenCalledTimes(1)
    const sweepAccess = vi.fn(async () => {})
    const sweep = createPresenceCheck({ access: sweepAccess, pool: createProbePool(1, PROBE_STUCK_CEILING_MS, budget), log: () => {} })
    expect(await sweep('E:/wt/b')).toBe('refused')
    expect(sweepAccess).not.toHaveBeenCalled()
  })
})

// Stage 4 T1 follow-up: an answer the pool shares from another call (same path, same kind) made no call
// of this attempt's own, so nothing let its slot go — the next check on that root waited forever. Two
// creations checking two missing names on one drive ask the same witness (the drive) back to back.
describe('an attempt answered by a shared call lets its slot go', () => {
  it('two missing names on one drive, asked together, leave the drive free for the next check', async () => {
    const enoent = (): Error => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const access = vi.fn(async (p: string) => {
      if (p.length <= 3) return // the drive itself (the witness)
      throw enoent()
    })
    const check = createActionPresenceCheck({ access, log: () => {}, pool: createProbePool(2, PROBE_STUCK_CEILING_MS, new ProbeBudget()) })
    for (let round = 0; round < 20; round++) {
      const both = await Promise.all([check(`C:/wt/a${round}`), check(`C:/wt/b${round}`)])
      expect(both).toEqual(['missing', 'missing'])
    }
    const next = await Promise.race([check('C:/wt/c'), new Promise((r) => setTimeout(() => r('hung'), 2_000))])
    expect(next).toBe('missing')
  })
})

