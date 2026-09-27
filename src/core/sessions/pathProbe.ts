// Asynchronous, time-limited file probes for the spawn path, and for every other probe lane.
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
// default, and every async fs call in the process shares them — so the rules below are about threads.
//
// **The budget is process-wide and shared by every lane** (ProbeBudget): the PATH pool, the session
// folder's lane (`skipQueue`, also the existence checks of worktrees/create.ts), and the worktree
// presence checks (the sweep's and the action lane's, worktrees/presence.ts). Each lane has its own
// pool for its own rules, but every pool asks the one budget before it makes a call. **A probe is an
// existence check only** (lstat, access). Work that changes the disk (mkdir, rm, rmdir, a copy, the
// link walk before a removal) can be slow for good reasons and must never mark a root stuck, so it runs
// outside the budget with its own deadline (worktrees/fsWork.ts). The rules the budget keeps:
//
// - **One call per root at a time, across all lanes.** A probe on a root with a call in flight in any
//   lane waits for it; if that call timed out, the waiter answers `timeout` at once, without a call.
//   So a dead root holds at most one stuck call in the whole process.
// - **A root with a stuck call is stuck for every lane.** Any probe on it answers `timeout` (a
//   presence check: `refused`) without a call until the call settles or reaches the ceiling.
// - **At most PROBE_STUCK_MAX (3) stuck calls in the whole process.** Calls on roots not known to be
//   alive (none answered within PROBE_FRESH_MS, 5 minutes) and the stuck ones never pass 3 together; a
//   fourth such call waits for one of them. Once 3 calls are stuck, a new call is made only on a root
//   that answered within PROBE_FRESH_MS — a local drive such as C: keeps working — and every other root
//   answers `timeout` without a call. So at least one of libuv's
//   4 threads stays free for roots known to be alive. (A root that answered a moment ago and then dies
//   can still add one stuck call past 3, once: its timeout forgets that it answered, so it is risky
//   from then on. That is the price of keeping C: answered.)
// - **Within that, the PATH pool keeps its own caps.** At most PROBE_CONCURRENCY (2) PATH probe calls
//   exist at once, stuck ones included; once 2 PATH calls are stuck, every PATH probe answers `timeout`
//   without a call until one settles; and at most one PATH call per root. A healthy path may then be
//   reported absent for a while; the caches keep such answers for PROBE_DEGRADED_TTL_MS only.
// - **The session folder's probe (`skipQueue`) does not wait behind PATH probes**: it is outside the
//   PATH cap, so a local folder is never judged unreachable because PATH probes hang. Several prepares
//   asking about one offline folder within the same 1.5 s share one call.
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
/** How many stuck calls the whole process allows, every lane together (see the header). */
export const PROBE_STUCK_MAX = 3
/** Once PROBE_STUCK_MAX calls are stuck, a root that answered within this long may still be probed. */
export const PROBE_FRESH_MS = 5 * 60_000
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

/** One call on a root, admitted by the budget. Each method acts once; a ticket from before a reset
 *  touches nothing. */
export interface ProbeTicket {
  /** The call answered (present or absent) before its timeout: the root is alive. */
  answered(): void
  /** The call gave no answer within its timeout: the root is stuck, for every lane. */
  timedOut(): void
  /** A stuck call settled, or reached the ceiling: it no longer counts. */
  release(): void
}

/**
 * The process-wide budget every probe lane shares (see the header): one call per root at a time, a
 * stuck root is stuck for everyone, and at most PROBE_STUCK_MAX stuck calls, past which only roots
 * that answered recently are probed.
 */
export class ProbeBudget {
  /** root → the call in flight on it; resolves true when it answered, false when it timed out. */
  private inflight = new Map<string, Promise<boolean>>()
  /** Of those, the calls on roots not known to be alive (none answered within PROBE_FRESH_MS). */
  private risky = new Map<string, Promise<boolean>>()
  /** root → stuck calls on it (one, by the rule above; a count so a ceiling release stays exact). */
  private stuck = new Map<string, number>()
  private stuckTotal = 0
  /** root → when a call on it last answered in time. */
  private answeredAt = new Map<string, number>()
  private generation = 0

  constructor(
    private maxStuck: number = PROBE_STUCK_MAX,
    private freshMs: number = PROBE_FRESH_MS,
    private now: () => number = Date.now
  ) {}

  stuckCount(): number {
    return this.stuckTotal
  }

  isStuck(root: string): boolean {
    return this.stuck.has(root)
  }

  /** Forgets everything (tests). Calls admitted before it touch nothing after. */
  reset(): void {
    this.generation++
    this.inflight.clear()
    this.risky.clear()
    this.stuck.clear()
    this.stuckTotal = 0
    this.answeredAt.clear()
  }

  /** A ticket for one call on `root`, or why none is given. Waits while another lane's call on the
   *  root is in flight. Never rejects. */
  async enter(root: string): Promise<ProbeTicket | string> {
    for (;;) {
      if (this.stuck.has(root)) return `${root} has a call that gave no answer yet`
      const current = this.inflight.get(root)
      if (current) {
        if (!(await current)) return `${root} gave no answer to another probe`
        continue
      }
      const at = this.answeredAt.get(root)
      const fresh = at !== undefined && this.now() - at < this.freshMs
      if (!fresh) {
        // A root not known to be alive may become one more stuck call. Those, the stuck ones and the
        // ones in flight on such roots, never pass PROBE_STUCK_MAX together.
        if (this.stuckTotal >= this.maxStuck)
          return `${this.stuckTotal} probe calls are stuck, only a root that answered recently is probed until one ends`
        if (this.stuckTotal + this.risky.size >= this.maxStuck) {
          await Promise.race([...this.risky.values()])
          continue
        }
      }
      return this.admit(root, !fresh)
    }
  }

  private admit(root: string, risky: boolean): ProbeTicket {
    const gen = this.generation
    let settle!: (answered: boolean) => void
    const entry = new Promise<boolean>((r) => (settle = r))
    this.inflight.set(root, entry)
    if (risky) this.risky.set(root, entry)
    let state: 'flying' | 'answered' | 'stuck' | 'released' = 'flying'
    const leave = (answered: boolean): void => {
      if (gen === this.generation && this.inflight.get(root) === entry) this.inflight.delete(root)
      if (gen === this.generation && this.risky.get(root) === entry) this.risky.delete(root)
      settle(answered)
    }
    return {
      answered: () => {
        if (state !== 'flying') return
        state = 'answered'
        if (gen === this.generation) this.answeredAt.set(root, this.now())
        leave(true)
      },
      timedOut: () => {
        if (state !== 'flying') return
        state = 'stuck'
        if (gen === this.generation) {
          this.stuck.set(root, (this.stuck.get(root) ?? 0) + 1)
          this.stuckTotal++
          // It answered before, and has stopped: it is no longer known to be alive, so once this call
          // lets go its next call counts as risky again, inside PROBE_STUCK_MAX.
          this.answeredAt.delete(root)
        }
        leave(false)
      },
      release: () => {
        if (state !== 'stuck') return
        state = 'released'
        if (gen !== this.generation) return
        const n = (this.stuck.get(root) ?? 1) - 1
        if (n <= 0) this.stuck.delete(root)
        else this.stuck.set(root, n)
        this.stuckTotal = Math.max(0, this.stuckTotal - 1)
      }
    }
  }
}

const sharedBudget = new ProbeBudget()
/** The one budget every lane in this process shares. */
export function processProbeBudget(): ProbeBudget {
  return sharedBudget
}

/** What every prober of one process shares: the PATH call cap, the per-root rule, the stuck calls. */
export class ProbePool {
  /** PATH calls that have not settled (nor reached the ceiling), stuck ones included. */
  private pathCalls = 0
  /** Of those, the ones that already timed out. */
  private pathStuck = 0
  /** Roots with a PATH call that has not settled. */
  private busy = new Set<string>()
  private queue: Waiter[] = []
  /** root → the session-folder call in flight on it, and the answer it will give. */
  private cwdCalls = new Map<string, { p: string; answer: Promise<ProbeResult> }>()

  constructor(
    private max: number = PROBE_CONCURRENCY,
    private ceilingMs: number = PROBE_STUCK_CEILING_MS,
    private budget: ProbeBudget = sharedBudget
  ) {}

  submit(job: ProbeJob): Promise<ProbeResult> {
    return new Promise<ProbeResult>((resolve) => {
      const root = rootOf(job.p)
      if (this.budget.isStuck(root)) {
        job.note(job.p, `${root} has a call that gave no answer yet`)
        resolve('timeout')
        return
      }
      if (job.skipQueue) {
        this.startCwd(job, root, resolve)
        return
      }
      this.queue.push({ job, root, resolve })
      this.pump()
    })
  }

  /** A session-folder probe: one call per root at a time (see the rules at the top of this file). */
  private startCwd(job: ProbeJob, root: string, resolve: (r: ProbeResult) => void): void {
    if (this.budget.isStuck(root)) {
      job.note(job.p, `${root} has a call that gave no answer yet`)
      resolve('timeout')
      return
    }
    const current = this.cwdCalls.get(root)
    if (current) {
      void current.answer.then((r) => {
        if (current.p === job.p) resolve(r)
        else if (r === 'timeout') {
          job.note(job.p, `${root} gave no answer to ${current.p}`)
          resolve('timeout')
        } else this.startCwd(job, root, resolve)
      })
      return
    }
    let answered!: (r: ProbeResult) => void
    const entry = { p: job.p, answer: new Promise<ProbeResult>((res) => (answered = res)) }
    this.cwdCalls.set(root, entry)
    this.start(
      job,
      root,
      (r) => {
        // Taken down at the answer (or the timeout): after a timeout the budget refuses the root.
        if (this.cwdCalls.get(root) === entry) this.cwdCalls.delete(root)
        answered(r)
        resolve(r)
      },
      false
    )
  }

  /** Starts, refuses or keeps each waiter, in order. Runs whenever a call settles or times out. */
  private pump(): void {
    for (let i = 0; i < this.queue.length; ) {
      const w = this.queue[i]
      let refuse: string | null = null
      if (this.budget.isStuck(w.root)) refuse = `${w.root} has a call that gave no answer yet`
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

  /** Asks the budget for the call, then makes it — or answers `timeout` without one. */
  private start(job: ProbeJob, root: string, resolve: (r: ProbeResult) => void, counted: boolean): void {
    if (counted) {
      this.pathCalls++
      this.busy.add(root)
    }
    const refuse = (why: string): void => {
      job.note(job.p, why)
      resolve('timeout')
      if (counted) {
        this.pathCalls--
        this.busy.delete(root)
      }
      this.pump()
    }
    this.budget.enter(root).then(
      (t) => (typeof t === 'string' ? refuse(t) : this.call(job, root, resolve, counted, t)),
      (err: unknown) => refuse(`the probe budget failed: ${String(err)}`)
    )
  }

  private call(job: ProbeJob, root: string, resolve: (r: ProbeResult) => void, counted: boolean, ticket: ProbeTicket): void {
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
        ticket.release()
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
      ticket.timedOut()
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
        ticket.answered()
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

/** A lane's pool. Every pool asks the process-wide budget unless a test hands it its own. */
export function createProbePool(
  max: number = PROBE_CONCURRENCY,
  ceilingMs: number = PROBE_STUCK_CEILING_MS,
  budget: ProbeBudget = sharedBudget
): ProbePool {
  return new ProbePool(max, ceilingMs, budget)
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

/** The prefix of gateRoot's refusal. A caller that words errors for a person looks for it. */
export const ROOT_UNREACHABLE = 'ROOT_UNREACHABLE'

/**
 * **One budgeted look at a folder before an operation issues fs calls under it that the budget does
 * not see** — a tree walk, a copy, a removal, a handful of existence checks. Those calls run on the
 * libuv threadpool like any other, and on a dead share every one of them can hold a thread for as long
 * as SMB takes to give up, so four of them are enough to stop every async fs call in the process.
 *
 * So the operation asks here first, once per root it is about to touch: the session folder's lane
 * (`defaultCwdProbe`), inside the process-wide budget. A root the budget already holds as stuck is
 * refused at once without a call; a probe that gets no answer within PROBE_TIMEOUT_MS is refused too.
 * Either way this throws `ROOT_UNREACHABLE: folder not reachable: <p>` and the operation issues
 * nothing more. `present` and `absent` are handed back: a missing folder is the operation's own
 * business (it fails with its own ENOENT, as before). Not every per-file call goes through here —
 * one gate per operation per root is enough, since a root that just answered is alive.
 */
export async function gateRoot(p: string, probe: Probe = defaultCwdProbe): Promise<'present' | 'absent'> {
  const r = await probe(p)
  if (r === 'timeout') throw new Error(`${ROOT_UNREACHABLE}: folder not reachable: ${p}`)
  return r
}

/** Whether `err` is gateRoot's refusal. */
export function isRootUnreachable(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  // Not WORKTREE_ROOT_UNREACHABLE, which ends the same way and means something else.
  return /(^|[^A-Z_])ROOT_UNREACHABLE:/.test(m)
}

/**
 * Whether `file` sits in any directory of `pathValue`, and whether any directory timed out (a
 * caller caches such an answer only briefly). The directories are probed together; the probe's own
 * pool bounds how many at once, and one that times out counts as not holding it.
 *
 * `at` is where it sits: the full path in the first directory, in PATH order, that answered present.
 * A caller that spawns the file hands over `at`, never the bare name, because a spawner given a bare
 * name walks PATH again itself, synchronously (node-pty's conpty.cc does), and one dead entry then
 * freezes the spawning thread.
 */
export async function findOnPath(
  pathValue: string,
  file: string,
  probe: Probe,
  delimiter: string = path.delimiter,
  join: (...parts: string[]) => string = path.join
): Promise<{ found: boolean; timedOut: boolean; at: string | null }> {
  const dirs = pathValue.split(delimiter).filter((d) => d !== '')
  const paths = dirs.map((dir) => join(dir, file))
  const results = await Promise.all(paths.map((p) => probe(p)))
  const first = results.indexOf('present')
  return { found: first >= 0, timedOut: results.includes('timeout'), at: first >= 0 ? paths[first] : null }
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
