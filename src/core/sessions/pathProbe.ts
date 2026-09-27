// Asynchronous, time-limited file probes for the spawn path.
//
// A synchronous `existsSync` on a path that sits on an offline mapped drive or a dead UNC share does
// not fail fast: Windows waits for the SMB redirector, which can take 20 to 60 seconds, and for that
// whole time the thread that asked is frozen. On the spawn path that thread is the Electron main
// process (every window stops) or the Host's only thread (every pty it holds stops). PATH is the usual
// culprit: findGitBash and the terminal's shell lookup look into every PATH entry, and one entry on a
// drive that is not connected today is enough.
//
// So a probe here is async (it runs on the libuv threadpool, not the caller's thread) and is cut
// PROBE_TIMEOUT_MS after **its fs call starts**, then counts as `timeout` (absent, for a PATH lookup).
//
// **How the threadpool is kept.** At most PROBE_CONCURRENCY calls that are still within their time run
// at once. A call that times out gives its slot back at once — it still occupies a libuv thread, but it
// must not hold up the probes queued behind it, which may all be on a healthy disk. What bounds the
// hung threads instead is the root (drive letter or UNC share; see rootOf): while a call on a root is
// still hung, every further probe on that root answers `timeout` at once without making a call. So the
// hung threads number at most one wave per dead root — one per slot at the most, since a root's first
// calls may run together — and never grow while that root stays dead. When the hung call finally ends,
// the root may be asked again.
//
// UV_THREADPOOL_SIZE is left at libuv's default (4). It only takes effect if set before the pool's
// first use, and an entry module cannot guarantee that from its own code: its imports are evaluated
// before its body, and Electron's main process may touch the pool before app code runs. A value set
// too late is silently ignored, which would read as a fix without being one. So the root bound above
// is what keeps the pool, and it is documented here rather than raised.
//
// **The cwd skips the queue** (`skipQueue`): a spawn's one folder check never waits behind PATH probes,
// so a local folder cannot be judged unreachable because a PATH lookup is stuck on an offline drive.
// It still obeys its own root's hung state — a folder on a drive already known to hang is not
// reachable, and saying so at once is the point.
//
// Pure apart from the default `access`, which is `fs.promises.access`; everything else is injected so
// the timing can be tested with fake timers.
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** How long one probe's fs call may take before it counts as absent. */
export const PROBE_TIMEOUT_MS = 1_500
/** How many probe calls still within their time may be in flight at once, per process. */
export const PROBE_CONCURRENCY = 4
/** How long a result computed from a PATH string is trusted before it is computed again. */
export const PROBE_CACHE_TTL_MS = 5 * 60_000
/** How long a result is trusted when a timeout went into it: short, since the drive may come back. */
export const PROBE_DEGRADED_TTL_MS = 10_000
/** How many timed-out paths a prober remembers having logged; the oldest is forgotten past this. */
export const LOGGED_PATHS_MAX = 256

/** `timeout` is reported apart from `absent` so a caller that must not guess (the session's cwd) can
 *  say "not reachable" instead of "missing"; every PATH lookup treats it as absent. */
export type ProbeResult = 'present' | 'absent' | 'timeout'
export type Probe = (p: string) => Promise<ProbeResult>
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>

/** Runs at most `max` tasks at once; the rest wait in order. A task's rejection goes to its own caller. */
export function createLimiter(max: number): Limiter {
  let active = 0
  const queue: (() => void)[] = []
  const release = (): void => {
    active--
    queue.shift()?.()
  }
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = (): void => {
        active++
        let run: Promise<T>
        try {
          run = task()
        } catch (err) {
          run = Promise.reject(err)
        }
        run.then(resolve, reject).finally(release)
      }
      if (active < max) start()
      else queue.push(start)
    })
}

/** What every prober of one process shares: the slots, and which roots have a call still hung. */
export interface ProbePool {
  limit: Limiter
  /** root → how many timed-out calls on it have not ended yet. */
  hung: Map<string, number>
}

export function createProbePool(max: number = PROBE_CONCURRENCY): ProbePool {
  return { limit: createLimiter(max), hung: new Map() }
}

const sharedPool = createProbePool()

/**
 * The unit a dead network location takes down together: the drive (`z:\`) or the UNC share
 * (`\\server\share\`) for a Windows path, case-folded; the first two segments for a POSIX one
 * (`/mnt/nas`), where a hung mount sits below `/`, not at it.
 */
export function rootOf(p: string): string {
  if (/^[a-z]:/i.test(p) || /^[\\/]{2}[^\\/]/.test(p)) {
    const root = path.win32.parse(path.win32.normalize(p)).root
    return root.toLowerCase()
  }
  const segs = p.split('/').filter((s) => s !== '')
  return '/' + segs.slice(0, 2).join('/')
}

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
  /** Told once per path that timed out (at most LOGGED_PATHS_MAX remembered). Defaults to probeLog. */
  log?: (m: string) => void
  /** Run at once rather than wait for a slot — the session folder's check. */
  skipQueue?: boolean
}

export type Prober = Probe & {
  /** How many paths the logged-once memory holds (bounded by LOGGED_PATHS_MAX). */
  loggedCount(): number
}

/**
 * A probe: `present`, `absent`, or `timeout` when the call did not come back within the limit (or its
 * root already has a call hung). It never rejects, and a call that answers after its timeout is
 * swallowed — nothing is left unhandled.
 */
export function createProber(d: ProberDeps = {}): Prober {
  const access = d.access ?? ((p: string) => fs.access(p))
  const timeoutMs = d.timeoutMs ?? PROBE_TIMEOUT_MS
  const pool = d.pool ?? sharedPool
  const log = d.log ?? probeLog
  const logged = new Set<string>()
  const logOnce = (p: string, why: string): void => {
    if (logged.has(p)) return
    logged.add(p)
    if (logged.size > LOGGED_PATHS_MAX) logged.delete(logged.values().next().value as string)
    try {
      log(`path probe: ${why}, treated as absent: ${p}`)
    } catch {
      /* a log that throws must not keep the probe from answering */
    }
  }
  const unhang = (root: string): void => {
    const n = (pool.hung.get(root) ?? 1) - 1
    if (n <= 0) pool.hung.delete(root)
    else pool.hung.set(root, n)
  }
  const probe = (p: string): Promise<ProbeResult> =>
    new Promise<ProbeResult>((resolve) => {
      const root = rootOf(p)
      // One slot's worth of work: resolves (frees the slot) on the answer or on the timeout.
      const attempt = (): Promise<void> =>
        new Promise<void>((release) => {
          if (pool.hung.has(root)) {
            logOnce(p, `${root} still has a call that gave no answer`)
            resolve('timeout')
            release()
            return
          }
          let done = false
          const call = Promise.resolve().then(() => access(p))
          const timer = setTimeout(() => {
            if (done) return
            done = true
            pool.hung.set(root, (pool.hung.get(root) ?? 0) + 1)
            const end = (): void => unhang(root)
            call.then(end, end)
            logOnce(p, `no answer within ${timeoutMs}ms`)
            resolve('timeout')
            release()
          }, timeoutMs)
          const finish = (r: ProbeResult): void => {
            if (done) return
            done = true
            clearTimeout(timer)
            resolve(r)
            release()
          }
          call.then(
            () => finish('present'),
            () => finish('absent')
          )
        })
      const run = d.skipQueue ? attempt() : pool.limit(attempt)
      run.catch(() => {
        /* attempt never rejects; this only keeps the chain from ever being unhandled */
      })
    })
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
