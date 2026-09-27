import { describe, it, expect } from 'vitest'
import {
  NOT_INTERACTIVE,
  WORKSPACE_IDLE_MS,
  idleExpired,
  leftoverPidsToKill,
  parseWorkspacesFile,
  serializeWorkspacesFile,
  workspaceRefusal,
  type WorkspaceRecord
} from './lifecycle'

describe('idleExpired', () => {
  it('is ten minutes without a script, and never while one runs', () => {
    expect(WORKSPACE_IDLE_MS).toBe(600_000)
    expect(idleExpired({ lastActivityAt: 0, now: 599_999, running: false })).toBe(false)
    expect(idleExpired({ lastActivityAt: 0, now: 600_000, running: false })).toBe(true)
    expect(idleExpired({ lastActivityAt: 0, now: 10 * 600_000, running: true })).toBe(false)
    expect(idleExpired({ lastActivityAt: 0, now: 5, running: false, idleMs: 5 })).toBe(true)
  })
})

describe('leftoverPidsToKill', () => {
  const records: WorkspaceRecord[] = [
    { sessionId: 's1', desktop: 'astera-ws-1-1', pids: [{ pid: 100, startedAt: 1_000_000 }, { pid: 101, startedAt: 1_000_500 }] },
    { sessionId: 's2', desktop: 'astera-ws-1-2', pids: [{ pid: 200, startedAt: 2_000_000 }] }
  ]

  it('kills a recorded pid only when its start time still matches', () => {
    const live = new Map([
      [100, 1_000_000],
      [101, 1_001_900],
      [200, 2_000_000]
    ])
    expect(leftoverPidsToKill(records, live)).toEqual([100, 101, 200])
  })

  it('leaves a reused pid and a gone pid alone', () => {
    const live = new Map([
      [100, 1_000_000 + 60_000],
      [200, 2_000_000]
    ])
    expect(leftoverPidsToKill(records, live)).toEqual([200])
  })

  it('names a pid once', () => {
    const dup: WorkspaceRecord[] = [records[0], { ...records[0], sessionId: 's3' }]
    expect(leftoverPidsToKill(dup, new Map([[100, 1_000_000]]))).toEqual([100])
  })
})

describe('workspaces.json', () => {
  it('round trips', () => {
    const records: WorkspaceRecord[] = [{ sessionId: 's1', desktop: 'astera-ws-1-1', pids: [{ pid: 7, startedAt: 9 }] }]
    expect(parseWorkspacesFile(serializeWorkspacesFile(records))).toEqual(records)
  })

  it('reads a malformed file as no records, and drops malformed entries', () => {
    expect(parseWorkspacesFile('not json')).toEqual([])
    expect(parseWorkspacesFile('{"workspaces":"no"}')).toEqual([])
    expect(
      parseWorkspacesFile(
        JSON.stringify({ version: 1, workspaces: [{ sessionId: 's1', desktop: 'd', pids: [{ pid: 'x', startedAt: 1 }, { pid: 5, startedAt: 2 }] }, { nope: true }] })
      )
    ).toEqual([{ sessionId: 's1', desktop: 'd', pids: [{ pid: 5, startedAt: 2 }] }])
  })
})

describe('workspaceRefusal', () => {
  it('refuses off Windows and in an SSH session, with the reason', () => {
    expect(workspaceRefusal({ platform: 'win32', env: {} })).toBeNull()
    expect(workspaceRefusal({ platform: 'darwin', env: {} })).toContain('Windows only')
    expect(workspaceRefusal({ platform: 'linux', env: {} })).toContain('linux')
    expect(workspaceRefusal({ platform: 'win32', env: { SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' } })).toContain('SSH')
    expect(workspaceRefusal({ platform: 'win32', env: { SSH_TTY: '/dev/pts/0' } })).toContain('SSH')
    expect(NOT_INTERACTIVE).toContain('no interactive desktop')
  })
})
