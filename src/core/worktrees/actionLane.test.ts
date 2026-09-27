import { describe, it, expect, vi, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'

// Review I1. The sweep's presence check has one slot for the whole process: while a worktree on an
// offline share keeps it stuck, it refuses every other check, on any drive. Here it is made to refuse
// everything, as it does in that window. The paths a person or a merge waits on (create, remove,
// run-delete, the merge's markers) must not use it: they go through the per-root action lane.
vi.mock('./presence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./presence')>()
  return { ...actual, defaultPresenceCheck: vi.fn(async () => 'refused' as const) }
})

import { createWorktree } from './create'
import { removeWorktree } from './remove'
import { WorktreeRegistry } from './registry'
import { makeRepo, tempDir } from './testRepo'
import { integrateWorktrees, worktreeDeps } from '../orchestration/exec/integrateGit'

let repo: string
let reg: WorktreeRegistry

beforeEach(async () => {
  repo = await makeRepo('astera-wt-lane-')
  const root = await tempDir('astera-wt-laneroot-')
  const regDir = await tempDir('astera-wt-lanereg-')
  reg = new WorktreeRegistry(path.join(regDir, 'worktrees.json'), root)
  await reg.load()
})

describe('while the sweep slot is stuck on another drive', () => {
  it('a worktree is still created and removed', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'lane', registry: reg })
    const r = await removeWorktree({ id: info.id, registry: reg, isPathInUse: () => null })
    expect(r.removed).toBe(true)
    await expect(fs.stat(info.path)).rejects.toThrow()
  })

  it('a merge into the repository is not stopped on a Gate, and run-delete still removes a clean worktree', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'lane-m', registry: reg })
    const r = await integrateWorktrees(repo, [info.path], { reap: false }, {
      log: () => {},
      gitOp: { begin: () => 'op', end: () => {} },
      reap: async () => true
    })
    expect(r.kind).toBe('merged')
    const reaped: string[] = []
    const d = worktreeDeps({ integrate: async () => ({ kind: 'merged', uncommitted: 0 }), reap: async (p) => { reaped.push(p); return true }, log: () => {} })
    expect(await d.removeWorktrees([info.path])).toEqual({ failed: [], uncommitted: 0 })
    expect(reaped).toEqual([info.path])
  })
})
