// Asynchronous, time-limited file probes for the spawn path.
//
// A synchronous `existsSync` on a path that sits on an offline mapped drive or a dead UNC share does
// not fail fast: Windows waits for the SMB redirector, which can take 20 to 60 seconds, and for that
// whole time the thread that asked is frozen. On the spawn path that thread is the Electron main
// process (every window stops) or the Host's only thread (every pty it holds stops). PATH is the usual
// culprit: findGitBash and the terminal's shell lookup look into every PATH entry, and one entry on a
// drive that is not connected today is enough.
//
// So a probe here is async and is cut PROBE_TIMEOUT_MS after **its fs call starts**, then counts as
// `timeout` (absent, for a PATH lookup). But an async fs call still runs on a libuv threadpool thread,
// and a hung one keeps that thread for as long as SMB takes to give up. The pool has 4 threads by
// default, and every async fs call in the process shares them — so the rules below are about threads:
//
// - **At most PROBE_CONCURRENCY (2) PATH probe calls exist at once, stuck ones included.** A call that
//   timed out has answered its caller but still holds its thread, so it keeps counting until it really
//   settles. Two threads always stay free for the session folder's probe and the rest of the process.
// - **At most one PATH probe call per root** (drive or UNC share, see rootOf). A second probe on a root
//   waits for the first; if the first times out, the waiters answer `timeout` at once, without a call.
// - **Once PROBE_CONCURRENCY calls are stuck, every PATH probe answers `timeout` without a call** until
//   one settles. So the stuck threads never pass 2, however many dead roots PATH holds. A healthy path
//   is then reported absent for a while; the caches keep such answers for PROBE_DEGRADED_TTL_MS only.
// - **The session folder's probe (`skipQueue`) is issued at once**, outside the cap and the per-root
//   rule, so a local folder is never judged unreachable because PATH probes hang. It answers `timeout`
//   without a call only when its own root already has a stuck call — a folder on a drive known to hang
//   is not reachable, and saying so at once is the point. One such call per spawn attempt at most.
// - **A stuck call is let go after PROBE_STUCK_CEILING_MS** (a POSIX hard mount may never settle): it
//   stops counting, its root may be probed again, and that is logged once for the call.
//
// UV_THREADPOOL_SIZE is left at libuv's default (4). It only takes effect if set before the pool's
// first use, and an entry module cannot guarantee that from its own code: its imports are evaluated
// before its body, and Electron's main process may touch the pool before app code runs. A value set
// too late is silently ignored, which would read as a fix without being one.
//
// Pure apart from the default `access`, which is `fs.promises.access`; everything else is injected so
// the timing can be tested with fake timers.
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** How long one probe's fs call may take before it counts as absent. */
export const PROBE_TIMEOUT_MS = 1_500
/** How many PATH probe calls may exist at once, per process — stuck ones included. Half the default
 *  libuv threadpool, so the other half is always free. */
export const PROBE_CONCURRENCY = 2
/** How long a result computed from a PATH string is trusted before it is computed again. */
export const PROBE_CACHE_TTL_MS = 5 * 60_000
/** How long a result is trusted when a timeout went into it: short, since the drive may come back. */
export const PROBE_DEGRADED_TTL_MS = 10_000
/** After this long a stuck call stops counting against the cap, and its root may be probed again. */
export const PROBE_STUCK_CEILING_MS = 2 * 60_000
/** How many timed-out paths a prober remembers having logged; the oldest is forgotten past this. */
export const LOGGED_PATHS_MAX = 256

/** `timeout` is reported apart from `absent` so a caller that must not guess (the session's cwd) can
 *  say "not reachable" instead of "missing"; every PATH lookup treats it as absent. */
export type ProbeResult = 'present' | 'absent' | 'timeout'
export type Probe = (p: string) => Promise<ProbeResult>

/**
 * The unit a dead network location takes down together, as one key per location: the drive (`z:\`)
 * or the UNC share (`\\server\share\`) for a Windows path — every spelling folded to one (`Z:`, `z:/`,
 * `\\?\Z:\`, `//server/share`, `\\?\UNC\server\share`, any case) — and the first two segments for a
 * POSIX one (`/mnt/nas`), where a hung mount sits below `/`, not at it.
 */
export function rootOf(p: string): string {
  let s = p.replace(/\//g, '\\')
  if (/^\\\\[?.]\\/.test(s)) {
    s = s.slice(4)
    if (/^unc\\/i.test(s)) s = '\\\\' + s.slice(4)
  }
  const drive = /^([a-z]):/i.exec(s)
  if (drive) return `${drive[1].toLowerCase()}:\\`
  const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(s)
  if (unc) return `\\\\${unc[1]}\\${unc[2]}\\`.toLowerCase()
  if (/^\\\\[^\\]+\\?$/.test(s)) return s.replace(/\\?$/, '\\').toLowerCase()
  const segs = p.split('/').filter((x) => x !== '')
  return '/' + segs.slice(0, 2).join('/')
}

interface ProbeJob {
  p: string
  access: (p: string) => Promise<void>
  timeoutMs: number
  skipQueue: boolean
  /** Told why a probe answered timeout; the prober logs each path once. */
  note(p: string, why: string): void
  /** Told when a stuck call is let go at the ceiling — once per call. */
  log(m: string): void
}

interface Waiter {
  job: ProbeJob
  root: string
  resolve: (r: ProbeResult) => void
}

/** What every prober of one process shares: the PATH call cap, the per-root rule, the stuck calls. */
export class ProbePool {
  /** PATH calls that have not settled (nor reached the ceiling), stuck ones included. */
  private pathCalls = 0
  /** Of those, the ones that already timed out. */
  private pathStuck = 0
  /** Roots with a PATH call that has not settled. */
  private busy = new Set<string>()
  /** root → calls on it (PATH or cwd) that timed out and have not settled. */
  private stuck = new Map<string, number>()
  private queue: Waiter[] = []

  constructor(
    private max: number = PROBE_CONCURRENCY,
    private ceilingMs: number = PROBE_STUCK_CEILING_MS
  ) {}

  submit(job: ProbeJob): Promise<ProbeResult> {
    return new Promise<ProbeResult>((resolve) => {
      const root = rootOf(job.p)
      if (this.stuck.has(root)) {
        job.note(job.p, `${root} has a call that gave no answer yet`)
        resolve('timeout')
        return
      }
      if (job.skipQueue) {
        this.start(job, root, resolve, false)
        return
      }
      this.queue.push({ job, root, resolve })
      this.pump()
    })
  }

  /** Starts, refuses or keeps each waiter, in order. Runs whenever a call settles or times out. */
  private pump(): void {
    for (let i = 0; i < this.queue.length; ) {
      const w = this.queue[i]
      let refuse: string | null = null
      if (this.stuck.has(w.root)) refuse = `${w.root} has a call that gave no answer yet`
      else if (this.pathStuck >= this.max) refuse = `${this.pathStuck} probe calls are stuck, no more are made until one ends`
      if (refuse !== null) {
        this.queue.splice(i, 1)
        w.job.note(w.job.p, refuse)
        w.resolve('timeout')
        continue
      }
      if (!this.busy.has(w.root) && this.pathCalls < this.max) {
        this.queue.splice(i, 1)
        this.start(w.job, w.root, w.resolve, true)
        continue
      }
      i++
    }
  }

  private start(job: ProbeJob, root: string, resolve: (r: ProbeResult) => void, counted: boolean): void {
    if (counted) {
      this.pathCalls++
      this.busy.add(root)
    }
    let answered = false
    let released = false
    let isStuck = false
    let ceiling: ReturnType<typeof setTimeout> | null = null
    /** The call no longer counts: it settled, or it reached the ceiling. Only ever once. */
    const release = (): void => {
      if (released) return
      released = true
      if (ceiling) clearTimeout(ceiling)
      if (isStuck) {
        const n = (this.stuck.get(root) ?? 1) - 1
        if (n <= 0) this.stuck.delete(root)
        else this.stuck.set(root, n)
        if (counted) this.pathStuck--
      }
      if (counted) {
        this.pathCalls--
        this.busy.delete(root)
      }
      this.pump()
    }
    const call = Promise.resolve().then(() => job.access(job.p))
    const timer = setTimeout(() => {
      if (answered) return
      answered = true
      isStuck = true
      this.stuck.set(root, (this.stuck.get(root) ?? 0) + 1)
      if (counted) this.pathStuck++
      job.note(job.p, `no answer within ${job.timeoutMs}ms`)
      resolve('timeout')
      ceiling = setTimeout(() => {
        try {
          job.log(`path probe: still no answer after ${this.ceilingMs}ms, no longer counted (stuck-call ceiling): ${job.p}`)
        } catch {
          /* a log that throws must not keep the call from being let go */
        }
        release()
      }, this.ceilingMs)
      ceiling.unref?.()
      this.pump()
    }, job.timeoutMs)
    const settle = (r: ProbeResult): void => {
      if (!answered) {
        answered = true
        clearTimeout(timer)
        resolve(r)
      }
      release()
    }
    call.then(
      () => settle('present'),
      () => settle('absent')
    )
  }
}

export function createProbePool(max: number = PROBE_CONCURRENCY, ceilingMs: number = PROBE_STUCK_CEILING_MS): ProbePool {
  return new ProbePool(max, ceilingMs)
}

const sharedPool = createProbePool()

let sink: (m: string) => void = (m) => console.warn(m)
/** Where the default probes and the spawn path's warnings go. Each entry point (the app's core, the
 *  Host) points it at its own log file at start; until then it is the console. */
export function setProbeLog(log: (m: string) => void): void {
  sink = log
}
/** Writes to the current probe log. Never throws. */
export function probeLog(m: string): void {
  try {
    sink(m)
  } catch {
    /* a log that cannot be written blocks nothing */
  }
}

export interface ProberDeps {
  /** Resolves when the path exists, rejects when it does not. Defaults to `fs.promises.access`. */
  access?: (p: string) => Promise<void>
  timeoutMs?: number
  pool?: ProbePool
  /** Told once per path that answered timeout (at most LOGGED_PATHS_MAX remembered), and once per
   *  call let go at the ceiling. Defaults to probeLog. */
  log?: (m: string) => void
  /** Issue the call at once, outside the PATH cap and the per-root rule — the session folder's check. */
  skipQueue?: boolean
}

export type Prober = Probe & {
  /** How many paths the logged-once memory holds (bounded by LOGGED_PATHS_MAX). */
  loggedCount(): number
}

/**
 * A probe: `present`, `absent`, or `timeout` when the call did not come back within the limit or was
 * not made (see the rules at the top of this file). It never rejects, and a call that answers after
 * its timeout is swallowed — nothing is left unhandled.
 */
export function createProber(d: ProberDeps = {}): Prober {
  const access = d.access ?? ((p: string) => fs.access(p))
  const timeoutMs = d.timeoutMs ?? PROBE_TIMEOUT_MS
  const pool = d.pool ?? sharedPool
  const log = d.log ?? probeLog
  const skipQueue = d.skipQueue === true
  const logged = new Set<string>()
  const safeLog = (m: string): void => {
    try {
      log(m)
    } catch {
      /* a log that throws must not keep the probe from answering */
    }
  }
  const note = (p: string, why: string): void => {
    if (logged.has(p)) return
    logged.add(p)
    if (logged.size > LOGGED_PATHS_MAX) logged.delete(logged.values().next().value as string)
    safeLog(`path probe: ${why}, treated as absent: ${p}`)
  }
  const probe = (p: string): Promise<ProbeResult> => pool.submit({ p, access, timeoutMs, skipQueue, note, log: safeLog })
  return Object.assign(probe, { loggedCount: () => logged.size })
}

let defaultPathProber: Prober | null = null
let defaultCwdProber: Prober | null = null
/** The process-wide probe for PATH lookups: `fs.promises.access`, the shared pool, the probe log. */
export function defaultProbe(p: string): Promise<ProbeResult> {
  defaultPathProber ??= createProber()
  return defaultPathProber(p)
}
/** The process-wide probe for a session folder: the same, but it never waits for a slot. */
export function defaultCwdProbe(p: string): Promise<ProbeResult> {
  defaultCwdProber ??= createProber({ skipQueue: true })
  return defaultCwdProber(p)
}

/**
 * Refuses a session folder that is not there (`CWD_MISSING`) or that did not answer within the probe
 * limit (`CWD_UNREACHABLE: folder not reachable: <path>`) — an offline mapped drive or UNC share,
 * which a sync check would have waited 20 to 60 s on. `missing` lets a caller keep its own wording.
 */
export async function checkCwd(cwd: string, probe: Probe = defaultCwdProbe, missing = `CWD_MISSING: ${cwd}`): Promise<void> {
  const r = await probe(cwd)
  if (r === 'absent') throw new Error(missing)
  if (r === 'timeout') throw new Error(`CWD_UNREACHABLE: folder not reachable: ${cwd}`)
}

/**
 * Whether `file` sits in any directory of `pathValue`, and whether any directory timed out (a
 * caller caches such an answer only briefly). The directories are probed together; the probe's own
 * pool bounds how many at once, and one that times out counts as not holding it.
 */
export async function findOnPath(
  pathValue: string,
  file: string,
  probe: Probe,
  delimiter: string = path.delimiter,
  join: (...parts: string[]) => string = path.join
): Promise<{ found: boolean; timedOut: boolean }> {
  const dirs = pathValue.split(delimiter).filter((d) => d !== '')
  const results = await Promise.all(dirs.map((dir) => probe(join(dir, file))))
  return { found: results.includes('present'), timedOut: results.includes('timeout') }
}

interface Entry<V> {
  at: number
  ttl: number
  promise: Promise<V>
  settled: boolean
  value?: V
}

/**
 * Results worked out from one PATH string, kept per process. An entry is trusted for `ttlMs`, or for
 * what `ttlOf` says about its value (a result a timeout went into: PROBE_DEGRADED_TTL_MS); a new PATH
 * string drops every entry, since each was worked out from the old one. Callers that ask while a
 * computation runs share it, and a computation that fails is not kept.
 */
export class PathKeyedCache<V> {
  private pathValue: string | null = null
  private entries = new Map<string, Entry<V>>()

  constructor(
    private ttlMs: number = PROBE_CACHE_TTL_MS,
    private now: () => number = Date.now
  ) {}

  private fresh(pathValue: string, key: string): Entry<V> | undefined {
    if (pathValue !== this.pathValue) return undefined
    const e = this.entries.get(key)
    if (!e) return undefined
    if (this.now() - e.at >= e.ttl) {
      this.entries.delete(key)
      return undefined
    }
    return e
  }

  get(pathValue: string, key: string, compute: () => Promise<V>, ttlOf?: (v: V) => number): Promise<V> {
    const hit = this.fresh(pathValue, key)
    if (hit) return hit.promise
    if (pathValue !== this.pathValue) {
      this.pathValue = pathValue
      this.entries.clear()
    }
    const entry: Entry<V> = { at: this.now(), ttl: this.ttlMs, promise: Promise.resolve().then(compute), settled: false }
    this.entries.set(key, entry)
    entry.promise.then(
      (v) => {
        entry.settled = true
        entry.value = v
        if (ttlOf) entry.ttl = Math.min(this.ttlMs, ttlOf(v))
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key)
      }
    )
    return entry.promise
  }

  /** The settled, fresh value for this PATH string and key, or undefined. */
  peek(pathValue: string, key: string): V | undefined {
    const e = this.fresh(pathValue, key)
    return e?.settled ? e.value : undefined
  }
}
