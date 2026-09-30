import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { rollbackAdd } from './create'
import { removeWorktree } from './remove'
import { createWorktree } from './create'
import { WorktreeRegistry } from './registry'
import { makeRepo, tempDir, gitSync } from './testRepo'

// Stage 2 final review, C1. Git for Windows' `worktree remove` (with or without --force) walks INTO a
// junction and deletes what it points at; a directory symlink is left alone. A worktree holding a
// junction to a folder outside it (pnpm's node_modules, `npm link`, a hand-made link, or once an
// include copy) lost that outside folder's contents on every removal path. Each path now takes the
// links out first. These run real git against real junctions, so Windows only.
describe.runIf(process.platform === 'win32')('removing a worktree that holds a junction to an outside folder', () => {
  let repo: string
  let reg: WorktreeRegistry
  let outside: string

  beforeEach(async () => {
    repo = await makeRepo('astera-wt-junc-')
    await fs.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n', 'utf8')
    gitSync(repo, ['add', '.gitignore'])
    gitSync(repo, ['commit', '-m', 'ignore'])
    const root = await tempDir('astera-wt-junc-root-')
    const regDir = await tempDir('astera-wt-junc-reg-')
    reg = new WorktreeRegistry(path.join(regDir, 'worktrees.json'), root)
    await reg.load()
    outside = await tempDir('astera-wt-junc-outside-')
    await fs.mkdir(path.join(outside, 'src'))
    await fs.writeFile(path.join(outside, 'keep.txt'), 'precious', 'utf8')
    await fs.writeFile(path.join(outside, 'src', 'index.js'), 'module.exports = 1', 'utf8')
  })

  /** A junction under the worktree's ignored node_modules, the way pnpm lays out a workspace package. */
  const plantJunction = async (wt: string): Promise<string> => {
    await fs.mkdir(path.join(wt, 'node_modules', '@x'), { recursive: true })
    const link = path.join(wt, 'node_modules', '@x', 'pkg')
    await fs.symlink(outside, link, 'junction')
    return link
  }

  const outsideIntact = async (): Promise<void> => {
    expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('precious')
    expect(await fs.readFile(path.join(outside, 'src', 'index.js'), 'utf8')).toBe('module.exports = 1')
  }

  it('the create rollback (rollbackAdd) leaves the outside folder whole', async () => {
    const wt = path.join(reg.getRoot(), 'mine')
    gitSync(repo, ['worktree', 'add', '-b', 'Test-User/mine', wt, 'main'])
    await plantJunction(wt)
    expect(await rollbackAdd(repo, wt, 'Test-User/mine')).toEqual([])
    expect(existsSync(wt)).toBe(false)
    await outsideIntact()
  })

  it('the panel remove, without force, leaves the outside folder whole', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'panel', registry: reg })
    await plantJunction(info.path)
    const r = await removeWorktree({ id: info.id, registry: reg, isPathInUse: () => null })
    expect(r.removed).toBe(true)
    expect(existsSync(info.path)).toBe(false)
    await outsideIntact()
  })

  it('the panel remove, with force, leaves the outside folder whole', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'forced', registry: reg })
    await plantJunction(info.path)
    await fs.writeFile(path.join(info.path, 'dirty.txt'), 'd', 'utf8')
    const r = await removeWorktree({ id: info.id, force: true, registry: reg, isPathInUse: () => null })
    expect(r.removed).toBe(true)
    expect(existsSync(info.path)).toBe(false)
    await outsideIntact()
  })

  it('a create whose include copy meets a junction and is cancelled leaves the outside folder whole', async () => {
    // node_modules/@x/pkg in the main repo is a junction to the outside folder, and node_modules is an
    // include entry: the copy recreates the link, then the cancel rolls the worktree back.
    await fs.writeFile(path.join(repo, '.worktreeinclude'), 'node_modules\n', 'utf8')
    await plantJunction(repo)
    await fs.writeFile(path.join(repo, 'node_modules', 'big.bin'), 'B'.repeat(5 * 1024 * 1024), 'utf8')
    const ac = new AbortController()
    const err = await createWorktree({
      repoPath: repo, name: 'cancelled', registry: reg, signal: ac.signal,
      onProgress: (p) => { if (p.stage === 'copy-includes' && (p.bytesCopied ?? 0) > 0) ac.abort() }
    }).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/WORKTREE_CANCELLED/)
    expect(existsSync(path.join(reg.getRoot(), path.basename(repo), 'cancelled'))).toBe(false)
    await outsideIntact()
  }, 30_000)
})
