import { describe, it, expect } from 'vitest'
import { goneWorktreeProjects } from './hiddenHistory'
import { absPath } from '../testPaths'
import type { CheckResult } from './presence'

const ROOT = absPath('Users', 'me', 'astera-worktrees')
/** Every path answers `missing` except the ones named alive. */
const gone = (...alive: string[]) => async (p: string): Promise<CheckResult> => (alive.includes(p) ? 'present' : 'missing')

describe('goneWorktreeProjects', () => {
  it('워크트리 루트 밑에 있고 폴더가 없는 것만 고른다', async () => {
    const a = absPath('Users', 'me', 'astera-worktrees', 'astera', '1')
    const b = absPath('Users', 'me', 'astera-worktrees', 'astera', '2')
    expect(await goneWorktreeProjects([a, b], ROOT, gone(b))).toEqual([a])
  })

  // 사용자가 지운 *실제* 프로젝트는 감추지 않는다 — 트랜스크립트가 남아 있는 기록이고 나중에
  // 읽고 싶을 수 있다. 이 판정이 루트 밑으로 좁혀진 이유가 이것이다
  it('루트 밖의 폴더 없는 프로젝트는 고르지 않고, 묻지도 않는다', async () => {
    const outside = absPath('work', 'deleted-project')
    const asked: string[] = []
    expect(await goneWorktreeProjects([outside], ROOT, async (p) => { asked.push(p); return 'missing' })).toEqual([])
    expect(asked).toEqual([])
  })

  it('루트 자신은 고르지 않는다 — 워크트리가 아니라 그것들을 담는 폴더다', async () => {
    expect(await goneWorktreeProjects([ROOT], ROOT, gone())).toEqual([])
  })

  it('폴더가 살아 있으면 고르지 않는다', async () => {
    const alive = absPath('Users', 'me', 'astera-worktrees', 'astera', 'keep')
    expect(await goneWorktreeProjects([alive], ROOT, gone(alive))).toEqual([])
  })

  it('받은 문자열을 그대로 돌려준다 — 정규화한 값을 주지 않는다', async () => {
    const raw = absPath('Users', 'me', 'astera-worktrees', 'astera', 'x')
    expect((await goneWorktreeProjects([raw], ROOT, gone()))[0]).toBe(raw)
  })

  // 확인은 비동기로, 시간 제한을 두고 한다(presence.ts). 동기 existsSync 는 끊긴 네트워크 공유 위의
  // 루트에서 히스토리를 여는 것만으로 메인 스레드를 세웠다. 그리고 확인하지 못한 것은 없는 것이 아니다.
  it('닿지 않거나 확인이 거절되거나 실패한 폴더는 감추지 않는다', async () => {
    const dead = absPath('Users', 'me', 'astera-worktrees', 'astera', 'dead')
    const busy = absPath('Users', 'me', 'astera-worktrees', 'astera', 'busy')
    const odd = absPath('Users', 'me', 'astera-worktrees', 'astera', 'odd')
    const answer = async (p: string): Promise<CheckResult> => {
      if (p === odd) throw new Error('boom')
      return p === dead ? 'unreachable' : 'refused'
    }
    expect(await goneWorktreeProjects([dead, busy, odd], ROOT, answer)).toEqual([])
  })
})
