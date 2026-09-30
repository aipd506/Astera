import { describe, it, expect, vi, afterEach } from 'vitest'
import { createDirLoadQueue, planBatchReload, createDelayedPending, ROW_SPINNER_DELAY_MS } from './dirReload'

/** 손으로 끝내는 load — 몇 개가 동시에 도는지, 어떤 순서로 불렸는지를 밖에서 본다 */
function manualLoad(): {
  load: (dir: string) => Promise<void>
  calls: string[]
  inFlight: Map<string, number>
  maxInFlight: Map<string, number>
  finish: (dir: string, fail?: boolean) => Promise<void>
} {
  const calls: string[] = []
  const inFlight = new Map<string, number>()
  const maxInFlight = new Map<string, number>()
  const resolvers = new Map<string, { ok: () => void; fail: (e: Error) => void }[]>()
  return {
    calls,
    inFlight,
    maxInFlight,
    load: (dir) => {
      calls.push(dir)
      const n = (inFlight.get(dir) ?? 0) + 1
      inFlight.set(dir, n)
      maxInFlight.set(dir, Math.max(maxInFlight.get(dir) ?? 0, n))
      return new Promise<void>((ok, fail) => {
        if (!resolvers.has(dir)) resolvers.set(dir, [])
        resolvers.get(dir)!.push({ ok, fail })
      }).finally(() => inFlight.set(dir, (inFlight.get(dir) ?? 1) - 1))
    },
    finish: async (dir, fail) => {
      const r = resolvers.get(dir)?.shift()
      if (fail) r?.fail(new Error('boom'))
      else r?.ok()
      // 완료 뒤의 이어 읽기까지 마이크로태스크를 흘린다
      for (let i = 0; i < 10; i++) await Promise.resolve()
    }
  }
}

describe('createDirLoadQueue — 같은 폴더를 겹쳐 읽지 않는다', () => {
  it('읽는 동안 들어온 요청은 끝난 뒤 한 번만 더 읽는다', async () => {
    const m = manualLoad()
    const q = createDirLoadQueue(m.load)
    q.request('/r/a')
    q.request('/r/a')
    q.request('/r/a')
    q.request('/r/a')
    expect(m.calls).toEqual(['/r/a'])
    await m.finish('/r/a')
    expect(m.calls).toEqual(['/r/a', '/r/a'])
    await m.finish('/r/a')
    expect(m.calls).toEqual(['/r/a', '/r/a'])
    expect(m.maxInFlight.get('/r/a')).toBe(1)
  })

  it('다른 폴더는 서로 기다리지 않는다', () => {
    const m = manualLoad()
    const q = createDirLoadQueue(m.load)
    q.request('/r/a')
    q.request('/r/b')
    expect(m.calls).toEqual(['/r/a', '/r/b'])
  })

  it('읽기가 실패해도 다음 요청은 다시 읽는다 — 거절이 새지 않는다', async () => {
    const m = manualLoad()
    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)
    try {
      const q = createDirLoadQueue(m.load)
      q.request('/r/a')
      await m.finish('/r/a', true)
      q.request('/r/a')
      expect(m.calls).toEqual(['/r/a', '/r/a'])
      await new Promise((r) => setTimeout(r, 0))
      expect(onUnhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('load 가 동기로 던져도 대기 표시가 남지 않는다', async () => {
    const q = createDirLoadQueue(() => {
      throw new Error('sync')
    })
    q.request('/r/a')
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(q.isPending('/r/a')).toBe(false)
  })

  // 로딩 표시의 근거 — 읽는 동안(이어 읽기까지 포함) pending 이고, 다 끝나야 풀린다
  it('읽는 동안은 pending 이고, 이어 읽기까지 끝나야 풀린다', async () => {
    const m = manualLoad()
    const seen: string[][] = []
    const q = createDirLoadQueue(m.load, (p) => seen.push([...p]))
    expect(q.isPending('/r/a')).toBe(false)
    q.request('/r/a')
    expect(q.isPending('/r/a')).toBe(true)
    q.request('/r/a')
    await m.finish('/r/a')
    expect(q.isPending('/r/a')).toBe(true) // 이어 읽는 중
    await m.finish('/r/a')
    expect(q.isPending('/r/a')).toBe(false)
    // 켜질 때 한 번, 꺼질 때 한 번 — 이어 읽기 사이에 깜빡이지 않는다
    expect(seen).toEqual([['/r/a'], []])
  })
})

describe('planBatchReload — 한 묶음에서 무엇을 다시 읽는가', () => {
  const root = '/r'
  it('펼쳐진 폴더와 루트만 다시 읽고, 캐시에 없는 폴더는 건드리지 않는다', () => {
    const cached = new Set(['/r', '/r/a', '/r/b'])
    const expanded = new Set(['/r/a'])
    const plan = planBatchReload(['/r', '/r/a', '/r/b', '/r/never'], {
      root,
      isCached: (d) => cached.has(d),
      isExpanded: (d) => expanded.has(d)
    })
    expect(plan.reload).toEqual(['/r', '/r/a'])
    // 접힌 채 캐시에 남은 폴더는 지금 읽지 않고 캐시를 버린다 — 다시 펼칠 때 새로 읽힌다
    expect(plan.evict).toEqual(['/r/b'])
  })

  it('같은 폴더가 여러 번 와도 한 번만 계획한다', () => {
    const plan = planBatchReload(['/r/a', '/r/a', '/r/a'], {
      root,
      isCached: () => true,
      isExpanded: () => true
    })
    expect(plan.reload).toEqual(['/r/a'])
  })
})

// npm install 이 펼친 폴더에 100ms 마다 묶음을 보내면, 짧은 읽기마다 스피너가 켜졌다 꺼져 깜빡인다.
// 읽기가 ROW_SPINNER_DELAY_MS 넘게 이어질 때만 보인다
describe('createDelayedPending — 행 스피너의 보이기 지연', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('지연보다 짧은 읽기는 한 번도 보이지 않는다', () => {
    vi.useFakeTimers()
    const shown: string[][] = []
    const d = createDelayedPending((s) => shown.push([...s]))
    for (let i = 0; i < 10; i++) {
      d.update(new Set(['/r/a']))
      vi.advanceTimersByTime(ROW_SPINNER_DELAY_MS - 60)
      d.update(new Set())
      vi.advanceTimersByTime(60)
    }
    expect(shown).toEqual([])
  })

  it('지연을 넘긴 읽기는 보이고, 끝나면 바로 사라진다', () => {
    vi.useFakeTimers()
    const shown: string[][] = []
    const d = createDelayedPending((s) => shown.push([...s]))
    d.update(new Set(['/r/a']))
    vi.advanceTimersByTime(ROW_SPINNER_DELAY_MS - 1)
    expect(shown).toEqual([])
    vi.advanceTimersByTime(1)
    expect(shown).toEqual([['/r/a']])
    d.update(new Set())
    expect(shown).toEqual([['/r/a'], []])
  })

  it('clear 는 걸린 타이머를 모두 거두고, 그 뒤에도 다시 쓸 수 있다', () => {
    vi.useFakeTimers()
    const shown: string[][] = []
    const d = createDelayedPending((s) => shown.push([...s]))
    d.update(new Set(['/r/a']))
    d.clear()
    vi.advanceTimersByTime(ROW_SPINNER_DELAY_MS * 2)
    expect(shown).toEqual([])
    d.update(new Set(['/r/b']))
    vi.advanceTimersByTime(ROW_SPINNER_DELAY_MS)
    expect(shown).toEqual([['/r/b']])
  })
})
