import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProbePool, PROBE_TIMEOUT_MS } from '../sessions/pathProbe'
import { createPresenceCheck, PresenceCache, type Presence } from './presence'

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
    let got: Presence | null = null
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
