// Asynchronous, time-limited file probes for the spawn path.
//
// A synchronous `existsSync` on a path that sits on an offline mapped drive or a dead UNC share does
// not fail fast: Windows waits for the SMB redirector, which can take 20 to 60 seconds, and for that
// whole time the thread that asked is frozen. On the spawn path that thread is the Electron main
// process (every window stops) or the Host's only thread (every pty it holds stops). PATH is the usual
// culprit: findGitBash and the terminal's shell lookup look into every PATH entry, and one entry on a
// drive that is not connected today is enough.
//
// So a probe here is async (it runs on the libuv threadpool, not the caller's thread), is cut after
// PROBE_TIMEOUT_MS and then counts as absent, and shares a process-wide bound of PROBE_CONCURRENCY
// calls in flight, so a handful of hung SMB calls cannot take over the whole threadpool (it has four
// threads by default). A slot is held until the underlying call really ends, not until its timeout:
// the thread is still stuck in that call, and letting a fifth one start would only hang a fifth thread.
//
// Pure apart from the default `access`, which is `fs.promises.access`; everything else is injected so
// the timing can be tested with fake timers.
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** How long one probe may take before it counts as absent. */
export const PROBE_TIMEOUT_MS = 1_500
/** How many probe calls may be in flight at once, per process. */
export const PROBE_CONCURRENCY = 4
/** How long a result computed from a PATH string is trusted before it is computed again. */
export const PROBE_CACHE_TTL_MS = 5 * 60_000

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

/** The one bound every default probe in this process shares. */
const sharedLimiter = createLimiter(PROBE_CONCURRENCY)

export interface ProberDeps {
  /** Resolves when the path exists, rejects when it does not. Defaults to `fs.promises.access`. */
  access?: (p: string) => Promise<void>
  timeoutMs?: number
  limit?: Limiter
  /** Told once per path that timed out. */
  log?: (m: string) => void
}

/**
 * A probe: `present`, `absent`, or `timeout` when neither came back within the limit. It never
 * rejects, and a call that answers after its timeout is swallowed — nothing is left unhandled. The
 * limit covers the wait for a slot as well, so a caller never waits longer than it for one answer;
 * a probe whose time ran out while it was still queued does not start at all.
 */
export function createProber(d: ProberDeps = {}): Probe {
  const access = d.access ?? ((p: string) => fs.access(p))
  const timeoutMs = d.timeoutMs ?? PROBE_TIMEOUT_MS
  const limit = d.limit ?? sharedLimiter
  const log = d.log ?? ((m: string) => console.warn(m))
  const logged = new Set<string>()
  return (p) =>
    new Promise<ProbeResult>((resolve) => {
      let done = false
      const finish = (r: ProbeResult): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(r)
      }
      const timer = setTimeout(() => {
        if (!logged.has(p)) {
          logged.add(p)
          try {
            log(`path probe gave no answer within ${timeoutMs}ms, treated as absent: ${p}`)
          } catch {
            /* a log that throws must not keep the probe from answering */
          }
        }
        finish('timeout')
      }, timeoutMs)
      limit(async () => {
        if (done) return // timed out while queued: do not spend a slot on it
        try {
          await access(p)
          finish('present')
        } catch {
          finish('absent')
        }
      }).catch(() => {
        /* the task above catches everything; this only keeps the chain from ever being unhandled */
      })
    })
}

let defaultProber: Probe | null = null
/** The process-wide probe: `fs.promises.access`, the default limit, the shared bound. */
export function defaultProbe(p: string): Promise<ProbeResult> {
  defaultProber ??= createProber()
  return defaultProber(p)
}

/**
 * Refuses a session folder that is not there (`CWD_MISSING`) or that did not answer within the probe
 * limit (`CWD_UNREACHABLE: folder not reachable: <path>`) — an offline mapped drive or UNC share,
 * which a sync check would have waited 20 to 60 s on. `missing` lets a caller keep its own wording.
 */
export async function checkCwd(cwd: string, probe: Probe = defaultProbe, missing = `CWD_MISSING: ${cwd}`): Promise<void> {
  const r = await probe(cwd)
  if (r === 'absent') throw new Error(missing)
  if (r === 'timeout') throw new Error(`CWD_UNREACHABLE: folder not reachable: ${cwd}`)
}

/**
 * Whether `file` sits in any directory of `pathValue`. The directories are probed together (the
 * probe's own limiter bounds how many at once), and one that times out counts as not holding it.
 */
export async function findOnPath(
  pathValue: string,
  file: string,
  probe: Probe,
  delimiter: string = path.delimiter,
  join: (...parts: string[]) => string = path.join
): Promise<boolean> {
  const dirs = pathValue.split(delimiter).filter((d) => d !== '')
  const results = await Promise.all(dirs.map((dir) => probe(join(dir, file))))
  return results.includes('present')
}

interface Entry<V> {
  at: number
  promise: Promise<V>
  settled: boolean
  value?: V
}

/**
 * Results worked out from one PATH string, kept per process. An entry is trusted for `ttlMs`; a new
 * PATH string drops every entry, since each was worked out from the old one. Callers that ask while a
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
    if (this.now() - e.at >= this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    return e
  }

  get(pathValue: string, key: string, compute: () => Promise<V>): Promise<V> {
    const hit = this.fresh(pathValue, key)
    if (hit) return hit.promise
    if (pathValue !== this.pathValue) {
      this.pathValue = pathValue
      this.entries.clear()
    }
    const entry: Entry<V> = { at: this.now(), promise: Promise.resolve().then(compute), settled: false }
    this.entries.set(key, entry)
    entry.promise.then(
      (v) => {
        entry.settled = true
        entry.value = v
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key)
      }
    )
    return entry.promise
  }

  /** The settled, fresh value for this PATH string and key, or undefined — synchronous, for a caller
   *  that cannot wait (a respawn after its await-free point). */
  peek(pathValue: string, key: string): V | undefined {
    const e = this.fresh(pathValue, key)
    return e?.settled ? e.value : undefined
  }
}
