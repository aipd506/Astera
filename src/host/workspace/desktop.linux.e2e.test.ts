// The agent app workspace on a real Linux virtual display (Linux and macOS design, Testing). Gated
// twice: linux and ASTERA_DESKTOP_E2E=1, because it starts Xvfb and Electron. CI runs it on the ubuntu
// job after installing xvfb, xdotool and imagemagick (.github/workflows/ci.yml). It checks that the app
// ran on the workspace's own display and not on the one the Host was started with; that CDP driving, a
// drag, a file drop, a native capture and native keys (Hangul too, at xdotool's default delay) work
// there; and that nothing is left once the workspace is closed or its Xvfb dies: no Xvfb, no fixture,
// no record.
//
// The Host here is given a person's session to stay off: a DISPLAY that names no server, a Wayland one
// (WAYLAND_DISPLAY, WAYLAND_SOCKET, XDG_SESSION_TYPE=wayland), a session bus and a runtime folder. The
// runner has none of them, so without them the check that the app never reaches the person's session
// would pass for want of a session to reach.
import { describe, it, expect, afterAll, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostWorkerBaseEnv } from '../../core/host/spawn'
import type { DeskHandle } from '../../core/workspace/helpers'
import { connectCdp } from './cdp'
import { electronExe, exists, read2 } from './e2eSupport'
import { createLaunchResolver } from './launch'
import { probeLinuxTools, realProbeDeps } from './linuxTools'
import { createWorkspaceManager, type WorkspaceEvent, type WorkspaceManager } from './manager'
import { freePort, killTree, processStartTimes } from './native'
import { workspaceDeskStarter } from './platformDesk'

const here = path.dirname(fileURLToPath(import.meta.url))
const enabled = process.platform === 'linux' && process.env.ASTERA_DESKTOP_E2E === '1'
const TITLE = 'Astera workspace fixture'
const NUL = String.fromCharCode(0)
/** Typed with native keys: Latin, then Hangul, which needs xdotool's default per character delay. */
const TYPED = 'hi 한글 입력'

/** The session the Host was "started from": a person's X display and Wayland compositor, neither of
 *  which exists, so an app that reached either would fail to open rather than appear on a real screen. */
const PERSON_DISPLAY = ':1999'
const PERSON_WAYLAND = 'astera-e2e-person-wayland'
/** The person's session bus and runtime folder (review I1): an app that kept either could reach their
 *  portals, notifications, tray, `wayland-0` and audio. Neither exists here either. */
const PERSON_BUS = 'unix:path=/nonexistent/astera-e2e-person/bus'
const PERSON_RUNTIME = '/nonexistent/astera-e2e-person'
const hostEnv: Record<string, string | undefined> = {
  ...process.env,
  DISPLAY: PERSON_DISPLAY,
  WAYLAND_DISPLAY: PERSON_WAYLAND,
  // An inherited compositor connection, which libwayland would take before WAYLAND_DISPLAY (review M6).
  WAYLAND_SOCKET: '99',
  XDG_SESSION_TYPE: 'wayland',
  DBUS_SESSION_BUS_ADDRESS: PERSON_BUS,
  XDG_RUNTIME_DIR: PERSON_RUNTIME
}

// --no-sandbox: the runner's Electron has no set up SUID sandbox helper, and Ubuntu 24.04 blocks the
// unprivileged user namespaces Chromium falls back to.
const commandFor = (udd: string): string =>
  `"${electronExe()}" "${path.join(here, 'fixtures', 'app', 'main.cjs')}" --no-sandbox --remote-debugging-port=$ASTERA_APP_CDP_PORT --user-data-dir="${udd}"`

/** Pids whose command line holds this user data folder, read from /proc: the `sh -c` the desk wraps
 *  the command in, Electron, and its helpers. */
const fixturePids = async (udd: string): Promise<number[]> => {
  const out: number[] = []
  for (const name of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const cmd = await fs.readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '')
    if (cmd.includes(udd)) out.push(Number(name))
  }
  return out
}

/** A live process's environment, or null when it cannot be read (gone, or not ours). */
const envOf = async (pid: number): Promise<Map<string, string> | null> => {
  const raw = await fs.readFile(`/proc/${pid}/environ`, 'utf8').catch(() => null)
  if (raw === null || raw === '') return null
  const out = new Map<string, string>()
  for (const kv of raw.split(NUL)) {
    const i = kv.indexOf('=')
    if (i > 0) out.set(kv.slice(0, i), kv.slice(i + 1))
  }
  return out
}

const recordedPids = async (recordFile: string): Promise<number[]> => {
  const record = JSON.parse(await fs.readFile(recordFile, 'utf8')) as { workspaces: Array<{ pids: Array<{ pid: number }> }> }
  return record.workspaces[0].pids.map((p) => p.pid)
}

interface Harness {
  m: WorkspaceManager
  events: WorkspaceEvent[]
  desks: DeskHandle[]
  log: string[]
  recordFile: string
}

const harness = async (profile: string): Promise<Harness> => {
  await fs.mkdir(profile, { recursive: true })
  const h: Harness = { m: undefined as unknown as WorkspaceManager, events: [], desks: [], log: [], recordFile: path.join(profile, 'orch', 'workspaces.json') }
  const start = workspaceDeskStarter({ platform: 'linux', profileDir: profile, hostEnv, log: (m) => h.log.push(m) })
  h.m = createWorkspaceManager({
    platform: process.platform,
    env: hostEnv,
    recordFile: h.recordFile,
    shotsDir: path.join(profile, 'preview', 'shots'),
    enabled: async () => true,
    guide: () => '',
    sessionCwd: async () => path.join(here, 'fixtures', 'app'),
    resolveLaunch: createLaunchResolver({
      runConfigsFile: path.join(profile, 'run-configs.json'),
      platform: process.platform,
      baseEnv: () => hostWorkerBaseEnv(hostEnv),
      projectRoot: async (c) => c
    }),
    startDesk: async (name) => {
      const desk = await start(name)
      h.desks.push(desk)
      return desk
    },
    linuxTools: () => probeLinuxTools(realProbeDeps(process.env)),
    connectCdp: (port, waitMs) => connectCdp(port, waitMs),
    freePort,
    killTree: (pid) => killTree(pid),
    startTimes: (pids) => processStartTimes(pids),
    emit: (e) => h.events.push(e),
    hasWatchers: () => true,
    log: (m) => h.log.push(m)
  })
  return h
}

describe.runIf(enabled)('the agent app workspace on a real Linux virtual display', () => {
  let dir = ''
  const managers: WorkspaceManager[] = []
  const udds: string[] = []
  const stale: string[] = []
  afterAll(async () => {
    // A failed run must not leave anything behind either: the managers end what they hold, then any
    // fixture process this run started (found by its own user data folder) is ended by pid.
    for (const m of managers) await m.dispose().catch(() => undefined)
    for (const udd of udds) for (const pid of await fixturePids(udd).catch(() => [])) await killTree(pid).catch(() => undefined)
    for (const f of stale) await fs.rm(f, { force: true })
    if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }, 60_000)

  const tempDir = async (): Promise<string> => {
    if (!dir) dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera 리눅스 e2e-'))
    return dir
  }

  it(
    'launches, drives, photographs, types into and closes the fixture on its own display',
    async () => {
      const base = await tempDir()
      const udd = path.join(base, 'electron-profile')
      udds.push(udd)
      const dropped = path.join(base, 'drop me.txt')
      await fs.writeFile(dropped, 'x', 'utf8')
      const h = await harness(path.join(base, 'profile'))
      managers.push(h.m)

      // 1. Launch, and look.
      const first = await h.m.run('s-e2e', `log(await launch({ command: ${JSON.stringify(commandFor(udd))} })); log((await snapshot()).title)`)
      expect(first.status).toBe(200)
      const firstBody = first.body as { log: string[]; error?: unknown }
      expect(firstBody.error).toBeUndefined()
      expect(firstBody.log[1]).toBe(TITLE)
      const xvfb = h.desks[0]
      expect(xvfb.pid).not.toBeNull()
      const xvfbArgs = (await fs.readFile(`/proc/${xvfb.pid}/cmdline`, 'utf8')).split(NUL)
      expect(xvfbArgs).toContain('-displayfd')
      const display = xvfbArgs.find((a) => /^:\d+$/.test(a))!
      expect(Number(display.slice(1))).toBeGreaterThanOrEqual(90)

      // The app is on the workspace's display, and nothing in its environment points it at the person's
      // X display or Wayland compositor.
      const running = await fixturePids(udd)
      expect(running.length).toBeGreaterThan(0)
      let read = 0
      const runtimeDirs = new Set<string>()
      for (const pid of running) {
        const env = await envOf(pid)
        if (env === null) continue
        read++
        expect(env.get('DISPLAY')).toBe(display)
        expect(env.get('DISPLAY')).not.toBe(PERSON_DISPLAY)
        expect(env.has('WAYLAND_DISPLAY')).toBe(false)
        expect(env.has('WAYLAND_SOCKET')).toBe(false)
        expect(env.get('XDG_SESSION_TYPE')).toBe('x11')
        expect(env.has('DBUS_SESSION_BUS_ADDRESS')).toBe(false)
        expect(env.get('XDG_RUNTIME_DIR')).not.toBe(PERSON_RUNTIME)
        runtimeDirs.add(env.get('XDG_RUNTIME_DIR') ?? '')
      }
      expect(read).toBeGreaterThan(0)
      // One folder of the desk's own, only this user may open, removed with the desk below.
      expect(runtimeDirs.size).toBe(1)
      const runtimeDir = [...runtimeDirs][0]
      expect(path.basename(runtimeDir)).toMatch(/^astera-xrt-/)
      expect((await fs.stat(runtimeDir)).mode & 0o777).toBe(0o700)
      await vi.waitFor(async () => expect(await recordedPids(h.recordFile)).toHaveLength(2))
      expect((await recordedPids(h.recordFile))[1]).toBe(xvfb.pid)
      const port = (JSON.parse(firstBody.log[0]) as { port: number }).port

      // 2. Drive it: click, an in-page drag, a file drop, native keys, the window list, both captures.
      const second = await h.m.run(
        's-e2e',
        [
          "await click('#b')",
          "await drag('#src', '#dst')",
          `await dropFiles('#drop', [${JSON.stringify(dropped)}])`,
          "await click('#t')",
          `await keys(${JSON.stringify(TITLE)}, ${JSON.stringify(TYPED)})`,
          `await keys(${JSON.stringify(TITLE)}, 'Enter')`,
          'await waitFor(300)',
          'log(await windows())',
          'log(await windowShot())',
          'log(await screenshot())'
        ].join('\n')
      )
      const body = second.body as { log: string[]; error?: unknown }
      expect(body.error).toBeUndefined()
      const [windowsLine, windowShotLine, screenshotLine] = body.log
      expect(JSON.parse(windowsLine)).toEqual(expect.arrayContaining([expect.objectContaining({ title: TITLE, className: '' })]))
      for (const line of [windowShotLine, screenshotLine]) {
        const shot = JSON.parse(line) as { path: string; width: number; height: number }
        expect(shot.width).toBeGreaterThan(100)
        expect((await fs.stat(shot.path)).size).toBeGreaterThan(1000)
      }
      expect(await read2(port, "document.getElementById('out').textContent")).toBe('clicked')
      const recorded = JSON.parse(String(await read2(port, 'JSON.stringify(window.events)'))) as Array<Record<string, unknown>>
      expect(recorded).toEqual(expect.arrayContaining([{ kind: 'drop', text: 'card-1' }, { kind: 'files', names: ['drop me.txt'] }]))
      expect(String(await read2(port, "document.getElementById('t').value"))).toBe(`${TYPED}\n`)
      expect(h.events.some((e) => e.kind === 'frame')).toBe(true)

      // 3. Close, and nothing is left: not the fixture, not Xvfb, not its socket, not the record.
      const third = await h.m.run('s-e2e', 'await close()')
      expect((third.body as { error?: unknown }).error).toBeUndefined()
      await h.m.dispose()
      expect(xvfb.alive()).toBe(false)
      expect(await exists(`/proc/${xvfb.pid}`)).toBe(false)
      expect(await exists(`/tmp/.X11-unix/X${display.slice(1)}`)).toBe(false)
      expect(await exists(runtimeDir)).toBe(false)
      await vi.waitFor(async () => expect(await fixturePids(udd)).toEqual([]), { timeout: 10_000, interval: 250 })
      expect(await exists(h.recordFile)).toBe(false)
      expect(h.events.filter((e) => e.kind === 'state').at(-1)).toMatchObject({ open: false })
    },
    180_000
  )

  it(
    'ends the app when its Xvfb dies',
    async () => {
      const base = await tempDir()
      const udd = path.join(base, 'electron-profile-2')
      udds.push(udd)
      const h = await harness(path.join(base, 'profile-2'))
      managers.push(h.m)

      const first = await h.m.run('s-e2e-2', `log(await launch({ command: ${JSON.stringify(commandFor(udd))} }))`)
      expect((first.body as { error?: unknown }).error).toBeUndefined()
      const running = await fixturePids(udd)
      expect(running.length).toBeGreaterThan(0)
      let runtimeDir = ''
      for (const pid of running) runtimeDir ||= (await envOf(pid))?.get('XDG_RUNTIME_DIR') ?? ''
      expect(path.basename(runtimeDir)).toMatch(/^astera-xrt-/)
      const xvfb = h.desks[0]
      const n = (await fs.readFile(`/proc/${xvfb.pid}/cmdline`, 'utf8')).split(NUL).find((a) => /^:\d+$/.test(a))!.slice(1)
      // A SIGKILLed Xvfb leaves its lock and socket; removed after the run.
      stale.push(`/tmp/.X${n}-lock`, `/tmp/.X11-unix/X${n}`)

      process.kill(xvfb.pid!, 'SIGKILL')
      await vi.waitFor(() => expect(xvfb.alive()).toBe(false), { timeout: 10_000 })
      await vi.waitFor(async () => expect(await fixturePids(udd)).toEqual([]), { timeout: 20_000, interval: 500 })
      await vi.waitFor(async () => expect(await exists(h.recordFile)).toBe(false))
      // No close follows a dead Xvfb, so the desk removes its folder when Xvfb exits.
      await vi.waitFor(async () => expect(await exists(runtimeDir)).toBe(false))
      expect(h.events.filter((e) => e.kind === 'state').at(-1)).toMatchObject({ open: false })
      expect(h.m.list()).toEqual([])
      await h.m.dispose()
    },
    120_000
  )
})
