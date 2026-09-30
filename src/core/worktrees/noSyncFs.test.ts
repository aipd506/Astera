import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'

// A sync look at the disk on a worktree path freezes the calling thread (the Electron main thread, or
// the Host's) for 20 to 60 s when the folder sits on an offline network share. Creating and removing a
// worktree must not make one. The spies wrap the real functions, so everything still works; the test
// only reads which paths they were handed. Kept in a file of its own so the mock cannot leak.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    statSync: vi.fn(actual.statSync),
    lstatSync: vi.fn(actual.lstatSync),
    accessSync: vi.fn(actual.accessSync),
    readdirSync: vi.fn(actual.readdirSync)
  }
})

import * as fsMod from 'node:fs'
import { createWorktree } from './create'
import { removeWorktree } from './remove'
import { WorktreeRegistry } from './registry'
import { makeRepo, tempDir } from './testRepo'
import { isPathWithin } from '../files/tree'

let repo: string
let root: string
let reg: WorktreeRegistry

beforeEach(async () => {
  repo = await makeRepo('astera-wt-nosync-')
  root = await tempDir('astera-wt-nosyncroot-')
  const regDir = await tempDir('astera-wt-nosyncreg-')
  reg = new WorktreeRegistry(path.join(regDir, 'worktrees.json'), root)
  await reg.load()
})

const syncCallsUnder = (dir: string): string[] =>
  (['existsSync', 'statSync', 'lstatSync', 'accessSync', 'readdirSync'] as const).flatMap((name) =>
    vi
      .mocked(fsMod[name] as (p: unknown) => unknown)
      .mock.calls.map(([p]) => String(p))
      .filter((p) => isPathWithin(dir, p))
      .map((p) => `${name}(${p})`)
  )

describe('worktree create and remove, no sync look at the disk', () => {
  it('create, then remove, never looks at a worktree path synchronously', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'nosync', registry: reg })
    await removeWorktree({ id: info.id, registry: reg, isPathInUse: () => null })
    expect(syncCallsUnder(root)).toEqual([])
  })

  it('removing a worktree whose folder is gone never looks at it synchronously', async () => {
    const { info } = await createWorktree({ repoPath: repo, name: 'nosync-gone', registry: reg })
    await fsMod.promises.rm(info.path, { recursive: true, force: true })
    vi.clearAllMocks()
    await removeWorktree({ id: info.id, registry: reg, isPathInUse: () => null })
    expect(syncCallsUnder(root)).toEqual([])
  })
})
