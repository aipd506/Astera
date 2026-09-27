import { describe, it, expect, vi } from 'vitest'
import type { WorktreeCreateEvent } from '../../../core/types'
import { trackWorktreeCreate } from './worktreeCreate'

function fakeApi(cancelResult: Promise<boolean> = Promise.resolve(true)) {
  let listener: ((ev: WorktreeCreateEvent) => void) | null = null
  const off = vi.fn(() => void (listener = null))
  return {
    emit: (ev: WorktreeCreateEvent) => listener?.(ev),
    off,
    api: {
      on: vi.fn((channel: 'worktree:createProgress', cb: (ev: WorktreeCreateEvent) => void) => {
        expect(channel).toBe('worktree:createProgress')
        listener = cb
        return off
      }),
      cancelCreate: vi.fn(() => cancelResult)
    }
  }
}

// 대화상자가 한 번의 만들기를 지켜보는 자리: 제 opId 의 진행만 받고, 취소는 그 opId 로 메인에 묻는다.
describe('trackWorktreeCreate', () => {
  it('제 opId 의 진행만 넘기고, 다른 만들기의 진행은 무시한다', () => {
    const f = fakeApi()
    const seen: unknown[] = []
    const track = trackWorktreeCreate(f.api, 'op-a', (p) => seen.push(p))
    f.emit({ opId: 'op-b', progress: { stage: 'fetch' } })
    f.emit({ opId: 'op-a', progress: { stage: 'checkout' } })
    f.emit({ opId: 'op-a', progress: null })
    expect(seen).toEqual([{ stage: 'checkout' }, null])
    expect(track.opId).toBe('op-a')
  })

  it('cancel 은 그 opId 로 cancelCreate(중단)를 부른다', () => {
    const f = fakeApi()
    const track = trackWorktreeCreate(f.api, 'op-a', () => {})
    track.cancel()
    expect(f.api.cancelCreate).toHaveBeenCalledWith('op-a')
  })

  it('cancelCreate 가 거절돼도 처리되지 않은 거절을 남기지 않는다', async () => {
    const f = fakeApi(Promise.reject(new Error('ipc gone')))
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      trackWorktreeCreate(f.api, 'op-a', () => {}).cancel()
      await new Promise((r) => setTimeout(r, 20))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('stop 은 구독을 끊는다', () => {
    const f = fakeApi()
    const seen: unknown[] = []
    const track = trackWorktreeCreate(f.api, 'op-a', (p) => seen.push(p))
    track.stop()
    expect(f.off).toHaveBeenCalledTimes(1)
    f.emit({ opId: 'op-a', progress: { stage: 'fetch' } })
    expect(seen).toEqual([])
  })
})
