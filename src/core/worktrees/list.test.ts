import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { listWithStatus } from './list'
import { createWorktree } from './create'
import { WorktreeRegistry } from './registry'
import { makeRepo, tempDir } from './testRepo'

describe('listWithStatus', () => {
  it('ok / orphan-dir 판정, 그리고 폴더가 사라진 항목은 걷힌다', async () => {
    const repo = await makeRepo('astera-wt-ls-')
    const root = await tempDir('astera-wt-lsroot-')
    const regDir = await tempDir('astera-wt-lsreg-')
    const reg = new WorktreeRegistry(path.join(regDir, 'worktrees.json'), root)
    await reg.load()
    const a = (await createWorktree({ repoPath: repo, name: 'a', registry: reg })).info
    const b = (await createWorktree({ repoPath: repo, name: 'b', registry: reg })).info
    const c = (await createWorktree({ repoPath: repo, name: 'c', registry: reg })).info
    // b: 디렉토리 삭제(= missing), c: git 등록만 삭제(= orphan-dir)
    execFileSync('git', ['worktree', 'remove', '--force', b.path], { cwd: repo, windowsHide: true })
    await fs.rm(path.join(repo, '.git', 'worktrees', path.basename(c.path)), {
      recursive: true,
      force: true
    })
    const items = await listWithStatus(reg)
    const byId = new Map(items.map((w) => [w.id, w.status]))
    expect(byId.get(a.id)).toBe('ok')
    expect(byId.get(c.id)).toBe('orphan-dir')
    // b 는 폴더가 사라졌다 — 관리할 것이 남지 않았으므로 목록에도, 레지스트리에도 없어야 한다.
    // 이것이 "폴더 없음" 줄을 사람이 하나씩 x 로 지우던 것을 없애는 자리다
    expect(byId.has(b.id)).toBe(false)
    expect(reg.list().some((w) => w.id === b.id)).toBe(false)
  })

  // git 은 아직 아는데 폴더만 사라진 갈래. 이때도 줄은 남지 않아야 하고, git 쪽 메타데이터는
  // prune 으로 걷혀야 한다 — 걷지 않으면 저장소에 잔해가 남는다
  it('폴더만 사라진 항목도 목록에서 지우고 git 메타데이터까지 걷는다', async () => {
    const repo = await makeRepo('astera-wt-ls2-')
    const root = await tempDir('astera-wt-ls2root-')
    const regDir = await tempDir('astera-wt-ls2reg-')
    const reg = new WorktreeRegistry(path.join(regDir, 'worktrees.json'), root)
    await reg.load()
    const w = (await createWorktree({ repoPath: repo, name: 'gone', registry: reg })).info
    // 폴더만 지운다 — git 의 .git/worktrees/<name> 은 그대로 남는다
    await fs.rm(w.path, { recursive: true, force: true })
    const metaDir = path.join(repo, '.git', 'worktrees', path.basename(w.path))
    expect(existsSync(metaDir)).toBe(true)
    const items = await listWithStatus(reg)
    expect(items.some((x) => x.id === w.id)).toBe(false)
    expect(reg.list()).toHaveLength(0)
    expect(existsSync(metaDir)).toBe(false)
  })

  // 폴더가 멀쩡한 항목은 건드리지 않는다 — 정리가 살아 있는 것을 지우지 않는다는 증거
  it('폴더가 있는 항목은 레지스트리에 그대로 남는다', async () => {
    const repo = await makeRepo('astera-wt-ls3-')
    const root = await tempDir('astera-wt-ls3root-')
    const regDir = await tempDir('astera-wt-ls3reg-')
    const reg = new WorktreeRegistry(path.join(regDir, 'worktrees.json'), root)
    await reg.load()
    const a = (await createWorktree({ repoPath: repo, name: 'keep', registry: reg })).info
    await listWithStatus(reg)
    expect(reg.list().map((w) => w.id)).toEqual([a.id])
  })
})

// 폴더 확인이 확답을 주지 못한 항목(멈춘 네트워크 드라이브, 권한 오류)은 잊지 않는다 — 폴더가
// 사라졌다고 확인된 것(ENOENT)만 걷는다
describe('listWithStatus — 확인이 불확실할 때', () => {
  it('멈춘 폴더는 unreachable 로 남고 레지스트리에서 지워지지 않는다', async () => {
    const repo = await makeRepo('astera-wt-ls4-')
    const root = await tempDir('astera-wt-ls4root-')
    const regDir = await tempDir('astera-wt-ls4reg-')
    const reg = new WorktreeRegistry(path.join(regDir, 'worktrees.json'), root)
    await reg.load()
    const a = (await createWorktree({ repoPath: repo, name: 'hung', registry: reg })).info
    const b = (await createWorktree({ repoPath: repo, name: 'fine', registry: reg })).info
    const items = await listWithStatus(reg, async (p) => (p === a.path ? 'unreachable' : 'present'))
    const byId = new Map(items.map((w) => [w.id, w.status]))
    expect(byId.get(a.id)).toBe('unreachable')
    expect(byId.get(b.id)).toBe('ok')
    expect(reg.list().map((w) => w.id).sort()).toEqual([a.id, b.id].sort())
  })

  // git 이 worktree 목록을 주지 못한 것은 "git 이 이 폴더를 모른다"가 아니다. orphan-dir("git 등록
  // 소실")는 사람이 지워도 되는 잔해로 읽히므로, 모를 때는 그 이름을 붙이지 않고 따로 말한다.
  it('저장소의 git 이 목록을 주지 못하면 git-unchecked 이고, orphan-dir 이 아니며, 레지스트리에 남는다', async () => {
    const repo = await makeRepo('astera-wt-ls6-')
    const root = await tempDir('astera-wt-ls6root-')
    const regDir = await tempDir('astera-wt-ls6reg-')
    const reg = new WorktreeRegistry(path.join(regDir, 'worktrees.json'), root)
    await reg.load()
    const a = (await createWorktree({ repoPath: repo, name: 'kept', registry: reg })).info
    // 원본 저장소의 .git 을 치운다 — `git worktree list` 가 실패한다
    await fs.rename(path.join(repo, '.git'), path.join(repo, '.git-away'))
    const items = await listWithStatus(reg, async () => 'present')
    expect(items.map((w) => [w.id, w.status])).toEqual([[a.id, 'git-unchecked']])
    expect(reg.list().map((w) => w.id)).toEqual([a.id])
  })

  it('ENOENT 로 확인된(missing) 항목은 여전히 걷힌다', async () => {
    const repo = await makeRepo('astera-wt-ls5-')
    const root = await tempDir('astera-wt-ls5root-')
    const regDir = await tempDir('astera-wt-ls5reg-')
    const reg = new WorktreeRegistry(path.join(regDir, 'worktrees.json'), root)
    await reg.load()
    const a = (await createWorktree({ repoPath: repo, name: 'gone', registry: reg })).info
    const items = await listWithStatus(reg, async () => 'missing')
    expect(items.some((w) => w.id === a.id)).toBe(false)
    expect(reg.list()).toHaveLength(0)
  })
})
