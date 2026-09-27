import { describe, it, expect, vi, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'

// remove.ts imports git() from ./git. The real adapter still runs (real repositories below); the
// wrapper only records the options each call was given, so the test can see which deadline a write
// was handed. Kept in a file of its own so the spy cannot leak into remove.test.ts.
vi.mock('./git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git')>()
  return { ...actual, git: vi.fn(actual.git) }
})

import { git, GIT_WRITE_TIMEOUT_MS } from './git'
import { removeWorktree } from './remove'
import { createWorktree } from './create'
import { WorktreeRegistry } from './registry'
import { makeRepo, tempDir } from './testRepo'

let repo: string
let reg: WorktreeRegistry

beforeEach(async () => {
  vi.mocked(git).mockClear()
  repo = await makeRepo('astera-wt-rmto-')
  const root = await tempDir('astera-wt-rmtoroot-')
  const regDir = await tempDir('astera-wt-rmtoreg-')
  reg = new WorktreeRegistry(path.join(regDir, 'worktrees.json'), root)
  await reg.load()
})

const callsOf = (pred: (args: string[]) => boolean): (number | undefined)[] =>
  vi.mocked(git).mock.calls.filter(([args]) => pred(args)).map(([, opts]) => opts?.timeoutMs)

describe('removeWorktree, write deadlines', () => {
  // A `worktree remove --force` killed at the adapter's 30 s default leaves the folder half deleted
  // and git's record of it in place. Every mutating call here gets the long write ceiling.
  it('worktree remove, worktree prune and branch delete run with the long write timeout', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'rmto', registry: reg })
    await fs.writeFile(path.join(info.path, 'dirty.txt'), 'x')
    vi.mocked(git).mockClear()
    const r = await removeWorktree({ id: info.id, force: true, registry: reg, isPathInUse: () => null })
    expect(r.removed).toBe(true)
    expect(callsOf((a) => a[0] === 'worktree' && a[1] === 'remove')).toEqual([GIT_WRITE_TIMEOUT_MS])
    expect(callsOf((a) => a[0] === 'worktree' && a[1] === 'prune')).toEqual([GIT_WRITE_TIMEOUT_MS])
    const deletes = callsOf((a) => a[0] === 'branch' && (a[1] === '-d' || a[1] === '-D'))
    expect(deletes.length).toBeGreaterThan(0)
    expect(deletes.every((t) => t === GIT_WRITE_TIMEOUT_MS)).toBe(true)
  })
})
