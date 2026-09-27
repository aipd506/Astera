import { describe, it, expect, vi } from 'vitest'
import { subscribeFileChanges } from './fileChanges'
import type { FileChangeBatch } from '../../../core/files/changeBatch'

/** window.api.on 의 모양만 흉내 낸다 — 채널별 구독자를 모아 두고 밖에서 쏠 수 있게 한다 */
function fakeOn(): {
  on: (ch: string, cb: (p: unknown) => void) => () => void
  fire: (ch: string, p: unknown) => void
  count: () => number
} {
  const subs = new Map<string, Set<(p: unknown) => void>>()
  return {
    on: (ch, cb) => {
      if (!subs.has(ch)) subs.set(ch, new Set())
      subs.get(ch)!.add(cb)
      return () => subs.get(ch)!.delete(cb)
    },
    fire: (ch, p) => subs.get(ch)?.forEach((cb) => cb(p)),
    count: () => [...subs.values()].reduce((n, s) => n + s.size, 0)
  }
}

describe('subscribeFileChanges — 새 묶음 채널과 예전 한 건 채널을 같은 모양으로 받는다', () => {
  it('묶음(files:changedBatch)은 그대로 넘긴다', () => {
    const f = fakeOn()
    const cb = vi.fn<(b: FileChangeBatch) => void>()
    subscribeFileChanges(f.on, cb)
    const batch: FileChangeBatch = { parents: ['/r'], changes: [{ path: '/r/a', kind: 'add' }] }
    f.fire('files:changedBatch', batch)
    expect(cb).toHaveBeenCalledWith(batch)
  })

  it('예전 한 건(files:changed)은 한 건짜리 묶음으로 바꿔 넘긴다', () => {
    const f = fakeOn()
    const cb = vi.fn<(b: FileChangeBatch) => void>()
    subscribeFileChanges(f.on, cb)
    f.fire('files:changed', { path: '/r/a/x.ts', kind: 'unlink' })
    expect(cb).toHaveBeenCalledWith({ parents: ['/r/a'], changes: [{ path: '/r/a/x.ts', kind: 'unlink' }] })
  })

  it('해제하면 두 채널 모두에서 빠진다', () => {
    const f = fakeOn()
    const off = subscribeFileChanges(f.on, () => {})
    expect(f.count()).toBe(2)
    off()
    expect(f.count()).toBe(0)
  })
})
