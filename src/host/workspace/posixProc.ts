// The process tools the Linux and macOS desks and the leftover sweep share (Linux and macOS design,
// kill; R10): a process's start time read from the kernel's own record, the same way when a launch is
// recorded and when it is checked; a process group ended with SIGTERM, then SIGKILL after 2 s; a
// detached spawn that makes the launched process a group leader; and a tool run to its end.
import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { DESK_REQUEST_MS } from '../../core/workspace/protocol'

export const GROUP_KILL_GRACE_MS = 2_000
const GROUP_POLL_MS = 100
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Epoch ms from a /proc/<pid>/stat line: field 22 is clock ticks since boot, and btime is the boot
 *  time in seconds. The command name (field 2) may hold spaces and parentheses, so the fields are
 *  counted from the last ')' (Review Focus 2). */
export function procStartMs(stat: string, btimeSec: number, ticksPerSec: number): number | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  // The first field after the name is field 3, so field 22 is the 20th.
  const ticks = Number(stat.slice(close + 1).trim().split(/\s+/)[19])
  if (!Number.isFinite(ticks) || ticks < 0) return null
  return btimeSec * 1000 + Math.round((ticks * 1000) / ticksPerSec)
}

export function btimeOf(procStat: string): number | null {
  const m = /^btime\s+(\d+)\s*$/m.exec(procStat)
  return m ? Number(m[1]) : null
}

/** `ps -o lstart=` under LC_ALL=C: "Sat Sep  7 10:11:12 2026", local time, whole seconds. */
export function parseLstart(text: string): number | null {
  const m = /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim())
  if (!m) return null
  const month = MONTHS.indexOf(m[1])
  if (month < 0) return null
  return new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime()
}

export type ExecText = (file: string, args: string[]) => Promise<string>

/** Runs a program to its end for its text; a failure carries its exit `code` and its `stdout`. */
export const execText: ExecText = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 30_000 }, (err, stdout) => (err ? reject(Object.assign(err, { stdout: String(stdout) })) : resolve(String(stdout))))
  })

export interface LinuxProcFs {
  readFile(p: string): Promise<string>
  ticksPerSec(): Promise<number>
}

export function realLinuxProcFs(exec: ExecText): LinuxProcFs {
  let hz: Promise<number> | null = null
  return {
    readFile: (p) => fs.readFile(p, 'utf8'),
    ticksPerSec: () =>
      (hz ??= exec('getconf', ['CLK_TCK']).then(
        (t) => {
          const n = Number(t.trim())
          return Number.isSafeInteger(n) && n > 0 ? n : 100
        },
        () => 100
      ))
  }
}

/** Each live pid's start time, epoch ms, from /proc. A pid with no stat file is gone and left out. */
export async function linuxStartTimes(pids: number[], d: LinuxProcFs): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (pids.length === 0) return out
  const btime = btimeOf(await d.readFile('/proc/stat'))
  if (btime === null) throw new Error('/proc/stat has no btime line')
  const hz = await d.ticksPerSec()
  await Promise.all(
    pids.map(async (pid) => {
      const line = await d.readFile(`/proc/${pid}/stat`).catch(() => null)
      const ms = line === null ? null : procStartMs(line, btime, hz)
      if (ms !== null) out.set(pid, ms)
    })
  )
  return out
}

/** Each live pid's start time, epoch ms, from one `ps` call. LC_ALL=C, so the month names are the
 *  ones parseLstart reads whatever the person's locale (Review Focus 5). ps exits 1 when one of the
 *  pids is gone, and still prints the rest. */
export async function macStartTimes(pids: number[], exec: ExecText): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (pids.length === 0) return out
  const text = await exec('env', ['LC_ALL=C', 'ps', '-o', 'pid=,lstart=', '-p', pids.join(',')]).catch((err: { stdout?: unknown }) =>
    String(err?.stdout ?? '')
  )
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!m) continue
    const ms = parseLstart(m[2])
    if (ms !== null) out.set(Number(m[1]), ms)
  }
  return out
}

export interface Signals {
  /** process.kill: throws with code ESRCH when nothing has that pid or group. */
  kill(pid: number, sig: NodeJS.Signals | 0): void
  sleep(ms: number): Promise<void>
}

export const realSignals: Signals = {
  kill: (pid, sig) => {
    process.kill(pid, sig)
  },
  sleep: (ms) =>
    new Promise((r) => {
      const t = setTimeout(r, ms)
      t.unref?.()
    })
}

const isGone = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 'ESRCH'

/** Ends pid's process group (a detached launch made it the leader), or pid alone when it leads none:
 *  SIGTERM, a poll every 100 ms, and SIGKILL once `graceMs` has passed. A group already gone is not a
 *  failure. Never pid 0 or 1, and never a negative number: those would reach the Host's own group or
 *  every process the user owns (Review Focus 3).
 *
 *  Not `endChild` (scriptWorker.ts): that one kills a live `ChildProcess` it still owns, synchronously,
 *  with SIGKILL at once and no grace, because the script child must die now (P14). This one gets only
 *  a recorded pid, possibly after a Host restart, and follows the spec's grace period instead. */
export async function killGroup(pid: number, s: Signals = realSignals, graceMs: number = GROUP_KILL_GRACE_MS): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`not a pid: ${pid}`)
  let target = -pid
  try {
    s.kill(target, 'SIGTERM')
  } catch (err) {
    if (!isGone(err)) throw err
    target = pid
    try {
      s.kill(target, 'SIGTERM')
    } catch (again) {
      if (isGone(again)) return
      throw again
    }
  }
  const alive = (): boolean => {
    try {
      s.kill(target, 0)
      return true
    } catch (err) {
      if (isGone(err)) return false
      throw err
    }
  }
  for (let waited = 0; waited < graceMs; waited += GROUP_POLL_MS) {
    await s.sleep(GROUP_POLL_MS)
    if (!alive()) return
  }
  try {
    s.kill(target, 'SIGKILL')
  } catch (err) {
    if (!isGone(err)) throw err
  }
}

export interface SpawnedProc {
  readonly pid: number | undefined
  /** Once, however it ended: an exit, a signal, a failed start. A listener added after the end is
   *  called at once. */
  onExit(cb: (why: string) => void): void
  /** The last of its stderr, one line, when it was spawned with `stderr: true`. */
  stderrTail(): string
  kill(sig?: NodeJS.Signals): void
}

export type SpawnDetached = (file: string, args: string[], o: { env: Record<string, string>; cwd?: string; stderr?: boolean }) => SpawnedProc

/** A process in a new process group (so the group can be ended as one), stdin and stdout ignored,
 *  and not holding the Host's event loop open. */
export const spawnDetached: SpawnDetached = (file, args, o) => {
  const child = spawn(file, args, { env: o.env, cwd: o.cwd, detached: true, stdio: ['ignore', 'ignore', o.stderr ? 'pipe' : 'ignore'] })
  const cbs: Array<(why: string) => void> = []
  let tail = ''
  let ended: string | null = null
  const end = (why: string): void => {
    if (ended !== null) return
    ended = why
    for (const cb of cbs) cb(why)
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8')
    // Read to the end: a process whose stderr pipe closes dies of SIGPIPE on its next write.
    child.stderr.on('data', (c: string) => {
      tail = (tail + c).slice(-2_000)
    })
    ;(child.stderr as unknown as { unref?(): void }).unref?.()
  }
  // R3: a spawn that fails emits 'error', which is an exit here, never an unhandled event.
  child.on('error', (err) => end(`${file} could not start: ${err.message}`))
  child.on('exit', (code, signal) => end(`exited ${String(signal ?? code)}`))
  child.unref()
  return {
    get pid() {
      return child.pid
    },
    onExit: (cb) => {
      if (ended !== null) cb(ended)
      else cbs.push(cb)
    },
    stderrTail: () => tail.trim().replace(/\s+/g, ' '),
    kill: (sig = 'SIGTERM') => {
      if (ended !== null) return
      try {
        child.kill(sig)
      } catch {
        /* already gone; the exit reports it */
      }
    }
  }
}

export type RunTool = (file: string, args: string[], env: Record<string, string>) => Promise<Buffer>

/** Runs a desk tool (xdotool, import) to its end for its stdout bytes, within the desk request limit.
 *  A failure carries its exit `code` and its `stderr`. */
export const runTool: RunTool = (file, args, env) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: DESK_REQUEST_MS }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr).trim() }))
      else resolve(stdout)
    })
  })
