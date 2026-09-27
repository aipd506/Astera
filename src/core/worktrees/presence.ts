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
// - **createPresenceCheck** asks once, through pathProbe's pool (its thread cap, per-root rule and
//   timeout). It answers `missing` only when the folder is confirmed gone: ENOENT on the folder while
//   the folder's volume (rootOf) answers. A timeout, any other error, or ENOENT on a volume that is
//   itself gone (an unplugged drive, an unmapped letter) answers `unreachable`.
// - **PresenceCache** holds the last answer per path. `peek` is synchronous and never touches the fs:
//   with no answer yet it says `unknown` and schedules a check. Answers are refreshed by a periodic
//   sweep and whenever a caller asks through `refresh` (the worktree list does).
import { promises as fs } from 'node:fs'
import { createProber, rootOf, type ProbePool } from '../sessions/pathProbe'

/** `missing` is the only answer that may make a caller forget a worktree. */
export type Presence = 'present' | 'missing' | 'unreachable'
/** What a synchronous reader sees: `unknown` until the first check has answered. */
export type PresenceView = Presence | 'unknown'
/** Never rejects. */
export type PresenceCheck = (p: string) => Promise<Presence>

/** How often the background sweep re-checks every known path. */
export const PRESENCE_SWEEP_MS = 60_000
/** A path nobody has read for this long, and that the sweep was not given, is dropped. */
export const PRESENCE_EVICT_MS = 10 * 60_000

export interface PresenceCheckDeps {
  /** Resolves when the path exists, rejects with an errno error otherwise. Defaults to fs.promises.access. */
  access?: (p: string) => Promise<void>
  timeoutMs?: number
  /** Defaults to pathProbe's process-wide pool, so these calls share its thread cap. */
  pool?: ProbePool
  log?: (m: string) => void
}

export function createPresenceCheck(d: PresenceCheckDeps = {}): PresenceCheck {
  const access = d.access ?? ((p: string) => fs.access(p))
  // The prober reports every rejection as `absent`; the code is kept here to tell ENOENT apart. The
  // pool never makes a second call on a root while one there is unanswered, and the per-path single
  // flight below keeps two checks of one path from sharing an entry.
  const codes = new Map<string, string | undefined>()
  const prober = createProber({
    access: (p) =>
      access(p).catch((e: unknown) => {
        codes.set(p, (e as NodeJS.ErrnoException | null)?.code)
        throw e
      }),
    timeoutMs: d.timeoutMs,
    pool: d.pool,
    log: d.log
  })
  const once = async (p: string): Promise<'present' | 'enoent' | 'unreachable'> => {
    codes.delete(p)
    const r = await prober(p)
    if (r === 'present') return 'present'
    if (r === 'timeout') return 'unreachable'
    const code = codes.get(p)
    codes.delete(p)
    return code === 'ENOENT' ? 'enoent' : 'unreachable'
  }
  const inflight = new Map<string, Promise<Presence>>()
  return (p) => {
    const running = inflight.get(p)
    if (running) return running
    const run = (async (): Promise<Presence> => {
      try {
        const r = await once(p)
        if (r !== 'enoent') return r
        // The folder is not there. Is that because it was removed, or because its volume is gone?
        const root = rootOf(p)
        if (root === p) return 'unreachable'
        return (await once(root)) === 'present' ? 'missing' : 'unreachable'
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
export function defaultPresenceCheck(p: string): Promise<Presence> {
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

  /** Checks `p` now (sharing a check already running) and stores the answer. Never rejects. */
  refresh(p: string): Promise<Presence> {
    const running = this.inflight.get(p)
    if (running) return running
    const run = Promise.resolve()
      .then(() => this.check(p))
      .catch((): Presence => 'unreachable')
      .then((value) => {
        this.inflight.delete(p)
        const prev = this.entries.get(p)
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
