import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { createWorktree } from './create'
import { WorktreeRegistry } from './registry'
import { git, localBranchExists } from './git'
import { makeRepo, addOrigin, tempDir } from './testRepo'

let repo: string
let root: string
let reg: WorktreeRegistry

const gitIn = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim()

beforeEach(async () => {
  repo = await makeRepo('astera-wt-create-')
  root = await tempDir('astera-wt-root-')
  const regDir = await tempDir('astera-wt-regd-')
  reg = new WorktreeRegistry(path.join(regDir, 'worktrees.json'), root)
  await reg.load()
})

describe('createWorktree', () => {
  it('로컬 main 기반: 브랜치·경로·레지스트리·branch.base 기록', async () => {
    const { info, warnings } = await createWorktree({ repoPath: repo, name: 'Login Fix', registry: reg })
    expect(info.name).toBe('Login-Fix')
    expect(info.branch).toBe('Test-User/Login-Fix')
    expect(info.baseRef).toBe('main')
    expect(path.resolve(path.dirname(info.path))).toBe(path.resolve(path.join(root, path.basename(repo))))
    expect(existsSync(path.join(info.path, 'f.txt'))).toBe(true)
    expect(reg.get(info.id)?.path).toBe(info.path)
    const base = await git(['config', `branch.${info.branch}.base`], { cwd: repo })
    expect(base.stdout).toBe('refs/heads/main')
    expect(warnings).toEqual([])
  })

  it('origin이 있으면 origin/main 기반', async () => {
    await addOrigin(repo)
    const { info } = await createWorktree({ repoPath: repo, registry: reg })
    expect(info.baseRef).toBe('origin/main')
  })

  it('이름 충돌 시 -2 접미사', async () => {
    const a = await createWorktree({ repoPath: repo, name: 'dup', registry: reg })
    const b = await createWorktree({ repoPath: repo, name: 'dup', registry: reg })
    expect(a.info.name).toBe('dup')
    expect(b.info.name).toBe('dup-2')
    expect(b.info.branch).toBe('Test-User/dup-2')
  })

  it('.worktreeinclude 항목이 새 worktree에 복사된다', async () => {
    await fs.writeFile(path.join(repo, '.gitignore'), '.env\n', 'utf8')
    await fs.writeFile(path.join(repo, '.env'), 'K=1', 'utf8')
    await fs.writeFile(path.join(repo, '.worktreeinclude'), '.env\n', 'utf8')
    execFileSync('git', ['add', '.gitignore', '.worktreeinclude'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'inc'], { cwd: repo, windowsHide: true })
    const { info } = await createWorktree({ repoPath: repo, registry: reg })
    expect(await fs.readFile(path.join(info.path, '.env'), 'utf8')).toBe('K=1')
  })

  it('git repo가 아니면 NOT_GIT_REPO', async () => {
    const notRepo = await tempDir('astera-wt-plain-')
    await expect(createWorktree({ repoPath: notRepo, registry: reg })).rejects.toThrow(/NOT_GIT_REPO/)
  })

  it('base 판정 불가면 NO_BASE', async () => {
    execFileSync('git', ['branch', '-m', 'main', 'hotfix'], { cwd: repo, windowsHide: true })
    await expect(createWorktree({ repoPath: repo, registry: reg })).rejects.toThrow(/NO_BASE/)
  })

  it('후속 단계 실패 시 롤백: worktree·브랜치가 남지 않는다', async () => {
    // registry.add를 실패시키는 스텁으로 마지막 단계 실패를 유도
    const failing = Object.create(reg) as WorktreeRegistry
    failing.add = async () => {
      throw new Error('DISK_FULL')
    }
    await expect(createWorktree({ repoPath: repo, name: 'rb', registry: failing })).rejects.toThrow(
      /DISK_FULL/
    )
    expect(existsSync(path.join(root, path.basename(repo), 'rb'))).toBe(false)
    expect(await localBranchExists(repo, 'Test-User/rb')).toBe(false)
  })

  it('baseRef를 주면 그 브랜치에서 분기한다', async () => {
    // main에 없는 커밋을 가진 브랜치를 만들고 그것을 기준으로 지정한다
    gitIn(repo, ['checkout', '-q', '-b', 'develop'])
    await fs.writeFile(path.join(repo, 'd.txt'), 'd', 'utf8')
    gitIn(repo, ['add', 'd.txt'])
    gitIn(repo, ['commit', '-m', 'dev only'])
    gitIn(repo, ['checkout', '-q', 'main'])

    const { info } = await createWorktree({ repoPath: repo, name: 'from-dev', baseRef: 'develop', registry: reg })
    expect(info.baseRef).toBe('develop')
    // develop에만 있던 파일이 worktree에 체크아웃돼 있어야 한다
    expect(existsSync(path.join(info.path, 'd.txt'))).toBe(true)
  })

  it('baseRef를 주면 branch.<b>.base에 그 값이 기록된다 — 삭제 시 머지 판정 기준이 된다', async () => {
    gitIn(repo, ['branch', 'develop'])
    const { info } = await createWorktree({ repoPath: repo, name: 'recorded', baseRef: 'develop', registry: reg })
    expect(gitIn(repo, ['config', `branch.${info.branch}.base`])).toBe('refs/heads/develop')
  })

  it('슬래시가 든 로컬 브랜치를 baseRef로 줘도 생성된다', async () => {
    // fetchBaseRef가 이름 모양만 보고 원격으로 오판하면 FETCH_FAILED로 죽던 케이스
    gitIn(repo, ['branch', 'parsingk/maple'])
    const { info } = await createWorktree({
      repoPath: repo,
      name: 'slashed',
      baseRef: 'parsingk/maple',
      registry: reg
    })
    expect(info.baseRef).toBe('parsingk/maple')
  })

  it('존재하지 않는 baseRef는 NO_BASE', async () => {
    await expect(
      createWorktree({ repoPath: repo, name: 'nope', baseRef: 'no-such-branch', registry: reg })
    ).rejects.toThrow(/NO_BASE/)
  })

  it('baseRef가 없으면 기존 자동 감지를 그대로 쓴다', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'auto', registry: reg })
    expect(info.baseRef).toBe('main') // origin이 없는 픽스처 → 로컬 main
  })
})

// 이름이 비었는지는 비동기로, 시간 제한을 두고 묻는다(presence.ts). 동기 existsSync 는 끊긴 네트워크
// 공유 위의 워크트리 루트에서 20~60초 동안 스레드를 세웠다. 닿지 않는 루트는 기다리지 않고 분명한
// 오류로 곧바로 실패한다.
describe('createWorktree, 루트에 닿지 않을 때', () => {
  it('후보 폴더 확인이 시간 초과면 만들지 않고 WORKTREE_ROOT_UNREACHABLE 로 실패한다', async () => {
    await expect(
      createWorktree({ repoPath: repo, name: 'dead', registry: reg, presence: async () => 'unreachable' })
    ).rejects.toThrow(/WORKTREE_ROOT_UNREACHABLE/)
    expect(await localBranchExists(repo, 'Test-User/dead')).toBe(false)
    expect(reg.list()).toEqual([])
  })

  it('부모 폴더를 만드는 호출이 시간 초과면 후보를 묻지도 않고 곧바로 실패한다', async () => {
    const asked: string[] = []
    await expect(
      createWorktree({
        repoPath: repo, name: 'deadroot', registry: reg,
        makeDir: async () => 'timeout',
        presence: async (p) => { asked.push(p); return 'missing' }
      })
    ).rejects.toThrow(/WORKTREE_ROOT_UNREACHABLE/)
    expect(asked).toEqual([])
    expect(reg.list()).toEqual([])
  })

  it('이름이 쓰였는지는 비동기 확인의 답으로 정한다', async () => {
    const first = path.join(root, path.basename(repo), 'taken')
    const { info } = await createWorktree({
      repoPath: repo, name: 'taken', registry: reg,
      presence: async (p) => (path.resolve(p) === path.resolve(first) ? 'present' : 'missing')
    })
    expect(info.name).toBe('taken-2')
  })
})

describe('createWorktree, names and the repo folder', () => {
  it('NAME_EXHAUSTED leaves no empty repo folder behind', async () => {
    await expect(
      createWorktree({ repoPath: repo, name: 'full', registry: reg, presence: async () => 'present' })
    ).rejects.toThrow(/NAME_EXHAUSTED/)
    expect(existsSync(path.join(root, path.basename(repo)))).toBe(false)
  })

  it('a refused candidate check is asked again, not taken as unreachable', async () => {
    const asked = new Map<string, number>()
    const { info } = await createWorktree({
      repoPath: repo, name: 'again', registry: reg,
      presence: async (p) => {
        const n = (asked.get(p) ?? 0) + 1
        asked.set(p, n)
        return n === 1 ? 'refused' : 'missing'
      }
    })
    expect(info.name).toBe('again')
  })
})
