// Whether a worktree's folder is still there — asked asynchronously, with a time limit, and cached.
//
// A synchronous `existsSync` on a folder that sits on an offline network share, a OneDrive placeholder
// or `\\wsl$` does not fail fast: Windows waits for the redirector, 20 to 60 s, and the thread that
// asked is frozen. The orchestration push (main's orchSnapshotOf) folds after every setState on the
// Electron main thread, so one such folder froze the whole app on every state change. And the
// worktree list used to forget any entry whose check said "no" — a drive briefly offline cost the
// user the entry.
//
// So there are two pieces:
// - **createPresenceCheck** asks through pathProbe's pool (its thread cap, per-root rule and
//   timeout). It answers `missing` only when the folder is confirmed gone: ENOENT on the folder while
//   something that proves the volume is there answers. On Windows that is the drive or share root
//   (rootOf). On POSIX it is the folder's parent — rootOf there is only the first two segments, and
//   `/media/u` answers while the USB drive mounted below it is unplugged, as does an empty `nofail`
//   mountpoint. The price: a worktree whose parent was deleted too shows as `unreachable`, not
//   `missing`. A timeout or any other error answers `unreachable`.
//
//   `refused` means no call was made: the pool refused it (its cap is full of stuck calls), or this
//   check's own rules did. A caller keeps what it knew. The rules, so dead shares cannot fill the
//   PATH cap that pathProbe keeps for PATH lookups:
//   - **At most one worktree call exists at once, stuck ones included** (PRESENCE_CONCURRENCY). A
//     second check waits for a live call; while the call is stuck, every other check is refused. The
//     stuck call is let go at PROBE_STUCK_CEILING_MS, as the pool does.
//   - **A root whose call timed out is not probed again for PRESENCE_RETRY_MS.** So the sweep skips
//     a dead share instead of holding a pool slot on it again every minute.
// - **PresenceCache** holds the last answer per path. `peek` is synchronous and never touches the fs:
//   with no answer yet it says `unknown` and schedules a check. Answers are refreshed by a periodic
//   sweep and whenever a caller asks through `refresh` (the worktree list does). A `refused` answer
//   changes nothing.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createProber, PROBE_STUCK_CEILING_MS, rootOf, type ProbePool } from '../sessions/pathProbe'

/** `missing` is the only answer that may make a caller forget a worktree. */
export type Presence = 'present' | 'missing' | 'unreachable'
/** What a synchronous reader sees: `unknown` until the first check has answered. */
export type PresenceView = Presence | 'unknown'
/** `refused`: no call was made, nothing was learned. */
export type CheckResult = Presence | 'refused'
/** Never rejects. */
export type PresenceCheck = (p: string) => Promise<CheckResult>

/** How often the background sweep re-checks every known path. */
export const PRESENCE_SWEEP_MS = 60_000
/** A path nobody has read for this long, and that the sweep was not given, is dropped. */
export const PRESENCE_EVICT_MS = 10 * 60_000
/** How many worktree calls may exist at once, stuck ones included — one of the pool's PATH slots. */
export const PRESENCE_CONCURRENCY = 1
/** How long a root whose call timed out is left alone before it is probed again. */
export const PRESENCE_RETRY_MS = 5 * 60_000

export interface PresenceCheckDeps {
  /** Resolves when the path exists, rejects with an errno error otherwise. Defaults to fs.promises.access. */
  access?: (p: string) => Promise<void>
  timeoutMs?: number
  /** Defaults to pathProbe's process-wide pool, so these calls share its thread cap. */
  pool?: ProbePool
  log?: (m: string) => void
  now?: () => number
  ceilingMs?: number
}

/** What must answer for an ENOENT on `p` to mean "removed": the drive or share on Windows, the
 *  parent on POSIX. Null when there is nothing above `p` to ask. */
function witnessOf(p: string): string | null {
  const root = rootOf(p)
  if (root.startsWith('/')) {
    const parent = path.posix.dirname(p)
    return parent === p || parent === '/' ? null : parent
  }
  const trimmed = p.replace(/[\\/]+$/, '')
  return trimmed.length + 1 <= root.length ? null : root
}

type Attempt = 'present' | 'enoent' | 'error' | 'timeout' | 'refused'

interface Holder {
  called: boolean
  stuck: boolean
  done: boolean
  code?: string
  letGo(): void
}

export function createPresenceCheck(d: PresenceCheckDeps = {}): PresenceCheck {
  const access = d.access ?? ((p: string) => fs.access(p))
  const now = d.now ?? Date.now
  const ceilingMs = d.ceilingMs ?? PROBE_STUCK_CEILING_MS
  /** The one worktree call that exists, if any (PRESENCE_CONCURRENCY). */
  let holder: Holder | null = null
  const waiters: Array<() => void> = []
  const wake = (): void => {
    for (const w of waiters.splice(0)) w()
  }
  /** root → when it may be probed again, after a call on it timed out. */
  const resting = new Map<string, number>()
  // Only one attempt runs at a time (holder), so the access wrapper knows whose call it is making.
  const prober = createProber({
    access: (p) => {
      const h = holder
      if (h) h.called = true
      return access(p).then(
        () => h?.letGo(),
        (e: unknown) => {
          if (h) h.code = (e as NodeJS.ErrnoException | null)?.code
          h?.letGo()
          throw e
        }
      )
    },
    timeoutMs: d.timeoutMs,
    pool: d.pool,
    log: d.log
  })
  const attempt = async (p: string): Promise<Attempt> => {
    const root = rootOf(p)
    const until = resting.get(root)
    if (until !== undefined) {
      if (now() < until) return 'refused'
      resting.delete(root)
    }
    while (holder) {
      if (holder.stuck) return 'refused'
      await new Promise<void>((r) => waiters.push(r))
    }
    let ceiling: ReturnType<typeof setTimeout> | null = null
    const h: Holder = {
      called: false,
      stuck: false,
      done: false,
      letGo: () => {
        if (h.done) return
        h.done = true
        if (ceiling) clearTimeout(ceiling)
        if (holder === h) holder = null
        wake()
      }
    }
    holder = h
    const r = await prober(p)
    if (r === 'present') return 'present'
    if (r === 'absent') return h.code === 'ENOENT' ? 'enoent' : 'error'
    if (!h.called) {
      h.letGo()
      return 'refused'
    }
    if (!h.done) {
      h.stuck = true
      resting.set(root, now() + PRESENCE_RETRY_MS)
      ceiling = setTimeout(h.letGo, ceilingMs)
      ceiling.unref?.()
      wake() // the waiters are refused now
    }
    return 'timeout'
  }
  const inflight = new Map<string, Promise<CheckResult>>()
  return (p) => {
    const running = inflight.get(p)
    if (running) return running
    const run = (async (): Promise<CheckResult> => {
      try {
        const r = await attempt(p)
        if (r === 'present' || r === 'refused') return r
        if (r !== 'enoent') return 'unreachable'
        // The folder is not there. Was it removed, or is the volume under it gone?
        const witness = witnessOf(p)
        if (witness === null) return 'unreachable'
        const w = await attempt(witness)
        if (w === 'refused') return 'refused'
        return w === 'present' ? 'missing' : 'unreachable'
      } catch {
        return 'unreachable'
      } finally {
        inflight.delete(p)
      }
    })()
    inflight.set(p, run)
    return run
  }
}

let defaultCheck: PresenceCheck | null = null
/** The process-wide check: fs.promises.access through pathProbe's shared pool and probe log. */
export function defaultPresenceCheck(p: string): Promise<CheckResult> {
  defaultCheck ??= createPresenceCheck()
  return defaultCheck(p)
}

interface Entry {
  value: Presence
  readAt: number
}

export interface PresenceCacheDeps {
  check?: PresenceCheck
  /** Told when a path's answer first lands or changes. Errors are logged, never thrown. */
  onChange?: (p: string, value: Presence) => void
  log?: (m: string) => void
  now?: () => number
}

export class PresenceCache {
  private entries = new Map<string, Entry>()
  private inflight = new Map<string, Promise<Presence>>()
  private check: PresenceCheck
  private now: () => number

  constructor(private d: PresenceCacheDeps = {}) {
    this.check = d.check ?? defaultPresenceCheck
    this.now = d.now ?? Date.now
  }

  /** The last answer for `p`, or `unknown` (a check is then scheduled). Synchronous, no fs. */
  peek(p: string): PresenceView {
    const e = this.entries.get(p)
    if (e) {
      e.readAt = this.now()
      return e.value
    }
    void this.refresh(p)
    return 'unknown'
  }

  /**
   * Checks `p` now (sharing a check already running) and stores the answer. Never rejects. A refused
   * check (no call made) stores nothing: the answer is the last one known, or `unreachable` when
   * there is none — to a caller that must say something (the worktree list), not knowing is that.
   */
  refresh(p: string): Promise<Presence> {
    const running = this.inflight.get(p)
    if (running) return running
    const run = Promise.resolve()
      .then(() => this.check(p))
      .catch((): CheckResult => 'unreachable')
      .then((value): Presence => {
        this.inflight.delete(p)
        const prev = this.entries.get(p)
        if (value === 'refused') return prev?.value ?? 'unreachable'
        this.entries.set(p, { value, readAt: prev?.readAt ?? this.now() })
        if (prev?.value !== value) this.tell(p, value)
        return value
      })
    this.inflight.set(p, run)
    return run
  }

  /** Re-checks every known path and each of `extra`; drops paths nobody has read for a while. */
  async sweep(extra: string[] = []): Promise<void> {
    const keep = new Set(extra)
    const now = this.now()
    for (const [p, e] of this.entries) if (!keep.has(p) && now - e.readAt >= PRESENCE_EVICT_MS) this.entries.delete(p)
    const all = new Set([...this.entries.keys(), ...extra])
    await Promise.all([...all].map((p) => this.refresh(p)))
  }

  /** Sweeps every `intervalMs` until the returned function is called. The timer does not keep the process up. */
  start(intervalMs: number, paths: () => string[]): () => void {
    const timer = setInterval(() => {
      let extra: string[] = []
      try {
        extra = paths()
      } catch (err) {
        this.logSafe(`worktree presence: sweep paths failed: ${String(err)}`)
      }
      void this.sweep(extra)
    }, intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  private tell(p: string, value: Presence): void {
    if (!this.d.onChange) return
    try {
      this.d.onChange(p, value)
    } catch (err) {
      this.logSafe(`worktree presence: onChange failed for ${p}: ${String(err)}`)
    }
  }

  private logSafe(m: string): void {
    try {
      ;(this.d.log ?? console.warn)(m)
    } catch {
      /* a log that throws blocks nothing */
    }
  }
}
