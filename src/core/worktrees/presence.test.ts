import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProbePool, createProber, PROBE_TIMEOUT_MS } from '../sessions/pathProbe'
import { createPresenceCheck, PresenceCache, type CheckResult, type Presence } from './presence'

const enoent = (): Error => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
const eperm = (): Error => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })

afterEach(() => {
  vi.useRealTimers()
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
