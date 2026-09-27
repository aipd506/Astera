// The macOS Desk (Linux and macOS design, macOS Desk; L3): nothing to create. The app is launched in the
// person's own session, in the background and in a process group of its own, and driven only over
// CDP. windows(), windowShot() and keys() are refused: without the Screen Recording and Accessibility
// permissions (L3a, not built) nothing can see or type into another app's window, and this desk never
// moves one either (R5). So the app's window may sit behind the person's own (user decision L3b); the
// hide marker ASTERA_APP_CHROMIUM_FLAGS in its env lets a project app start with show:false. A plain
// command gets the Chromium switches that keep a page nobody sees rendering, in that variable for it
// to pass; an app bundle is opened with open -g -j -n (R6).
//
// Every process it touches arrives in `MacDeskDeps`, so the tests drive it on any OS; `realMacDeskDeps`
// is the real one.
import path from 'node:path'
import type { DeskHandle } from '../../core/workspace/helpers'
import { START_TIME_TOLERANCE_MS } from '../../core/workspace/lifecycle'
import { DESK_READY_MS, type DeskLaunched } from '../../core/workspace/protocol'
import { execText, killGroup, macStartTimes, parseLstart, spawnDetached, type ExecText, type SpawnDetached } from './posixProc'

export const MAC_BACKGROUND_FLAGS =
  '--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling'
const POLL_MS = 200

export const macRefusal = (helper: 'windows' | 'windowShot' | 'keys'): string =>
  `${helper}: not available on macOS (the app runs in the background and only its page can be driven)`

/** A command whose first word is an app bundle (`/Applications/X.app`, quoted or not), and the rest. */
export function bundleCommand(command: string): { bundle: string; rest: string } | null {
  const m = /^\s*(?:"([^"]+?\.app)\/?"|'([^']+?\.app)\/?'|([^\s"']+?\.app)\/?)(\s[\s\S]*)?$/.exec(command)
  if (!m) return null
  return { bundle: m[1] ?? m[2] ?? m[3], rest: (m[4] ?? '').trim() }
}

/** From `ps -Ao pid=,lstart=,command=` under LC_ALL=C: the newest process whose executable is in the
 *  bundle's Contents/MacOS folder and that started at or after `sinceMs` (within the start time
 *  tolerance, since lstart has whole seconds). Helpers under Contents/Frameworks do not count. */
export function newestBundleProcess(psText: string, bundle: string, sinceMs: number): { pid: number; startedAt: number } | null {
  const prefix = `${bundle.replace(/\/+$/, '')}/Contents/MacOS/`
  let best: { pid: number; startedAt: number } | null = null
  for (const line of psText.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line)
    if (!m || !m[3].startsWith(prefix)) continue
    const startedAt = parseLstart(m[2])
    if (startedAt === null || startedAt < sinceMs - START_TIME_TOLERANCE_MS) continue
    if (!best || startedAt >= best.startedAt) best = { pid: Number(m[1]), startedAt }
  }
  return best
}

export interface MacDeskDeps {
  spawn: SpawnDetached
  exec: ExecText
  /** A live pid's start time in epoch ms from ps, or null when it is gone. */
  startTime(pid: number): Promise<number | null>
  killGroup(pid: number): Promise<void>
  /** Resolves after ms, or at once when `signal` aborts (its timer cleared). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  now(): number
  log(m: string): void
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createMacDesks(d: MacDeskDeps): { start(name: string): Promise<DeskHandle> } {
  return {
    start: async (base) => {
      const name = `mac-bg-${base}`
      const launched = new Map<number, number>()
      let closed = false
      // Aborted by close, so a bundle launch still polling stops at once and its timer is cleared.
      const stop = new AbortController()
      const closedError = (): Error => new Error('launch: this workspace is closed')

      const endQuietly = async (p: number): Promise<void> => {
        await d.killGroup(p).catch((err: unknown) => d.log(`desktop ${name}: pid ${p} could not be ended: ${messageOf(err)}`))
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

      const openBundle = async (b: { bundle: string; rest: string }, a: { cwd: string; env: Record<string, string> }): Promise<DeskLaunched> => {
        const bundle = path.posix.resolve(a.cwd, b.bundle)
        // Only a lower bound for which process is ours; the start time itself comes from ps.
        const since = d.now()
        // -g: not brought to the front; -j: launched hidden; -n: a new instance beside the person's.
        // The bundle is $0, so its path needs no quoting; the rest is the command's own shell text.
        const opener = d.spawn('sh', ['-c', `exec open -g -j -n -a "$0" --args ${b.rest} $ASTERA_APP_CHROMIUM_FLAGS`, bundle], {
          env: { ...a.env, ASTERA_APP_CHROMIUM_FLAGS: MAC_BACKGROUND_FLAGS },
          cwd: a.cwd,
          stderr: true
        })
        if (opener.pid === undefined) throw new Error(`launch: sh could not start (${opener.stderrTail() || 'no reason given'})`)
        const st = { opened: null as string | null }
        opener.onExit((why) => {
          st.opened = why
        })
        const until = since + DESK_READY_MS
        while (d.now() < until) {
          // open exits 0 once Launch Services has the request, before the app's process may show; any
          // other end means the app will not come, and waiting out the limit would hide why.
          if (st.opened !== null && st.opened !== 'exited 0') {
            const tail = opener.stderrTail()
            throw new Error(`launch: open could not start ${bundle} (${tail ? `${st.opened}: ${tail}` : st.opened})`)
          }
          const ps = await d.exec('env', ['LC_ALL=C', 'ps', '-Ao', 'pid=,lstart=,command=']).catch((err: unknown) => {
            throw new Error(`launch: ${bundle} was opened, but ps could not list its processes: ${messageOf(err)}`)
          })
          const hit = newestBundleProcess(ps, bundle, since)
          if (hit) {
            if (closed) {
              await endQuietly(hit.pid)
              throw closedError()
            }
            launched.set(hit.pid, hit.startedAt)
            return hit
          }
          if (closed) throw closedError()
          await d.sleep(POLL_MS, stop.signal)
          if (closed) throw closedError()
        }
        throw new Error(`launch: ${bundle} was opened, but no process of it appeared within ${DESK_READY_MS / 1000} s`)
      }

      const launchCommand = async (a: { command: string; cwd: string; env: Record<string, string> }): Promise<DeskLaunched> => {
        // `wait` keeps sh, the group's leader, alive while anything the command put in the background
        // still runs, so the group always has a leader with a real start time to kill by. A newline,
        // not `;`, so a command ending in a comment still reaches it.
        const child = d.spawn('sh', ['-c', `${a.command}\nwait`], { env: { ...a.env, ASTERA_APP_CHROMIUM_FLAGS: MAC_BACKGROUND_FLAGS }, cwd: a.cwd })
        if (child.pid === undefined) throw new Error(`launch: sh could not start (${child.stderrTail() || 'no reason given'})`)
        const cpid = child.pid
        // From ps, never the clock: the leftover sweep compares this with the kernel's own record. When
        // the read itself fails the fresh group is ended here, since nothing else will know to.
        const at = await d.startTime(cpid).catch(async (err: unknown) => {
          await endQuietly(cpid)
          throw err
        })
        if (at === null) {
          // Gone already (it exited at once): 0 matches no live process, so a later kill or sweep
          // never reaches a reused pid.
          d.log(`desktop ${name}: pid ${cpid} exited before its start time could be read; recorded with start time 0`)
          return { pid: cpid, startedAt: 0 }
        }
        if (closed) {
          await endQuietly(cpid)
          throw closedError()
        }
        launched.set(cpid, at)
        return { pid: cpid, startedAt: at }
      }

      return {
        name,
        pid: null,
        startedAt: 0,
        alive: () => !closed,
        // No helper process, so nothing ever ends by itself.
        onExit: () => {},
        launch: async (a): Promise<DeskLaunched> => {
          if (closed) throw closedError()
          const b = bundleCommand(a.command)
          return b ? openBundle(b, a) : launchCommand(a)
        },
        kill,
        windows: async () => {
          throw new Error(macRefusal('windows'))
        },
        shot: async () => {
          throw new Error(macRefusal('windowShot'))
        },
        keys: async () => {
          throw new Error(macRefusal('keys'))
        },
        close: async () => {
          closed = true
          stop.abort()
          for (const [p, at] of [...launched]) await kill(p, at).catch((err) => d.log(`desktop ${name}: pid ${p} could not be ended: ${messageOf(err)}`))
        }
      }
    }
  }
}

export function realMacDeskDeps(a: { log(m: string): void }): MacDeskDeps {
  return {
    spawn: spawnDetached,
    exec: execText,
    startTime: async (pid) => (await macStartTimes([pid], execText)).get(pid) ?? null,
    killGroup: (pid) => killGroup(pid),
    sleep: (ms, signal) =>
      new Promise((r) => {
        if (signal?.aborted) return r()
        // One signal serves every poll of a desk, so each sleep takes its listener off again.
        const onAbort = (): void => {
          clearTimeout(t)
          r()
        }
        const t = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          r()
        }, ms)
        // Unref'd: a launch poll must never be the reason the Host's own process stays up.
        t.unref?.()
        signal?.addEventListener('abort', onAbort, { once: true })
      }),
    now: Date.now,
    log: a.log
  }
}
