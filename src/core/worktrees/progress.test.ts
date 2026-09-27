import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { WorktreeCreateProgress } from '../types'
import { throttleProgress, PROGRESS_INTERVAL_MS } from './progress'

// 복사는 파일마다 진행을 알린다 — 작은 파일 수천 개면 IPC 메시지 수천 개다. 메인은 이것을 초당
// 약 4번으로 줄여 보낸다. 단계가 바뀌는 알림은 기다리지 않는다(어느 단계인지가 가장 중요한 정보다).
describe('throttleProgress', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const copy = (n: number): WorktreeCreateProgress => ({
    stage: 'copy-includes', bytesCopied: n, bytesTotal: 100, filesCopied: n, filesTotal: 100
  })

  it('첫 알림은 곧바로 보내고, 창 안의 알림들은 창 끝에 가장 최근 것 하나로 보낸다', () => {
    const sent: WorktreeCreateProgress[] = []
    const t = throttleProgress((p) => sent.push(p))
    t.push(copy(1))
    t.push(copy(2))
    t.push(copy(3))
    expect(sent).toEqual([copy(1)])
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS)
    expect(sent).toEqual([copy(1), copy(3)])
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS * 4)
    expect(sent).toEqual([copy(1), copy(3)]) // 새 알림이 없으면 아무것도 보내지 않는다
  })

  it('1초 동안 쉬지 않고 알려도 약 4번만 보낸다', () => {
    const sent: WorktreeCreateProgress[] = []
    const t = throttleProgress((p) => sent.push(p))
    for (let i = 0; i < 100; i++) {
      t.push(copy(i))
      vi.advanceTimersByTime(10)
    }
    expect(sent.length).toBeGreaterThanOrEqual(4)
    expect(sent.length).toBeLessThanOrEqual(5)
  })

  it('단계가 바뀌면 창을 기다리지 않고 곧바로 보낸다', () => {
    const sent: WorktreeCreateProgress[] = []
    const t = throttleProgress((p) => sent.push(p))
    t.push({ stage: 'fetch' })
    t.push({ stage: 'checkout' })
    t.push({ stage: 'copy-includes' })
    expect(sent.map((p) => p.stage)).toEqual(['fetch', 'checkout', 'copy-includes'])
  })

  it('flush 는 남은 알림을 곧바로 보내고, dispose 뒤로는 아무것도 보내지 않는다', () => {
    const sent: WorktreeCreateProgress[] = []
    const t = throttleProgress((p) => sent.push(p))
    t.push(copy(1))
    t.push(copy(2))
    t.flush()
    expect(sent).toEqual([copy(1), copy(2)])
    t.push(copy(3))
    t.dispose()
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS * 2)
    t.push(copy(4))
    expect(sent).toEqual([copy(1), copy(2)])
  })

  it('보내는 쪽이 던져도 삼킨다 — 진행 알림이 만들기를 깨뜨리지 않는다', () => {
    const t = throttleProgress(() => {
      throw new Error('window gone')
    })
    expect(() => t.push(copy(1))).not.toThrow()
    t.push(copy(2))
    expect(() => vi.advanceTimersByTime(PROGRESS_INTERVAL_MS)).not.toThrow()
  })
})
