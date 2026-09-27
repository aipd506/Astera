import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { countFileOp, type FileOpProgress } from './fileOpProgress'

// 삭제·복사는 항목마다 한 번씩 센다 — 수만 개의 작은 파일이면 수만 번이다. 메인은 그것을 초당 약 4번의
// IPC 로 줄여 보내고, 창이 끝날 때는 가장 최근 수를 보내 마지막 숫자를 잃지 않는다.
describe('countFileOp — 진행 알림 조절', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('한 창 안의 1000개는 첫 알림 하나와 창 끝의 최신 수 하나, 두 번만 보낸다', () => {
    const sent: FileOpProgress[] = []
    const c = countFileOp((p) => sent.push(p))
    for (let i = 0; i < 1000; i++) c.entry('delete')
    expect(sent).toEqual([{ stage: 'delete', count: 1 }])
    vi.advanceTimersByTime(250)
    expect(sent).toEqual([
      { stage: 'delete', count: 1 },
      { stage: 'delete', count: 1000 }
    ])
    c.end()
  })

  it('계속 이어지는 흐름은 초당 약 4번이다', () => {
    const sent: FileOpProgress[] = []
    const c = countFileOp((p) => sent.push(p))
    for (let ms = 0; ms < 1000; ms += 10) {
      c.entry('copy')
      vi.advanceTimersByTime(10)
    }
    expect(sent.length).toBeGreaterThanOrEqual(4)
    expect(sent.length).toBeLessThanOrEqual(5)
    c.end()
  })

  it('단계가 바뀌면 곧바로 보내고, 수는 그 단계에서 다시 센다', () => {
    const sent: FileOpProgress[] = []
    const c = countFileOp((p) => sent.push(p))
    c.entry('snapshot')
    c.entry('snapshot')
    c.entry('delete')
    expect(sent).toEqual([
      { stage: 'snapshot', count: 1 },
      { stage: 'delete', count: 1 }
    ])
    c.end()
  })

  it('end 는 붙들고 있던 최신 수를 보내고, 그 뒤로는 아무것도 보내지 않는다', () => {
    const sent: FileOpProgress[] = []
    const c = countFileOp((p) => sent.push(p))
    c.entry('copy')
    c.entry('copy')
    c.entry('copy')
    c.end()
    expect(sent.at(-1)).toEqual({ stage: 'copy', count: 3 })
    const n = sent.length
    c.entry('copy')
    vi.advanceTimersByTime(1000)
    expect(sent.length).toBe(n)
  })

  it('보내기가 던져도(창이 사라짐) 세기는 계속되고 예외가 새지 않는다', () => {
    const c = countFileOp(() => {
      throw new Error('window gone')
    })
    expect(() => {
      for (let i = 0; i < 10; i++) c.entry('delete')
      vi.advanceTimersByTime(300)
      c.end()
    }).not.toThrow()
  })
})
