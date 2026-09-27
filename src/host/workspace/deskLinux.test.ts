import { describe, it, expect } from 'vitest'
import { NAMED_KEYS } from '../../core/workspace/helpers'
import { DESK_READY_MS, type DeskWindow } from '../../core/workspace/protocol'
import { XDOTOOL_KEYS, createLinuxDesks, displayEnv, imageSize, parseGeometry, pickWindow, type LinuxDeskDeps } from './deskLinux'
import type { SpawnedProc } from './posixProc'

type Mode = 'ready' | 'exit' | 'hang'

interface FakeProc extends SpawnedProc {
  file: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  mode: Mode
  signals: string[]
  exit(why: string): void
}

const png = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

/** SOI, an APP0 segment, and a SOF0 segment holding the size. */
const jpeg = (w: number, h: number): Buffer => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...new Array<number>(14).fill(0)])
  const sof = Buffer.alloc(19)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(h, 5)
  sof.writeUInt16BE(w, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])
}

const exit1 = (): Error => Object.assign(new Error('Command failed'), { code: 1 })

/** Every Xvfb spawned takes the next mode of `plan` (ready when the plan runs out): 'ready' makes its
 *  socket on the first poll, 'exit' exits on the first poll leaving a lock file behind (another Host
 *  holds the number), 'hang' never makes its socket. */
const rig = (plan: Mode[] = []) => {
  const files = new Set<string>()
  const procs: FakeProc[] = []
  const runs: Array<{ file: string; args: string[]; env: Record<string, string> }> = []
  const starts = new Map<number, number>()
  const groupsKilled: number[] = []
  const log: string[] = []
  const answers: Array<(file: string, args: string[]) => Buffer | Error | undefined> = []
  let clock = 1_000_000
  let nextPid = 700
  let xvfbs = 0
  const numberOf = (p: FakeProc): string => p.args[0].slice(1)
  const deps: LinuxDeskDeps = {
    hostEnv: { PATH: '/usr/bin', HOME: '/home/me', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' },
    spawn: (file, args, o) => {
      const cbs: Array<(why: string) => void> = []
      let ended: string | null = null
      const p: FakeProc = {
        file,
        args,
        env: o.env,
        cwd: o.cwd,
        signals: [],
        mode: file === 'Xvfb' ? (plan[xvfbs++] ?? 'ready') : 'ready',
        pid: nextPid++,
        onExit: (cb) => {
          if (ended !== null) cb(ended)
          else cbs.push(cb)
        },
        stderrTail: () => (p.mode === 'exit' ? '(EE) Server is already active for display' : ''),
        kill: (sig = 'SIGTERM') => {
          p.signals.push(sig)
          if (p.file === 'Xvfb') files.delete(`/tmp/.X11-unix/X${numberOf(p)}`)
          p.exit(`exited ${sig}`)
        },
        exit: (why) => {
          if (ended !== null) return
          ended = why
          starts.delete(p.pid!)
          for (const cb of cbs) cb(why)
        }
      }
      procs.push(p)
      starts.set(p.pid!, clock)
      return p
    },
    run: async (file, args, env) => {
      runs.push({ file, args, env })
      for (const a of answers) {
        const r = a(file, args)
        if (r instanceof Error) throw r
        if (r !== undefined) return r
      }
      return Buffer.alloc(0)
    },
    exists: async (p) => files.has(p),
    startTime: async (pid) => starts.get(pid) ?? null,
    killGroup: async (pid) => {
      groupsKilled.push(pid)
      starts.delete(pid)
    },
    sleep: async (ms) => {
      clock += ms
      for (const p of procs) {
        if (p.file !== 'Xvfb' || p.signals.length > 0) continue
        if (p.mode === 'ready') files.add(`/tmp/.X11-unix/X${numberOf(p)}`)
        if (p.mode === 'exit') {
          files.add(`/tmp/.X${numberOf(p)}-lock`)
          p.exit('exited 1')
        }
      }
    },
    now: () => clock,
    log: (m) => log.push(m)
  }
  const xdo = (fn: (args: string[]) => Buffer | Error | undefined): void => {
    answers.push((file, args) => (file === 'xdotool' ? fn(args) : undefined))
  }
  return { deps, desks: createLinuxDesks(deps), files, procs, runs, starts, groupsKilled, log, answers, xdo }
}

/** Three windows: a Hangul titled one with a pid, one with no _NET_WM_PID, and one that closes
 *  between the search and its questions. */
const threeWindows = (r: ReturnType<typeof rig>): void =>
  r.xdo((args) => {
    if (args[0] === 'search') return Buffer.from('41\n42\n43\n')
    if (args[0] === 'getwindowname') return args[1] === '41' ? Buffer.from('Astera 픽스처 창\n') : args[1] === '42' ? Buffer.from('no pid\n') : exit1()
    if (args[0] === 'getwindowgeometry')
      return Buffer.from(args[2] === '41' ? 'WINDOW=41\nX=0\nY=0\nWIDTH=900\nHEIGHT=700\nSCREEN=0\n' : 'WINDOW=42\nX=5\nY=5\nWIDTH=200\nHEIGHT=100\nSCREEN=0\n')
    if (args[0] === 'getwindowpid') return args[1] === '41' ? Buffer.from('4242\n') : exit1()
    return undefined
  })

describe('the Linux desk: Xvfb', () => {
  it('starts Xvfb on the first free display from 90, waits for its socket, and records its pid and start time', async () => {
    const r = rig()
    r.files.add('/tmp/.X11-unix/X90')
    r.files.add('/tmp/.X91-lock')
    const desk = await r.desks.start('astera-ws-1-1')
    const x = r.procs[0]
    expect(x.file).toBe('Xvfb')
    expect(x.args).toEqual([':92', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'])
    expect(desk.name).toBe('astera-ws-1-1')
    expect(desk.pid).toBe(x.pid)
    expect(desk.startedAt).toBe(1_000_000)
    expect(desk.alive()).toBe(true)
  })

  it('gives two desks that start at the same moment two displays (Review Focus 1)', async () => {
    const r = rig()
    const [a, b] = await Promise.all([r.desks.start('a'), r.desks.start('b')])
    expect(r.procs.map((p) => p.args[0]).sort()).toEqual([':90', ':91'])
    expect(a.pid).not.toBe(b.pid)
  })

  it('tries the next display when Xvfb exits before its socket appears (another Host took the number)', async () => {
    const r = rig(['exit', 'ready'])
    const desk = await r.desks.start('a')
    expect(r.procs.map((p) => p.args[0])).toEqual([':90', ':91'])
    expect(desk.pid).toBe(r.procs[1].pid)
    expect(r.log.some((l) => l.includes('Xvfb :90 exited before it was ready') && l.includes('already active'))).toBe(true)
  })

  it('gives up after three displays that all exit, with the last reason', async () => {
    const r = rig(['exit', 'exit', 'exit'])
    await expect(r.desks.start('a')).rejects.toThrow('Xvfb could not start: exited 1: (EE) Server is already active for display')
    expect(r.procs).toHaveLength(3)
  })

  it('fails within the ready limit when the socket never appears, kills that Xvfb, and frees the number', async () => {
    const r = rig(['hang'])
    await expect(r.desks.start('a')).rejects.toThrow(`Xvfb :90 did not open its display within ${DESK_READY_MS / 1000} s`)
    expect(r.procs[0].signals).toEqual(['SIGKILL'])
    await r.desks.start('b')
    expect(r.procs[1].args[0]).toBe(':90')
  })

  it('reports an Xvfb that dies later through onExit, and refuses to launch on it', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const why: string[] = []
    desk.onExit((w) => why.push(w))
    r.procs[0].exit('exited SIGKILL')
    expect(why).toEqual(['exited SIGKILL'])
    expect(desk.alive()).toBe(false)
    await expect(desk.launch({ command: 'app', cwd: '/p', env: {} })).rejects.toThrow('the virtual display ended (exited SIGKILL)')
  })
})

describe('the Linux desk: start times come from the kernel, never the clock', () => {
  it('ends that Xvfb, frees the number, and fails when its start time cannot be read', async () => {
    const r = rig()
    const real = r.deps.startTime
    r.deps.startTime = async () => null
    await expect(r.desks.start('a')).rejects.toThrow('Xvfb :90 ended before its start time could be read')
    expect(r.procs[0].signals).toEqual(['SIGKILL'])
    r.deps.startTime = real
    await r.desks.start('b')
    expect(r.procs[1].args[0]).toBe(':90')
  })

  it('records an app that is already gone with start time 0, which no live process matches, and never kills for it', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const real = r.deps.startTime
    r.deps.startTime = async (pid) => (pid === r.procs[0].pid ? real(pid) : null)
    const got = await desk.launch({ command: 'true', cwd: '/p', env: {} })
    expect(got).toEqual({ pid: r.procs[1].pid, startedAt: 0 })
    expect(r.log.some((l) => l.includes(`pid ${got.pid} exited before its start time could be read`))).toBe(true)
    await desk.close()
    expect(r.groupsKilled).toEqual([])
  })

  it('refuses a launch whose sh never got a pid, with the reason', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const spawn = r.deps.spawn
    r.deps.spawn = (file, args, o) => {
      const p = spawn(file, args, o)
      return { ...p, pid: undefined, onExit: p.onExit, stderrTail: () => 'spawn sh ENOENT', kill: p.kill }
    }
    await expect(desk.launch({ command: 'app', cwd: '/p', env: {} })).rejects.toThrow('launch: sh could not start (spawn sh ENOENT)')
  })

  it('fails at once, without trying other displays, when Xvfb itself cannot be started', async () => {
    const r = rig()
    const spawn = r.deps.spawn
    r.deps.spawn = (file, args, o) => {
      const p = spawn(file, args, o) as FakeProc
      p.exit('Xvfb could not start: spawn Xvfb ENOENT')
      return { ...p, pid: undefined, onExit: p.onExit, stderrTail: () => '', kill: p.kill }
    }
    await expect(r.desks.start('a')).rejects.toThrow('Xvfb could not start: spawn Xvfb ENOENT')
    expect(r.procs).toHaveLength(1)
  })
})

describe('the Linux desk: launch, kill and close', () => {
  it('runs the command through sh on the display, with no Wayland and the x11 hint, and its start time from /proc', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const got = await desk.launch({
      command: 'npm run dev',
      cwd: '/home/me/proj',
      env: { PATH: '/usr/bin', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0', ASTERA_APP_CDP_PORT: '9333' }
    })
    const app = r.procs[1]
    expect(app.file).toBe('sh')
    expect(app.args).toEqual(['-c', 'npm run dev'])
    expect(app.cwd).toBe('/home/me/proj')
    expect(app.env).toEqual({
      PATH: '/usr/bin',
      DISPLAY: ':90',
      ASTERA_APP_CDP_PORT: '9333',
      ELECTRON_OZONE_PLATFORM_HINT: 'x11',
      XDG_SESSION_TYPE: 'x11',
      GDK_BACKEND: 'x11'
    })
    expect(got).toEqual({ pid: app.pid, startedAt: r.starts.get(app.pid!) })
  })

  it('kills a launched group only while its start time matches; a reused pid and an app already gone are left alone', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const got = await desk.launch({ command: 'app', cwd: '/p', env: {} })
    await desk.kill(got.pid, got.startedAt + 60_000)
    expect(r.groupsKilled).toEqual([])
    expect(r.log.some((l) => l.includes(`start time mismatch: pid ${got.pid}`))).toBe(true)
    await desk.kill(got.pid, got.startedAt + 1_500)
    expect(r.groupsKilled).toEqual([got.pid])
    await expect(desk.kill(got.pid, got.startedAt)).resolves.toBeUndefined()
    expect(r.groupsKilled).toEqual([got.pid])
    expect(r.log.some((l) => l.includes(`pid ${got.pid} is not running`))).toBe(true)
  })

  it('close ends every launched group, then Xvfb, and frees the display', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const one = await desk.launch({ command: 'a', cwd: '/p', env: {} })
    const two = await desk.launch({ command: 'b', cwd: '/p', env: {} })
    await desk.close()
    expect(r.groupsKilled).toEqual([one.pid, two.pid])
    expect(r.procs[0].signals).toEqual(['SIGTERM'])
    expect(desk.alive()).toBe(false)
    await r.desks.start('b')
    expect(r.procs.at(-1)!.args[0]).toBe(':90')
  })

  it('close after the app exited by itself still ends Xvfb, and rejects nothing', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const one = await desk.launch({ command: 'a', cwd: '/p', env: {} })
    r.starts.delete(one.pid)
    await expect(desk.close()).resolves.toBeUndefined()
    expect(r.groupsKilled).toEqual([])
    expect(r.procs[0].signals).toEqual(['SIGTERM'])
  })
})

describe('the Linux desk: windows, shots and keys', () => {
  it("lists the display's windows: a Hangul title intact, a window with no pid as pid 0, one that closed meanwhile left out (Review Focus 4)", async () => {
    const r = rig()
    threeWindows(r)
    const desk = await r.desks.start('a')
    expect(await desk.windows()).toEqual([
      { hwnd: 41, title: 'Astera 픽스처 창', className: '', pid: 4242, width: 900, height: 700, visible: true },
      { hwnd: 42, title: 'no pid', className: '', pid: 0, width: 200, height: 100, visible: true }
    ])
    expect(r.runs[0]).toMatchObject({ file: 'xdotool', args: ['search', '--onlyvisible', '--name', ''] })
    expect(r.runs.every((x) => x.env.DISPLAY === ':90' && x.env.WAYLAND_DISPLAY === undefined)).toBe(true)
  })

  it('lists nothing when xdotool finds no window (it exits 1)', async () => {
    const r = rig()
    r.xdo((args) => (args[0] === 'search' ? exit1() : undefined))
    expect(await (await r.desks.start('a')).windows()).toEqual([])
  })

  it('photographs the largest titled window, scaled for a frame, and reads the size from the image', async () => {
    const r = rig()
    threeWindows(r)
    r.answers.push((file) => (file === 'import' ? jpeg(900, 700) : undefined))
    const desk = await r.desks.start('a')
    expect(await desk.shot({ format: 'jpeg', maxWidth: 960 })).toEqual({ data: jpeg(900, 700).toString('base64'), width: 900, height: 700, title: 'Astera 픽스처 창' })
    expect(r.runs.at(-1)).toMatchObject({ file: 'import', args: ['-display', ':90', '-window', '41', '-resize', '960x>', 'jpeg:-'] })
  })

  it('photographs the whole display when no window has a title (R2), and throws the Windows words for a title nothing matches', async () => {
    const r = rig()
    r.xdo((args) => (args[0] === 'search' ? exit1() : undefined))
    r.answers.push((file) => (file === 'import' ? png(1920, 1080) : undefined))
    const desk = await r.desks.start('a')
    expect(await desk.shot({ format: 'png' })).toMatchObject({ width: 1920, height: 1080, title: '' })
    expect(r.runs.at(-1)!.args).toEqual(['-display', ':90', '-window', 'root', 'png:-'])
    await expect(desk.shot({ title: 'Import', format: 'png' })).rejects.toThrow('no window titled "Import" is showing on this desktop')
  })

  it('types into a window by focusing it and sending XTEST keys (R1), and maps the named keys', async () => {
    const r = rig()
    threeWindows(r)
    const desk = await r.desks.start('a')
    await desk.keys({ title: '픽스처', text: '-hi 안녕' })
    await desk.keys({ title: 'astera', key: 'Enter' })
    expect(r.runs.filter((x) => x.args[0] === 'windowfocus').map((x) => x.args)).toEqual([
      ['windowfocus', '41', 'type', '--delay', '0', '--', '-hi 안녕'],
      ['windowfocus', '41', 'key', '--clearmodifiers', 'Return']
    ])
    await expect(desk.keys({ title: 'nothing like it', text: 'x' })).rejects.toThrow('no window titled "nothing like it"')
    await expect(desk.keys({ title: 'Astera', key: 'F13' })).rejects.toThrow('unknown key F13')
  })

  it('knows every key name press() knows', () => {
    for (const k of NAMED_KEYS) expect(XDOTOOL_KEYS[k], k).toBeTruthy()
  })
})

describe('the Linux desk: pure parts', () => {
  it('points the env at the display and drops Wayland, so an app started from a Wayland desktop cannot reach its screen (ruling F5)', () => {
    expect(displayEnv({ A: '1', WAYLAND_DISPLAY: 'w', DISPLAY: ':0', GONE: undefined, XDG_SESSION_TYPE: 'wayland', GDK_BACKEND: 'wayland' }, 93)).toEqual({
      A: '1',
      DISPLAY: ':93',
      ELECTRON_OZONE_PLATFORM_HINT: 'x11',
      XDG_SESSION_TYPE: 'x11',
      GDK_BACKEND: 'x11'
    })
  })

  it('gives every desk tool the same X11 only env (ruling F5)', async () => {
    const r = rig()
    r.xdo((args) => (args[0] === 'search' ? exit1() : undefined))
    r.answers.push((file) => (file === 'import' ? png(1920, 1080) : undefined))
    r.deps.hostEnv.XDG_SESSION_TYPE = 'wayland'
    const desk = await r.desks.start('a')
    await desk.shot({ format: 'png' })
    expect(r.runs.length).toBeGreaterThan(0)
    for (const x of r.runs) expect(x.env).toMatchObject({ DISPLAY: ':90', XDG_SESSION_TYPE: 'x11', GDK_BACKEND: 'x11' })
    expect(r.runs.every((x) => !('WAYLAND_DISPLAY' in x.env))).toBe(true)
  })

  it('reads geometry, and image sizes from PNG and JPEG headers', () => {
    expect(parseGeometry('WINDOW=1\nX=0\nY=0\nWIDTH=640\nHEIGHT=480\nSCREEN=0\n')).toEqual({ width: 640, height: 480 })
    expect(parseGeometry('nonsense')).toEqual({ width: 0, height: 0 })
    expect(imageSize(png(3, 4))).toEqual({ width: 3, height: 4 })
    expect(imageSize(jpeg(960, 540))).toEqual({ width: 960, height: 540 })
    expect(imageSize(Buffer.from('not an image'))).toEqual({ width: 0, height: 0 })
  })

  it('picks the largest showing titled window, matching the title case blind', () => {
    const w = (hwnd: number, title: string, width: number, visible = true): DeskWindow => ({ hwnd, title, className: '', pid: 1, width, height: 100, visible })
    const list = [w(1, 'Small Import', 100), w(2, 'Big import', 500), w(3, '', 900), w(4, 'Hidden Import', 900, false)]
    expect(pickWindow(list)?.hwnd).toBe(2)
    expect(pickWindow(list, 'IMPORT')?.hwnd).toBe(2)
    expect(pickWindow(list, 'small')?.hwnd).toBe(1)
    expect(pickWindow(list, 'nope')).toBeNull()
  })
})
