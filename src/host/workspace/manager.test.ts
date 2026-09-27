import { describe, it, expect, vi, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Cdp } from '../../core/workspace/helpers'
import type { DeskShot, DeskWindow } from '../../core/workspace/protocol'
import type { DesktopHelper } from './desktopHelper'
import { createWorkspaceManager, type WorkspaceEvent, type WorkspaceManager, type WorkspaceManagerDeps } from './manager'

class FakeDesk implements DesktopHelper {
  static made: FakeDesk[] = []
  pid: number
  startedAt = 2_000
  launches: Array<{ command: string; cwd: string; env: Record<string, string> }> = []
  kills: number[] = []
  killStarts: number[] = []
  killFails = false
  closed = false
  private exits: Array<(why: string) => void> = []
  constructor(readonly name: string) {
    this.pid = 9000 + FakeDesk.made.length
    FakeDesk.made.push(this)
  }
  alive(): boolean {
    return !this.closed
  }
  onExit(cb: (why: string) => void): void {
    this.exits.push(cb)
  }
  /** While set, every launch waits for it after being recorded: an app that is still starting. */
  static hold: Promise<void> | null = null
  async launch(a: { command: string; cwd: string; env: Record<string, string> }) {
    this.launches.push(a)
    if (FakeDesk.hold) await FakeDesk.hold
    return { pid: 500 + FakeDesk.made.indexOf(this) * 10 + this.launches.length, startedAt: 3_000 }
  }
  async kill(pid: number, startedAt: number) {
    this.kills.push(pid)
    this.killStarts.push(startedAt)
    if (this.killFails) throw new Error('the helper is gone')
  }
  async windows(): Promise<DeskWindow[]> {
    return []
  }
  async shot(): Promise<DeskShot> {
    return { data: '/9j/', width: 10, height: 10, title: 'T' }
  }
  async keys() {}
  closes = 0
  async close() {
    this.closes += 1
    this.closed = true
  }
  die(why: string): void {
    this.closed = true
    for (const cb of this.exits) cb(why)
  }
}

const fakeCdp = (): Cdp & { closed: boolean; calls: string[] } => {
  const c = {
    closed: false,
    calls: [] as string[],
    send: async (method: string) => {
      c.calls.push(method)
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1920, clientHeight: 1080 } }
      if (method === 'Page.captureScreenshot') return { data: '/9j/frame' }
      return {}
    },
    waitEvent: async () => ({}),
    consoleErrors: () => [],
    close: () => {
      c.closed = true
    }
  }
  return c
}

// Ruling F7: every manager a test makes is disposed (so no record write lands after its folder is
// gone) and every temp folder it made is removed, however many rigs one test builds.
const dirs: string[] = []
const managers: WorkspaceManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.dispose()
  FakeDesk.made = []
  FakeDesk.hold = null
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

const rig = async (over: Partial<WorkspaceManagerDeps> = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-ws-'))
  dirs.push(dir)
  const events: WorkspaceEvent[] = []
  const ticks: Array<{ ms: number; fn: () => void; live: boolean }> = []
  let clock = 1_000_000
  const deps: WorkspaceManagerDeps = {
    platform: 'win32',
    env: {},
    recordFile: path.join(dir, 'orch', 'workspaces.json'),
    shotsDir: path.join(dir, 'shots'),
    enabled: async () => true,
    guide: () => '# guide',
    sessionCwd: async (id) => (id.startsWith('s') ? path.join(dir, 'proj') : null),
    resolveLaunch: async ({ cwd, spec }) => ({ command: 'command' in spec ? spec.command : 'npm run dev', cwd, env: {} }),
    startDesk: vi.fn(async (name: string) => new FakeDesk(name)),
    connectCdp: vi.fn(async () => fakeCdp()),
    freePort: (() => {
      let p = 9300
      return async () => ++p
    })(),
    killTree: vi.fn(async () => {}),
    startTimes: vi.fn(async () => new Map<number, number>()),
    emit: (e) => events.push(e),
    hasWatchers: () => true,
    log: () => {},
    now: () => clock,
    every: (ms, fn) => {
      const t = { ms, fn, live: true }
      ticks.push(t)
      return () => {
        t.live = false
      }
    },
    ...over
  }
  const m = createWorkspaceManager(deps)
  managers.push(m)
  const tick = (ms: number): void => {
    clock += ms
    for (const t of [...ticks]) if (t.live && t.ms === ms) t.fn()
  }
  const file = async (): Promise<unknown> => JSON.parse(await fs.readFile(deps.recordFile, 'utf8'))
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20))
  return { m, deps, events, tick, file, settle }
}

const body = (r: { status: number; body: unknown }) => r.body as { log: string[]; error?: { message: string; at: string } }

describe('refusals', () => {
  it('off Windows, switched off, unreadable settings, and an unknown session', async () => {
    const { m: linux } = await rig({ platform: 'linux' })
    expect(await linux.run('s1', 'log(1)')).toMatchObject({ status: 409, body: { error: expect.stringContaining('Windows only') } })
    const { m: off } = await rig({ enabled: async () => false })
    expect(await off.run('s1', 'log(1)')).toEqual({ status: 409, body: { error: 'agent app workspace is off' } })
    const { m: broken } = await rig({
      enabled: async () => {
        throw new Error('app-settings.json is not a valid settings file; open Astera to repair it')
      }
    })
    expect(await broken.run('s1', 'log(1)')).toMatchObject({ status: 409, body: { repair: 'app-settings.json' } })
    const { m } = await rig()
    expect(await m.run('x-unknown', 'log(1)')).toEqual({ status: 404, body: { error: 'no such session' } })
  })

  it('a script that launches nothing opens no desktop and sends no event', async () => {
    const { m, events, deps } = await rig()
    expect(await m.run('s1', "log('hi')")).toEqual({ status: 200, body: { log: ['hi'] } })
    expect(deps.startDesk).not.toHaveBeenCalled()
    expect(events).toEqual([])
    expect(m.list()).toEqual([])
  })
})

describe('launch and the record file', () => {
  it('creates one desktop, records the launched pid then the helper pid, and tells the app', async () => {
    const { m, file, events } = await rig()
    const r = await m.run('s1', "log(await launch({ config: 'dev' }))")
    expect(r.status).toBe(200)
    expect(body(r).log).toEqual(['{"pid":501,"port":9301}'])
    await vi.waitFor(async () =>
      expect(await file()).toEqual({
        version: 1,
        workspaces: [{ sessionId: 's1', desktop: expect.stringMatching(/^astera-ws-/), pids: [{ pid: 501, startedAt: 3_000 }, { pid: 9000, startedAt: 2_000 }] }]
      })
    )
    expect(events.some((e) => e.kind === 'state' && e.open && e.sessionId === 's1')).toBe(true)
    expect(m.list()).toMatchObject([{ sessionId: 's1', running: false }])
  })

  it('a second script while one runs is refused', async () => {
    let release!: () => void
    const { m } = await rig({ connectCdp: vi.fn(() => new Promise<Cdp | null>((r) => { release = () => r(fakeCdp()) })) })
    const first = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(await m.run('s1', 'log(1)')).toEqual({ status: 409, body: { error: 'a script is already running' } })
    release()
    expect((await first).status).toBe(200)
  })

  it('two sessions are two desktops, and closing one leaves the other (Review Focus 5)', async () => {
    const { m, file } = await rig()
    await m.run('s1', "await launch({ command: 'a.exe' })")
    await m.run('s2', "await launch({ command: 'b.exe' })")
    expect(FakeDesk.made.map((d) => d.name)).toHaveLength(2)
    expect(new Set(FakeDesk.made.map((d) => d.name)).size).toBe(2)
    expect(await m.close('s1')).toBe(true)
    expect(FakeDesk.made[0].closed).toBe(true)
    expect(FakeDesk.made[0].kills).toEqual([501])
    expect(FakeDesk.made[0].killStarts).toEqual([3_000])
    expect(FakeDesk.made[1].closed).toBe(false)
    expect(m.list().map((w) => w.sessionId)).toEqual(['s2'])
    await vi.waitFor(async () => expect(((await file()) as { workspaces: Array<{ sessionId: string }> }).workspaces.map((w) => w.sessionId)).toEqual(['s2']))
  })

  it('close then launch in one script starts a fresh desktop (Review Focus 5)', async () => {
    const { m } = await rig()
    const r = await m.run('s1', "await launch({ command: 'a.exe' }); await close(); log(await launch({ command: 'a.exe' }))")
    expect(body(r).error).toBeUndefined()
    expect(FakeDesk.made).toHaveLength(2)
    expect(FakeDesk.made[0].closed).toBe(true)
    expect(FakeDesk.made[1].closed).toBe(false)
    expect(m.list()).toHaveLength(1)
  })
})

describe('Stop, Close, the session, the helper, idleness', () => {
  it('Stop ends the running script at "stopped" and leaves the app running', async () => {
    const { m } = await rig({ connectCdp: vi.fn(() => new Promise<Cdp | null>(() => {})) })
    const run = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(FakeDesk.made[0]?.launches).toHaveLength(1))
    expect(m.stop('s1')).toBe(true)
    expect(body(await run).error).toEqual({ message: 'stopped', at: 'stopped' })
    expect(FakeDesk.made[0].kills).toEqual([])
    expect(FakeDesk.made[0].closed).toBe(false)
    expect(m.stop('s1')).toBe(false)
  })

  it('the session ending mid launch stops the script and leaves nothing (Review Focus 4)', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const { m, deps, events, settle } = await rig({ connectCdp: vi.fn(() => new Promise<Cdp | null>(() => {})) })
      const run = m.run('s1', "await launch({ command: 'app.exe' })")
      await vi.waitFor(() => expect(FakeDesk.made[0]?.launches).toHaveLength(1))
      m.sessionEnded('s1')
      expect(body(await run).error?.at).toBe('stopped')
      await vi.waitFor(() => expect(FakeDesk.made[0].closed).toBe(true))
      expect(FakeDesk.made[0].kills).toEqual([501])
      expect(m.list()).toEqual([])
      await vi.waitFor(async () => expect(await fs.stat(deps.recordFile).then(() => true, () => false)).toBe(false))
      expect(events.at(-1)).toMatchObject({ kind: 'state', sessionId: 's1', open: false })
      await settle()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('a helper that dies takes its entry with it, the app tree is ended, and the next launch starts afresh', async () => {
    const { m, deps } = await rig({ startTimes: vi.fn(async () => new Map([[501, 3_000]])) })
    await m.run('s1', "await launch({ command: 'app.exe' })")
    FakeDesk.made[0].die('exited 1')
    await vi.waitFor(() => expect(deps.killTree).toHaveBeenCalledWith(501))
    expect(deps.startTimes).toHaveBeenCalledWith([501])
    expect(m.list()).toEqual([])
    await m.run('s1', "await launch({ command: 'app.exe' })")
    expect(FakeDesk.made).toHaveLength(2)
  })

  it('a helper that dies leaves a pid whose start time no longer matches alone (never a pid by number alone)', async () => {
    const { m, deps, settle } = await rig({ startTimes: vi.fn(async () => new Map([[501, 99_999]])) })
    await m.run('s1', "await launch({ command: 'app.exe' })")
    FakeDesk.made[0].die('exited 1')
    await vi.waitFor(() => expect(deps.startTimes).toHaveBeenCalledWith([501]))
    await settle()
    expect(deps.killTree).not.toHaveBeenCalled()
  })

  it('when the helper cannot end the app, the direct kill still checks the start time', async () => {
    const live = new Map<number, number>()
    const { m, deps } = await rig({ startTimes: vi.fn(async () => live) })
    await m.run('s1', "await launch({ command: 'a.exe' })")
    await m.run('s2', "await launch({ command: 'b.exe' })")
    FakeDesk.made[0].killFails = true
    FakeDesk.made[1].killFails = true
    live.set(501, 99_999)
    expect(await m.close('s1')).toBe(true)
    expect(deps.killTree).not.toHaveBeenCalled()
    live.set(511, 3_000)
    expect(await m.close('s2')).toBe(true)
    expect(deps.killTree).toHaveBeenCalledTimes(1)
    expect(deps.killTree).toHaveBeenCalledWith(511)
  })

  it('a Stop that lands before the desktop exists opens none (ruling F1)', async () => {
    let resolved!: () => void
    const { m, deps, settle } = await rig({
      resolveLaunch: ({ cwd }) =>
        new Promise((r) => {
          resolved = () => r({ command: 'app.exe', cwd, env: {} })
        })
    })
    const run = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(resolved).toBeTypeOf('function'))
    expect(m.stop('s1')).toBe(true)
    expect(body(await run).error?.at).toBe('stopped')
    resolved()
    await settle()
    expect(deps.startDesk).not.toHaveBeenCalled()
    expect(m.list()).toEqual([])
  })

  it('a Stop that lands while the desktop is being created closes it and launches nothing (ruling F1)', async () => {
    let started!: () => void
    const { m, deps, events, settle } = await rig({
      startDesk: vi.fn(
        (name: string) =>
          new Promise<DesktopHelper>((r) => {
            started = () => r(new FakeDesk(name))
          })
      )
    })
    const run = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(started).toBeTypeOf('function'))
    expect(m.stop('s1')).toBe(true)
    expect(body(await run).error?.at).toBe('stopped')
    started()
    await vi.waitFor(() => expect(FakeDesk.made[0]?.closed).toBe(true))
    await settle()
    expect(FakeDesk.made[0].launches).toEqual([])
    expect(m.list()).toEqual([])
    expect(events.at(-1)).toMatchObject({ kind: 'state', sessionId: 's1', open: false })
    await vi.waitFor(async () => expect(await fs.stat(deps.recordFile).then(() => true, () => false)).toBe(false))
  })

  it('the session ending while the desktop is being created closes it once and launches nothing (ruling F1)', async () => {
    let started!: () => void
    const { m, events, settle } = await rig({
      startDesk: vi.fn(
        (name: string) =>
          new Promise<DesktopHelper>((r) => {
            started = () => r(new FakeDesk(name))
          })
      )
    })
    const run = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(started).toBeTypeOf('function'))
    m.sessionEnded('s1')
    expect(body(await run).error?.at).toBe('stopped')
    started()
    await vi.waitFor(() => expect(FakeDesk.made[0]?.closed).toBe(true))
    await settle()
    expect(FakeDesk.made[0].closes).toBe(1)
    expect(FakeDesk.made[0].launches).toEqual([])
    expect(m.list()).toEqual([])
    // Review minor 4: two cleanups racing over one desktop tell the app it closed once.
    expect(events.filter((e) => e.kind === 'state' && !e.open)).toHaveLength(1)
  })

  // Task 5 deferred minor: a Stop while the desktop starts leaves the app told `open: true` (run's
  // finally); a desktop that then fails to start must still be told closed, once, or the mirror shows a
  // workspace that no longer exists.
  const failingDesk = () => {
    let fail!: () => void
    const startDesk = vi.fn(
      () =>
        new Promise<DesktopHelper>((_r, reject) => {
          fail = () => reject(new Error('the helper would not start'))
        })
    )
    return { startDesk, fail: () => fail() }
  }
  const closedAfterLastOpen = (events: WorkspaceEvent[]) => {
    const states = events.filter((e) => e.kind === 'state')
    const lastOpen = states.map((e) => e.kind === 'state' && e.open).lastIndexOf(true)
    return states.slice(lastOpen + 1).filter((e) => e.kind === 'state' && !e.open)
  }

  it('Close after a Stop while the desktop starts, then the start fails, tells the app it closed once', async () => {
    const { startDesk, fail } = failingDesk()
    const { m, events, settle } = await rig({ startDesk })
    const run = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(startDesk).toHaveBeenCalled())
    expect(m.stop('s1')).toBe(true)
    expect(body(await run).error?.at).toBe('stopped')
    expect(events.at(-1)).toMatchObject({ kind: 'state', sessionId: 's1', open: true })
    const closing = m.close('s1')
    fail()
    expect(await closing).toBe(true)
    await settle()
    expect(closedAfterLastOpen(events)).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ kind: 'state', sessionId: 's1', open: false })
    expect(m.list()).toEqual([])
  })

  it('Close and the session ending at once, over a desktop that fails to start, tell the app it closed once', async () => {
    const { startDesk, fail } = failingDesk()
    const { m, events, settle } = await rig({ startDesk })
    const run = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(startDesk).toHaveBeenCalled())
    expect(m.stop('s1')).toBe(true)
    await run
    const closing = m.close('s1')
    m.sessionEnded('s1')
    fail()
    expect(await closing).toBe(true)
    await settle()
    expect(closedAfterLastOpen(events)).toHaveLength(1)
    expect(m.list()).toEqual([])
  })

  it('a desktop that fails to start after its script was stopped tells the app it closed, with no Close', async () => {
    const { startDesk, fail } = failingDesk()
    const { m, events, settle } = await rig({ startDesk })
    const run = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(startDesk).toHaveBeenCalled())
    expect(m.stop('s1')).toBe(true)
    await run
    fail()
    await settle()
    expect(closedAfterLastOpen(events)).toHaveLength(1)
    expect(m.list()).toEqual([])
    expect(await m.close('s1')).toBe(false)
  })

  it('Close and the session ending at once tell the app it closed once (review minor 4)', async () => {
    const { m, events, settle } = await rig()
    await m.run('s1', "await launch({ command: 'app.exe' })")
    const closing = m.close('s1')
    m.sessionEnded('s1')
    expect(await closing).toBe(true)
    await settle()
    expect(FakeDesk.made[0].closes).toBe(1)
    expect(events.filter((e) => e.kind === 'state' && !e.open)).toHaveLength(1)
  })

  it('a stale Stop does not close the desktop a newer script is starting on (review minor 3)', async () => {
    let started!: () => void
    const { m } = await rig({
      startDesk: vi.fn(
        (name: string) =>
          new Promise<DesktopHelper>((r) => {
            started = () => r(new FakeDesk(name))
          })
      )
    })
    const first = m.run('s1', "await launch({ command: 'a.exe' })")
    await vi.waitFor(() => expect(started).toBeTypeOf('function'))
    expect(m.stop('s1')).toBe(true)
    expect(body(await first).error?.at).toBe('stopped')
    const second = m.run('s1', "log(await launch({ command: 'b.exe' }))")
    await new Promise((r) => setTimeout(r, 20))
    started()
    const r = await second
    expect(body(r).error).toBeUndefined()
    expect(FakeDesk.made).toHaveLength(1)
    expect(FakeDesk.made[0].closed).toBe(false)
    expect(FakeDesk.made[0].launches.map((l) => l.command)).toEqual(['b.exe'])
    expect(m.list()).toHaveLength(1)
  })

  it('a launch the script did not await opens nothing once the script has ended (review critical 1)', async () => {
    let resolved!: () => void
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const { m, deps, settle } = await rig({
        resolveLaunch: ({ cwd }) =>
          new Promise((r) => {
            resolved = () => r({ command: 'app.exe', cwd, env: {} })
          })
      })
      const r = await m.run('s1', "launch({ command: 'a.exe' }).catch(() => {}); log('done')")
      expect(body(r)).toEqual({ log: ['done'] })
      resolved()
      await settle()
      expect(deps.startDesk).not.toHaveBeenCalled()
      expect(m.list()).toEqual([])
      expect(await fs.stat(deps.recordFile).then(() => true, () => false)).toBe(false)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('an un-awaited launch that is quicker than the script end leaves nothing either (review critical 1)', async () => {
    const { m, deps, settle } = await rig()
    await m.run('s1', "launch({ command: 'a.exe' }).catch(() => {}); log('done')")
    await settle()
    await m.dispose()
    expect(FakeDesk.made.every((k) => k.closed)).toBe(true)
    const launched = FakeDesk.made.flatMap((k) => k.launches)
    if (launched.length > 0) expect(FakeDesk.made.flatMap((k) => k.kills)).toContain(501)
    await vi.waitFor(async () => expect(await fs.stat(deps.recordFile).then(() => true, () => false)).toBe(false))
  })

  it('a launch still on its way when the script times out opens nothing (review critical 1)', async () => {
    let resolved!: () => void
    const { m, deps, settle } = await rig({
      scriptTimeoutMs: 50,
      resolveLaunch: ({ cwd }) =>
        new Promise((r) => {
          resolved = () => r({ command: 'app.exe', cwd, env: {} })
        })
    })
    const r = await m.run('s1', "await launch({ command: 'a.exe' })")
    expect(body(r).error).toBeDefined()
    resolved()
    await settle()
    expect(deps.startDesk).not.toHaveBeenCalled()
    expect(m.list()).toEqual([])
  })

  for (const way of ['close', 'sessionEnded', 'dispose'] as const)
    it(`${way} while the app is starting ends the app once it has started (review important 2)`, async () => {
      let release!: () => void
      FakeDesk.hold = new Promise((r) => {
        release = r
      })
      const { m, deps, settle } = await rig({ startTimes: vi.fn(async () => new Map([[501, 3_000]])) })
      const run = m.run('s1', "await launch({ command: 'app.exe' })")
      await vi.waitFor(() => expect(FakeDesk.made[0]?.launches).toHaveLength(1))
      if (way === 'close') expect(await m.close('s1')).toBe(true)
      else if (way === 'sessionEnded') m.sessionEnded('s1')
      else await m.dispose()
      await vi.waitFor(() => expect(FakeDesk.made[0].closed).toBe(true))
      release()
      expect(body(await run).error?.at).toBe('stopped')
      await vi.waitFor(() => expect(deps.killTree).toHaveBeenCalledWith(501))
      expect(deps.startTimes).toHaveBeenCalledWith([501])
      await settle()
      expect(m.list()).toEqual([])
      expect(await fs.stat(deps.recordFile).then(() => true, () => false)).toBe(false)
    })

  it('the session ending before the desktop exists opens none (ruling F1)', async () => {
    let resolved!: () => void
    const { m, deps, settle } = await rig({
      resolveLaunch: ({ cwd }) =>
        new Promise((r) => {
          resolved = () => r({ command: 'app.exe', cwd, env: {} })
        })
    })
    const run = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(resolved).toBeTypeOf('function'))
    m.sessionEnded('s1')
    expect(body(await run).error?.at).toBe('stopped')
    resolved()
    await settle()
    expect(deps.startDesk).not.toHaveBeenCalled()
    expect(m.list()).toEqual([])
  })

  it('ten minutes without a script cleans the desktop up', async () => {
    const { m, tick } = await rig()
    await m.run('s1', "await launch({ command: 'app.exe' })")
    tick(30_000)
    expect(FakeDesk.made[0].closed).toBe(false)
    for (let i = 0; i < 20; i++) tick(30_000)
    await vi.waitFor(() => expect(FakeDesk.made[0].closed).toBe(true))
    expect(m.list()).toEqual([])
  })

  it('dispose cleans every desktop up and refuses what comes after', async () => {
    const { m } = await rig()
    await m.run('s1', "await launch({ command: 'a.exe' })")
    await m.run('s2', "await launch({ command: 'b.exe' })")
    await m.dispose()
    expect(FakeDesk.made.every((d) => d.closed)).toBe(true)
    expect((await m.run('s1', 'log(1)')).status).toBe(409)
  })
})

describe('frames', () => {
  it('a helper that changes the screen sends a scaled JPEG frame while an app watches', async () => {
    const { m, events } = await rig()
    await m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'frame')).toBe(true))
    const f = events.find((e) => e.kind === 'frame') as Extract<WorkspaceEvent, { kind: 'frame' }>
    expect(f.frame).toMatchObject({ jpeg: '/9j/frame', width: 960, height: 540 })
    expect(m.list()[0].frame?.jpeg).toBe('/9j/frame')
  })

  it('the frame timer keeps running after close() inside the script, for the next launch (ruling F6)', async () => {
    let second!: () => void
    let calls = 0
    const { m, events, tick } = await rig({
      connectCdp: vi.fn(() => {
        calls += 1
        if (calls === 1) return Promise.resolve<Cdp | null>(fakeCdp())
        return new Promise<Cdp | null>((r) => {
          second = () => r(null)
        })
      })
    })
    const run = m.run('s1', "await launch({ command: 'a.exe' }); await close(); await launch({ command: 'a.exe' })")
    await vi.waitFor(() => expect(second).toBeTypeOf('function'))
    await new Promise((r) => setTimeout(r, 20))
    events.length = 0
    tick(1_000)
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'frame' && e.frame.jpeg === '/9j/')).toBe(true))
    second()
    await run
  })

  it('captures nothing while no app watches', async () => {
    const cdp = fakeCdp()
    const { m } = await rig({ hasWatchers: () => false, connectCdp: vi.fn(async () => cdp) })
    await m.run('s1', "await launch({ command: 'app.exe' })")
    await new Promise((r) => setTimeout(r, 20))
    expect(cdp.calls).not.toContain('Page.captureScreenshot')
  })
})

describe('sweepLeftovers', () => {
  it('kills only the recorded pids whose start time still matches, then removes the file', async () => {
    const { m, deps } = await rig({ startTimes: vi.fn(async () => new Map([[501, 3_000], [9000, 99_999]])) })
    await fs.mkdir(path.dirname(deps.recordFile), { recursive: true })
    await fs.writeFile(
      deps.recordFile,
      JSON.stringify({ version: 1, workspaces: [{ sessionId: 's1', desktop: 'd', pids: [{ pid: 501, startedAt: 3_000 }, { pid: 9000, startedAt: 2_000 }] }] }),
      'utf8'
    )
    await m.sweepLeftovers()
    expect(deps.killTree).toHaveBeenCalledTimes(1)
    expect(deps.killTree).toHaveBeenCalledWith(501)
    expect(await fs.stat(deps.recordFile).then(() => true, () => false)).toBe(false)
  })

  it('a malformed file kills nothing and is removed; no file is nothing to do', async () => {
    const { m, deps } = await rig()
    await m.sweepLeftovers()
    await fs.mkdir(path.dirname(deps.recordFile), { recursive: true })
    await fs.writeFile(deps.recordFile, '{ nope', 'utf8')
    await m.sweepLeftovers()
    expect(deps.killTree).not.toHaveBeenCalled()
    expect(await fs.stat(deps.recordFile).then(() => true, () => false)).toBe(false)
  })

  it('a launch waits for the sweep, so the sweep never removes a new record', async () => {
    let release!: () => void
    const { m, deps, file } = await rig({ startTimes: vi.fn(() => new Promise<Map<number, number>>((r) => { release = () => r(new Map()) })) })
    await fs.mkdir(path.dirname(deps.recordFile), { recursive: true })
    await fs.writeFile(deps.recordFile, JSON.stringify({ version: 1, workspaces: [{ sessionId: 'old', desktop: 'd', pids: [{ pid: 1, startedAt: 1 }] }] }), 'utf8')
    const sweep = m.sweepLeftovers()
    const run = m.run('s1', "await launch({ command: 'app.exe' })")
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await sweep
    await run
    await vi.waitFor(async () => expect(((await file()) as { workspaces: Array<{ sessionId: string }> }).workspaces.map((w) => w.sessionId)).toEqual(['s1']))
  })
})
