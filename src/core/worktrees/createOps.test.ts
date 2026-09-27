import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { WorktreeCreateEvent, WorktreeCreateProgress } from '../types'
import { createWorktreeOps } from './createOps'
import { PROGRESS_INTERVAL_MS } from './progress'

type Args = { onProgress?: (p: WorktreeCreateProgress) => void; signal?: AbortSignal }

// 메인이 렌더러로 진행을 넘기는 자리. opId 가 있는 호출만 진행을 보내고 취소를 받는다 — 없는 호출은
// 예전과 똑같이 신호도 진행 콜백도 없이 만든다.
describe('createWorktreeOps', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('opId 가 없으면 진행도 신호도 넘기지 않는다', async () => {
    const seen: Args[] = []
    const ops = createWorktreeOps({
      create: async (a: Args) => { seen.push(a); return 'ok' },
      send: () => { throw new Error('must not send') }
    })
    expect(await ops.create({}, undefined)).toBe('ok')
    expect(seen[0].onProgress).toBeUndefined()
    expect(seen[0].signal).toBeUndefined()
  })

  it('진행을 초당 약 4번으로 줄여 opId 와 함께 보내고, 끝나면 progress: null 을 보낸다', async () => {
    const sent: WorktreeCreateEvent[] = []
    let finish: () => void = () => {}
    const ops = createWorktreeOps({
      create: (a: Args) =>
        new Promise<string>((resolve) => {
          a.onProgress?.({ stage: 'fetch' })
          a.onProgress?.({ stage: 'checkout' })
          for (let i = 1; i <= 40; i++) {
            const n = i
            setTimeout(() => a.onProgress?.({ stage: 'copy-includes', filesCopied: n, filesTotal: 40 }), n * 25)
          }
          finish = () => resolve('done')
        }),
      send: (ev) => sent.push(ev)
    })
    const p = ops.create({}, 'op1')
    await vi.advanceTimersByTimeAsync(1000 + PROGRESS_INTERVAL_MS)
    finish()
    expect(await p).toBe('done')
    const copies = sent.filter((e) => e.progress?.stage === 'copy-includes')
    expect(sent.slice(0, 2).map((e) => e.progress?.stage)).toEqual(['fetch', 'checkout'])
    expect(copies.length).toBeGreaterThanOrEqual(4)
    expect(copies.length).toBeLessThanOrEqual(6)
    expect(copies[copies.length - 1].progress?.filesCopied).toBe(40) // 마지막 숫자는 잃지 않는다
    expect(sent.every((e) => e.opId === 'op1')).toBe(true)
    expect(sent[sent.length - 1]).toEqual({ opId: 'op1', progress: null })
  })

  it('cancel(opId) 는 그 호출의 신호를 끊고, 끝난 뒤나 모르는 id 에는 false 다', async () => {
    let signal: AbortSignal | undefined
    const ops = createWorktreeOps({
      create: (a: Args) =>
        new Promise<string>((_resolve, reject) => {
          signal = a.signal
          a.signal?.addEventListener('abort', () => reject(new Error('WORKTREE_CANCELLED: x')))
        }),
      send: () => {}
    })
    const p = ops.create({}, 'op2')
    const settled = p.catch((e: Error) => e.message)
    expect(ops.cancel('nope')).toBe(false)
    expect(ops.cancel('op2')).toBe(true)
    expect(signal?.aborted).toBe(true)
    expect(await settled).toMatch(/WORKTREE_CANCELLED/)
    expect(ops.cancel('op2')).toBe(false)
  })

  it('실패하면 progress: null 을 보내지 않고, 남은 진행도 보내지 않는다', async () => {
    const sent: WorktreeCreateEvent[] = []
    const ops = createWorktreeOps({
      create: async (a: Args) => {
        a.onProgress?.({ stage: 'copy-includes', filesCopied: 1, filesTotal: 2 })
        a.onProgress?.({ stage: 'copy-includes', filesCopied: 2, filesTotal: 2 })
        throw new Error('GIT_ADD_FAILED: x')
      },
      send: (ev) => sent.push(ev)
    })
    await expect(ops.create({}, 'op3')).rejects.toThrow(/GIT_ADD_FAILED/)
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS * 2)
    expect(sent).toEqual([{ opId: 'op3', progress: { stage: 'copy-includes', filesCopied: 1, filesTotal: 2 } }])
  })
})
