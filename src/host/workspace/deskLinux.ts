// The Linux Desk (Linux and macOS design, Linux Desk): one Xvfb per workspace on a display nobody looks
// at, the app launched on it through sh in a process group of its own, its windows listed and typed
// into with xdotool and photographed with ImageMagick's import. It needs no interactive session (L2):
// Xvfb is the display. Its clipboard is Xvfb's own, not the person's.
//
// Every process and file it touches arrives in `LinuxDeskDeps`, so the tests drive it on any OS;
// `realLinuxDeskDeps` is the real one.
import { promises as fs } from 'node:fs'
import type { DeskHandle } from '../../core/workspace/helpers'
import { START_TIME_TOLERANCE_MS } from '../../core/workspace/lifecycle'
import { DESK_CLOSE_MS, DESK_READY_MS, type DeskLaunched, type DeskShot, type DeskWindow } from '../../core/workspace/protocol'
import { execText, killGroup, linuxStartTimes, realLinuxProcFs, runTool, spawnDetached, type RunTool, type SpawnDetached, type SpawnedProc } from './posixProc'

export const FIRST_DISPLAY = 90
export const LAST_DISPLAY = 189
export const XVFB_SCREEN = '1920x1080x24'
/** How many display numbers one desk tries when Xvfb exits before it reports ready (R4). */
export const DISPLAY_TRIES = 3
const POLL_MS = 50
/** Characters per `xdotool type` run. At xdotool's default 12 ms per character (kept, since with no
 *  delay non US characters such as Hangul can come out wrong), 400 take about 5 s, well inside the
 *  15 s a desk request may run (DESK_REQUEST_MS). */
export const TYPE_CHUNK = 400
/** The fd Xvfb reports its display number on once it accepts connections (-displayfd). */
const READY_FD = 3

/** The key names press() and keys() take (NAMED_KEYS, helpers.ts), as X keysyms. */
export const XDOTOOL_KEYS: Record<string, string> = {
  Enter: 'Return',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'BackSpace',
  Delete: 'Delete',
  Space: 'space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'Prior',
  PageDown: 'Next'
}

export interface LinuxDeskDeps {
  /** The Host's environment, the base Xvfb and every tool run with. */
  hostEnv: Record<string, string | undefined>
  spawn: SpawnDetached
  run: RunTool
  exists(p: string): Promise<boolean>
  /** A live pid's start time in epoch ms from /proc, or null when it is gone. */
  startTime(pid: number): Promise<number | null>
  killGroup(pid: number): Promise<void>
  /** Resolves after ms, or at once when `signal` aborts (its timer cleared). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  now(): number
  log(m: string): void
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const stringEnv = (env: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v
  return out
}

/** The env a process on display :n sees: its own, pointed at the display, never at a Wayland one, and
 *  Electron told to speak X11 (spec, Launch). Electron 38 and later no longer read
 *  ELECTRON_OZONE_PLATFORM_HINT, and with XDG_SESSION_TYPE=wayland left in place Chromium's auto
 *  selection and GTK could still pick Wayland, where libwayland falls back to `wayland-0`: the person's
 *  own screen. So the session type and GTK's backend say x11 too (preflight ruling F5). Any command can
 *  be launched, not only Electron, so Qt and SDL are pointed at X11 as well, and WAYLAND_SOCKET (an
 *  inherited compositor connection libwayland takes before anything else) goes with WAYLAND_DISPLAY. */
export function displayEnv(env: Record<string, string | undefined>, display: number): Record<string, string> {
  const out = stringEnv(env)
  delete out.WAYLAND_DISPLAY
  delete out.WAYLAND_SOCKET
  out.DISPLAY = `:${display}`
  out.ELECTRON_OZONE_PLATFORM_HINT = 'x11'
  out.XDG_SESSION_TYPE = 'x11'
  out.GDK_BACKEND = 'x11'
  out.QT_QPA_PLATFORM = 'xcb'
  out.SDL_VIDEODRIVER = 'x11'
  return out
}

/** `text` in runs of at most `size` characters, never splitting a surrogate pair. */
function chunks(text: string, size: number): string[] {
  const chars = Array.from(text)
  const out: string[] = []
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''))
  return out
}

/** `xdotool getwindowgeometry --shell`: WINDOW=, X=, Y=, WIDTH=, HEIGHT=, SCREEN= lines. */
export function parseGeometry(text: string): { width: number; height: number } {
  const w = /^WIDTH=(\d+)$/m.exec(text)
  const h = /^HEIGHT=(\d+)$/m.exec(text)
  return { width: w ? Number(w[1]) : 0, height: h ? Number(h[1]) : 0 }
}

/** Width and height of a PNG (its IHDR) or a JPEG (its first SOF marker); zeros for anything else. */
export function imageSize(b: Buffer): { width: number; height: number } {
  if (b.length >= 24 && b[0] === 0x89 && b.toString('ascii', 12, 16) === 'IHDR') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) break
      const marker = b[i + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }
      i += 2 + b.readUInt16BE(i + 2)
    }
  }
  return { width: 0, height: 0 }
}

/** The largest showing window with a title, containing `title` when one is given (case blind): the
 *  Windows helper's Find rule, so windowShot and keys pick the same window on both (R2). */
export function pickWindow(list: readonly DeskWindow[], title?: string): DeskWindow | null {
  const want = title?.toLowerCase()
  let best: DeskWindow | null = null
  for (const w of list) {
    if (!w.visible || w.width <= 0 || w.height <= 0 || w.title === '') continue
    if (want !== undefined && !w.title.toLowerCase().includes(want)) continue
    if (!best || w.width * w.height > best.width * best.height) best = w
  }
  return best
}

const noWindow = (title: string): Error => new Error(`no window titled "${title}" is showing on this desktop`)

export function createLinuxDesks(d: LinuxDeskDeps): { start(name: string): Promise<DeskHandle> } {
  /** Display numbers this Host holds or is probing (R4). */
  const taken = new Set<number>()

  const reserve = async (): Promise<number> => {
    for (let n = FIRST_DISPLAY; n <= LAST_DISPLAY; n++) {
      if (taken.has(n)) continue
      // Reserved before the probes' awaits, so a desk starting at the same moment skips it (Review
      // Focus 1).
      taken.add(n)
      if ((await d.exists(`/tmp/.X11-unix/X${n}`)) || (await d.exists(`/tmp/.X${n}-lock`))) {
        taken.delete(n)
        continue
      }
      return n
    }
    throw new Error(`no free X display between :${FIRST_DISPLAY} and :${LAST_DISPLAY}`)
  }

  /** One Xvfb on :n, ready once it writes n to its -displayfd pipe, which only this Xvfb can do: a
   *  socket file for :n proves nothing, since another X server may have made it between the probe and
   *  this spawn (fix round 1). `taken` when it exits first (the number went to someone else); a throw
   *  when it never reports within the ready limit. */
  const startXvfb = async (n: number): Promise<{ proc: SpawnedProc } | { taken: string }> => {
    const proc = d.spawn('Xvfb', [`:${n}`, '-screen', '0', XVFB_SCREEN, '-nolisten', 'tcp', '-displayfd', String(READY_FD)], {
      env: stringEnv(d.hostEnv),
      stderr: true,
      readyFd: true
    })
    const reported = (): boolean => (proc.readyText?.() ?? '').split('\n').some((l) => l.trim() === String(n))
    const st = { exited: null as string | null }
    proc.onExit((why) => {
      st.exited = why
    })
    const until = d.now() + DESK_READY_MS
    for (;;) {
      if (st.exited !== null) {
        // No pid: Xvfb itself could not be started (not installed, not executable). Another display
        // number would not help.
        if (proc.pid === undefined) throw new Error(st.exited)
        const tail = proc.stderrTail()
        return { taken: tail ? `${st.exited}: ${tail}` : st.exited }
      }
      if (reported()) return { proc }
      if (d.now() >= until) {
        proc.kill('SIGKILL')
        throw new Error(`Xvfb :${n} did not open its display within ${DESK_READY_MS / 1000} s`)
      }
      await d.sleep(POLL_MS)
    }
  }

  const start = async (name: string): Promise<DeskHandle> => {
    let xvfb: SpawnedProc | null = null
    let display = 0
    let lastWhy = ''
    for (let i = 0; i < DISPLAY_TRIES && xvfb === null; i++) {
      display = await reserve()
      let r: { proc: SpawnedProc } | { taken: string }
      try {
        r = await startXvfb(display)
      } catch (err) {
        taken.delete(display)
        throw err
      }
      if ('proc' in r) xvfb = r.proc
      else {
        // Freed at once: the other Host's lock file keeps the next probe off it.
        taken.delete(display)
        lastWhy = r.taken
        d.log(`Xvfb :${display} exited before it was ready (${r.taken}); trying the next display`)
      }
    }
    if (xvfb === null || xvfb.pid === undefined) throw new Error(`Xvfb could not start: ${lastWhy || 'no reason given'}`)
    const proc = xvfb
    const pid = xvfb.pid
    // From /proc, never the clock: the leftover sweep compares this with the kernel's own record.
    const readAt = await d.startTime(pid).catch((err: unknown) => {
      proc.kill('SIGKILL')
      taken.delete(display)
      throw err
    })
    if (readAt === null) {
      proc.kill('SIGKILL')
      taken.delete(display)
      throw new Error(`Xvfb :${display} ended before its start time could be read`)
    }
    const startedAt = readAt
    const env = displayEnv(d.hostEnv, display)
    const launched = new Map<number, number>()
    const exitCbs: Array<(why: string) => void> = []
    const st = { dead: null as string | null }
    let exitedResolve!: () => void
    const exited = new Promise<'exited'>((resolve) => {
      exitedResolve = () => resolve('exited')
    })
    proc.onExit((why) => {
      st.dead = why
      taken.delete(display)
      exitedResolve()
      for (const cb of exitCbs) {
        try {
          cb(why)
        } catch (err) {
          d.log(`desktop ${name}: an Xvfb exit listener threw: ${String(err)}`)
        }
      }
    })
    d.log(`desktop ${name}: Xvfb :${display} is ready (pid ${pid})`)

    const live = (): void => {
      if (st.dead !== null) throw new Error(`the virtual display ended (${st.dead})`)
    }
    const xdotool = (args: string[]): Promise<Buffer> => d.run('xdotool', args, env)
    const line = (b: Buffer): string => b.toString('utf8').replace(/\n$/, '')

    const windows = async (): Promise<DeskWindow[]> => {
      live()
      const ids = await xdotool(['search', '--onlyvisible', '--name', '']).then(
        (b) =>
          b
            .toString('utf8')
            .split('\n')
            .map((s) => s.trim())
            .filter((s) => /^\d+$/.test(s)),
        (err: { code?: unknown }) => {
          if (err?.code === 1) return [] as string[]
          throw err
        }
      )
      const out: DeskWindow[] = []
      for (const id of ids) {
        // A window that closes between the search and these questions is left out (Review Focus 4).
        const w = await Promise.all([
          xdotool(['getwindowname', id]).then(line),
          xdotool(['getwindowgeometry', '--shell', id]).then((b) => parseGeometry(b.toString('utf8'))),
          xdotool(['getwindowpid', id]).then(
            (b) => Number(line(b).trim()) || 0,
            () => 0
          )
        ]).catch(() => null)
        if (w) out.push({ hwnd: Number(id), title: w[0], className: '', pid: w[2], width: w[1].width, height: w[1].height, visible: true })
      }
      return out
    }

    const kill = async (p: number, at: number): Promise<void> => {
      const liveAt = await d.startTime(p)
      if (liveAt === null) {
        launched.delete(p)
        d.log(`desktop ${name}: pid ${p} is not running`)
        return
      }
      if (Math.abs(liveAt - at) > START_TIME_TOLERANCE_MS) {
        launched.delete(p)
        d.log(`desktop ${name}: start time mismatch: pid ${p} started at ${liveAt}, not ${at}; left alone`)
        return
      }
      await d.killGroup(p)
      launched.delete(p)
    }

    return {
      name,
      pid,
      startedAt,
      alive: () => st.dead === null,
      onExit: (cb) => {
        exitCbs.push(cb)
      },
      launch: async (a): Promise<DeskLaunched> => {
        live()
        // `wait` keeps sh, the group's leader, alive while anything the command put in the background
        // still runs, so the group always has a leader with a real start time to kill by (fix round 1).
        // A newline, not `;`, so a command ending in a comment still reaches it.
        const child = d.spawn('sh', ['-c', `${a.command}\nwait`], { env: displayEnv(a.env, display), cwd: a.cwd })
        if (child.pid === undefined) throw new Error(`launch: sh could not start (${child.stderrTail() || 'no reason given'})`)
        const cpid = child.pid
        // From /proc, never the clock. A command gone already (it exited at once) is recorded with 0,
        // which no live process matches, so a later kill or sweep never reaches a reused pid. When the
        // read itself fails the fresh group is ended here, since nothing else will know to (fix round 1).
        const at = await d.startTime(cpid).catch(async (err: unknown) => {
          await d.killGroup(cpid).catch((again: unknown) => d.log(`desktop ${name}: pid ${cpid} could not be ended: ${messageOf(again)}`))
          throw err
        })
        if (at === null) {
          d.log(`desktop ${name}: pid ${child.pid} exited before its start time could be read; recorded with start time 0`)
          return { pid: child.pid, startedAt: 0 }
        }
        launched.set(child.pid, at)
        return { pid: child.pid, startedAt: at }
      },
      kill,
      windows,
      shot: async (o): Promise<DeskShot> => {
        const w = pickWindow(await windows(), o.title)
        if (!w && o.title !== undefined) throw noWindow(o.title)
        const args = ['-display', `:${display}`, '-window', w ? String(w.hwnd) : 'root']
        if (o.maxWidth !== undefined && o.maxWidth > 0) args.push('-resize', `${o.maxWidth}x>`)
        args.push(`${o.format}:-`)
        const bytes = await d.run('import', args, env)
        const size = imageSize(bytes)
        if (size.width === 0) throw new Error(`import returned no ${o.format} image`)
        return { data: bytes.toString('base64'), width: size.width, height: size.height, title: w?.title ?? '' }
      },
      keys: async (o) => {
        const w = pickWindow(await windows(), o.title)
        if (!w) throw noWindow(o.title)
        const id = String(w.hwnd)
        // R1: focus, then XTEST, in one xdotool run. `--window` would use XSendEvent, whose synthetic
        // events Chromium ignores; this display is the workspace's own, so focusing takes nothing.
        if (o.key !== undefined) {
          const sym = XDOTOOL_KEYS[o.key]
          if (!sym) throw new Error(`unknown key ${o.key}`)
          await xdotool(['windowfocus', id, 'key', '--clearmodifiers', sym])
        }
        if (o.text !== undefined) for (const piece of chunks(o.text, TYPE_CHUNK)) await xdotool(['windowfocus', id, 'type', '--', piece])
      },
      close: async () => {
        for (const [p, at] of [...launched]) await kill(p, at).catch((err) => d.log(`desktop ${name}: pid ${p} could not be ended: ${messageOf(err)}`))
        if (st.dead === null) {
          proc.kill('SIGTERM')
          const stop = new AbortController()
          const late = d.sleep(DESK_CLOSE_MS, stop.signal).then(() => 'late' as const)
          const first = await Promise.race([exited, late])
          stop.abort()
          if (first === 'late' && st.dead === null) {
            d.log(`desktop ${name}: Xvfb did not exit within ${DESK_CLOSE_MS / 1000} s of SIGTERM; killing it`)
            proc.kill('SIGKILL')
          }
        }
        taken.delete(display)
      }
    }
  }

  return { start }
}

export function realLinuxDeskDeps(a: { hostEnv: Record<string, string | undefined>; log(m: string): void }): LinuxDeskDeps {
  const procFs = realLinuxProcFs(execText)
  return {
    hostEnv: a.hostEnv,
    spawn: spawnDetached,
    run: runTool,
    exists: (p) => fs.access(p).then(() => true, () => false),
    startTime: async (pid) => (await linuxStartTimes([pid], procFs)).get(pid) ?? null,
    killGroup: (pid) => killGroup(pid),
    sleep: (ms, signal) =>
      new Promise((r) => {
        if (signal?.aborted) return r()
        const t = setTimeout(r, ms)
        t.unref?.()
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t)
            r()
          },
          { once: true }
        )
      }),
    now: Date.now,
    log: a.log
  }
}
