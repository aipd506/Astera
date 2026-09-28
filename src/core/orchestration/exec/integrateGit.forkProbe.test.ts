// Stage 4 final review: forkWorktree asked the project folder through the session folder's probe, which
// is held to the stuck-call cap, while createWorktree asks the same folder past it (defaultGateProbe).
// A person waits on a worker's worktree the same way, so dead drives elsewhere must not refuse a live
// local repository here either. Its own file, since it replaces the probes for everything it imports.
import { describe, it, expect, vi } from 'vitest'

const asked: Array<{ probe: string; p: string }> = []
vi.mock('../../sessions/pathProbe', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../sessions/pathProbe')>()
  return {
    ...real,
    defaultGateProbe: async (p: string) => {
      asked.push({ probe: 'gate', p })
      return 'timeout' as const
    },
    defaultCwdProbe: async (p: string) => {
      asked.push({ probe: 'cwd', p })
      return 'timeout' as const
    }
  }
})

describe('forkWorktree asks the project folder past the stuck-call cap', () => {
  it('uses the gate probe by default, like createWorktree', async () => {
    const { forkWorktree } = await import('./integrateGit')
    await expect(forkWorktree({ repoPath: '/nowhere/repo' }, { registry: {} as never, log: () => {} })).rejects.toThrow(
      'REPO_UNREACHABLE: folder not reachable: /nowhere/repo'
    )
    expect(asked).toEqual([{ probe: 'gate', p: '/nowhere/repo' }])
  })
})
