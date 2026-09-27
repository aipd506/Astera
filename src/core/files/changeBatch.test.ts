import { describe, it, expect, vi, afterEach } from 'vitest'
import { createChangeBatcher, toBatch, FILE_CHANGE_BATCH_MS, type FileChangeBatch } from './changeBatch'

afterEach(() => {
  vi.useRealTimers()
})

describe('toBatch — 한 묶음 안의 변경을 정리한다', () => {
  it('바뀐 부모 폴더를 중복 없이, 처음 나온 순서대로 모은다', () => {
    const b = toBatch([
      { path: '/r/a/x.ts', kind: 'add' },
      { path: '/r/b/y.ts', kind: 'unlink' },
      { path: '/r/a/z.ts', kind: 'add' },
      { path: '/r/a/sub', kind: 'addDir' }
    ])
    expect(b.parents).toEqual(['/r/a', '/r/b'])
  })

  // 내용 변경은 트리 모양을 바꾸지 않는다 — 그 부모까지 다시 읽을 까닭이 없다
  it('change 는 부모 목록에 넣지 않지만 변경 목록에는 남긴다', () => {
    const b = toBatch([{ path: '/r/a/x.ts', kind: 'change' }])
    expect(b.parents).toEqual([])
    expect(b.changes).toEqual([{ path: '/r/a/x.ts', kind: 'change' }])
  })

  // 같은 파일이 창 안에서 여러 번 바뀌면 마지막 상태 하나만 남는다 — 열린 버퍼를 한 번만 다시 읽는다
  it('같은 경로의 변경은 마지막 종류 하나로 합친다', () => {
    const b = toBatch([
      { path: '/r/x.ts', kind: 'change' },
      { path: '/r/y.ts', kind: 'add' },
      { path: '/r/x.ts', kind: 'unlink' },
      { path: '/r/x.ts', kind: 'add' }
    ])
    expect(b.changes).toEqual([
      { path: '/r/x.ts', kind: 'add' },
      { path: '/r/y.ts', kind: 'add' }
    ])
  })
})

describe('createChangeBatcher — 감시 이벤트를 창 단위로 묶어 보낸다', () => {
  it('창이 닫히기 전에는 보내지 않고, 창이 닫히면 한 번 보낸다', () => {
    vi.useFakeTimers()
    const send = vi.fn<(b: FileChangeBatch) => void>()
    const b = createChangeBatcher(send)
    b.push({ path: '/r/a/x.ts', kind: 'add' })
    vi.advanceTimersByTime(FILE_CHANGE_BATCH_MS - 1)
    b.push({ path: '/r/a/y.ts', kind: 'add' })
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].parents).toEqual(['/r/a'])
    expect(send.mock.calls[0][0].changes).toHaveLength(2)
  })

  // 창은 첫 이벤트에서 시작한다 — 끝없이 이어지는 이벤트(npm install)가 전송을 영영 미루지 않게,
  // 마지막 이벤트마다 다시 늘어나는 디바운스가 아니다
  it('이벤트가 계속 들어와도 창마다 한 번씩 보낸다', () => {
    vi.useFakeTimers()
    const send = vi.fn<(b: FileChangeBatch) => void>()
    const b = createChangeBatcher(send)
    for (let t = 0; t < FILE_CHANGE_BATCH_MS * 3; t += 10) {
      b.push({ path: `/r/d${t}/f`, kind: 'add' })
      vi.advanceTimersByTime(10)
    }
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('1000 개의 이벤트가 한 창에 오면 IPC 전송은 한 번이다', () => {
    vi.useFakeTimers()
    const send = vi.fn<(b: FileChangeBatch) => void>()
    const b = createChangeBatcher(send)
    for (let i = 0; i < 1000; i++) b.push({ path: `/r/pkg${i % 7}/f${i}.js`, kind: 'add' })
    vi.advanceTimersByTime(FILE_CHANGE_BATCH_MS)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].parents).toHaveLength(7)
    expect(send.mock.calls[0][0].changes).toHaveLength(1000)
  })

  it('빈 창에서는 아무것도 보내지 않는다', () => {
    vi.useFakeTimers()
    const send = vi.fn()
    createChangeBatcher(send)
    vi.advanceTimersByTime(FILE_CHANGE_BATCH_MS * 5)
    expect(send).not.toHaveBeenCalled()
  })

  // 감시를 멈추거나 루트를 바꿀 때 — 모아 둔 것을 바로 보내고 타이머를 남기지 않는다
  it('flush 는 모아 둔 것을 바로 보내고 창을 닫는다', () => {
    vi.useFakeTimers()
    const send = vi.fn<(b: FileChangeBatch) => void>()
    const b = createChangeBatcher(send)
    b.push({ path: '/r/x', kind: 'add' })
    b.flush()
    expect(send).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(FILE_CHANGE_BATCH_MS * 2)
    expect(send).toHaveBeenCalledTimes(1)
    b.flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  // 보내기가 던져도(창이 이미 닫힌 뒤의 webContents 등) 타이머 콜백 밖으로 새지 않고, 다음 창은 산다
  it('send 가 던져도 다음 창을 막지 않는다', () => {
    vi.useFakeTimers()
    const send = vi.fn(() => {
      throw new Error('gone')
    })
    const b = createChangeBatcher(send)
    b.push({ path: '/r/x', kind: 'add' })
    expect(() => vi.advanceTimersByTime(FILE_CHANGE_BATCH_MS)).not.toThrow()
    b.push({ path: '/r/y', kind: 'add' })
    vi.advanceTimersByTime(FILE_CHANGE_BATCH_MS)
    expect(send).toHaveBeenCalledTimes(2)
  })
})
