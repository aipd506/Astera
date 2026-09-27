import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import os from 'node:os'

// chokidar 를 가짜로 바꾼다 — 여기서 보려는 것은 감시가 아니라, 감시 이벤트가 IPC 로 나가는 모양이다
const fakes: (EventEmitter & { close: () => Promise<void> })[] = []
vi.mock('chokidar', () => ({
  default: {
    watch: () => {
      const w = Object.assign(new EventEmitter(), { close: async () => {} })
      fakes.push(w)
      return w
    }
  }
}))

import { FileWatcher } from './fileWatcher'
import { FILE_CHANGE_BATCH_MS, type FileChangeBatch } from '../core/files/changeBatch'

afterEach(() => {
  fakes.splice(0)
  vi.useRealTimers()
})

describe('FileWatcher — 감시 이벤트를 묶어 보낸다', () => {
  it('git checkout 처럼 1000 개의 이벤트가 쏟아져도 IPC 전송은 한 번이다', async () => {
    const root = path.join(os.tmpdir(), 'astera-no-such-root-fw')
    const send = vi.fn<(b: FileChangeBatch) => void>()
    const w = new FileWatcher(send)
    await w.watch(root)
    vi.useFakeTimers()
    const chok = fakes[0]
    for (let i = 0; i < 1000; i++) chok.emit('add', path.join(root, `d${i % 10}`, `f${i}.js`))
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(FILE_CHANGE_BATCH_MS)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].parents).toHaveLength(10)
    vi.useRealTimers()
    await w.unwatch()
  })

  // 감시를 멈출 때 창에 남은 이벤트는 버리지 않고 바로 보낸다 — 열린 버퍼가 마지막 변경을 놓치지 않게
  it('unwatch 는 모아 둔 이벤트를 바로 내보낸다', async () => {
    const root = path.join(os.tmpdir(), 'astera-no-such-root-fw2')
    const send = vi.fn<(b: FileChangeBatch) => void>()
    const w = new FileWatcher(send)
    await w.watch(root)
    fakes[0].emit('unlink', path.join(root, 'a.txt'))
    await w.unwatch()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].changes).toEqual([{ path: path.join(root, 'a.txt'), kind: 'unlink' }])
  })
})
