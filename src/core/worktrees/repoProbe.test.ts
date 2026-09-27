import { describe, it, expect, vi, afterEach } from 'vitest'
import path from 'node:path'
import { probeRepoRoot, REPO_PROBE_TIMEOUT_MS, type GitResult } from './git'

afterEach(() => {
  vi.useRealTimers()
})

// 새 세션 대화상자의 저장소 검사. UNC·\\wsl$ 자리에서 git 이 30초씩 붙잡혀 시작 버튼이 죽어 있던 것을
// 짧은 기한으로 끊고, 끊긴 것은 "저장소 아님" 이 아니라 "모름" 으로 답한다.
describe('probeRepoRoot', () => {
  it('기한은 5초를 넘지 않는다', () => {
    expect(REPO_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5_000)
  })

  it('git 이 루트를 말하면 repo', async () => {
    const run = vi.fn(async (): Promise<GitResult> => ({ ok: true, stdout: 'D:/r', stderr: '' }))
    expect(await probeRepoRoot('D:/r/sub', run)).toEqual({ kind: 'repo', root: path.resolve('D:/r') })
    // 기한을 git 에 넘긴다 — 기한이 지나면 git 도 죽는다
    expect(run).toHaveBeenCalledWith(['rev-parse', '--show-toplevel'], {
      cwd: 'D:/r/sub',
      timeoutMs: REPO_PROBE_TIMEOUT_MS
    })
  })

  it('git 이 아니라고 답하면(종료 코드) none', async () => {
    const run = async (): Promise<GitResult> => ({ ok: false, stdout: '', stderr: 'not a git repository', exitCode: 128 })
    expect(await probeRepoRoot('D:/x', run)).toEqual({ kind: 'none' })
  })

  it('git 이 기한에 걸리면 unknown — "저장소 아님" 이 아니다', async () => {
    const run = async (): Promise<GitResult> => ({ ok: false, stdout: '', stderr: 'timed out', timedOut: true })
    expect(await probeRepoRoot('\\\\wsl$\\Ubuntu\\p', run)).toEqual({ kind: 'unknown' })
  })

  it('git 이 죽지 않고 붙잡혀 있어도 기한에 unknown 으로 답한다', async () => {
    vi.useFakeTimers()
    const run = (): Promise<GitResult> => new Promise(() => {})
    let answer: unknown = null
    void probeRepoRoot('\\\\server\\share', run).then((a) => (answer = a))
    await vi.advanceTimersByTimeAsync(REPO_PROBE_TIMEOUT_MS - 1)
    expect(answer).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(answer).toEqual({ kind: 'unknown' })
  })

  it('run 이 던지면 unknown (거부가 새지 않는다)', async () => {
    const run = async (): Promise<GitResult> => {
      throw new Error('boom')
    }
    expect(await probeRepoRoot('D:/x', run)).toEqual({ kind: 'unknown' })
  })
})
