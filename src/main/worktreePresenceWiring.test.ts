// Text guard over src/main/ipc.ts: the orchestration push path (orchSnapshotOf, which runs after every
// setState) must not touch the file system synchronously. A worktree folder on an offline network
// share makes a sync existence check wait 20 to 60 s on the Electron main thread. It reads the
// cached, asynchronously refreshed presence instead (core/worktrees/presence.ts).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ipcSource = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'ipc.ts'), 'utf8')

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  if (start < 0) throw new Error(`marker not found in ipc.ts: ${JSON.stringify(startMarker)}`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new Error(`end marker not found after start in ipc.ts: ${JSON.stringify(endMarker)}`)
  return source.slice(start, end)
}

const stripLineComments = (text: string): string =>
  text
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')

describe('orchSnapshotOf (the push path)', () => {
  const body = stripLineComments(sliceBetween(ipcSource, 'const orchSnapshotOf =', 'const pushOrchState ='))

  it('makes no synchronous fs call', () => {
    expect(body).not.toMatch(/\b\w+Sync\s*\(/)
    expect(body).not.toMatch(/\bexistsSync\b/)
  })

  it('reads worktree presence from the cache, treating only a confirmed missing folder as gone', () => {
    expect(body).toMatch(/worktreePresence\.peek\(\s*p\s*\)\s*!==\s*'missing'/)
  })

  it('the worktree list refreshes the same cache', () => {
    expect(ipcSource).toMatch(/listWithStatus\(\s*core\.worktrees\s*,\s*\(p\)\s*=>\s*worktreePresence\.refresh\(p\)\s*\)/)
  })
})
