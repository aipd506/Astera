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
// - **createPresenceCheck** asks through a pathProbe pool of its own (the per-root rule, the timeout
//   and the stuck-call ceiling), **outside the PATH cap**: a stuck worktree call holds its own slot,
//   never one of the two PATH slots. Otherwise one stuck worktree share plus one dead PATH root filled
//   the PATH cap, the Git Bash probes on C: were refused, and a session spawned without Git Bash.
//   **The thread budget is pathProbe's, shared by every lane** (ProbeBudget): one call per root at a
//   time across the PATH pool, the session folder's lane and both presence lanes, a root stuck in one
//   lane is stuck in all, and at most PROBE_STUCK_MAX (3) stuck calls in the whole process, past which
//   only a root that answered in the last 5 minutes is probed (so C: keeps working). A root the budget
//   refuses makes no call: the check answers `refused`.
//
//   It answers `missing` only when the folder is confirmed gone: ENOENT on the folder while
//   something that proves the volume is there answers. On Windows that is the drive or share root
//   (rootOf). On POSIX it is the folder's parent — rootOf there is only the first two segments, and
//   `/media/u` answers while the USB drive mounted below it is unplugged, as does an empty `nofail`
//   mountpoint. The price: a worktree whose parent was deleted too shows as `unreachable`, not
//   `missing`. A timeout or any other error answers `unreachable`.
//
//   `refused` means no call was made: the pool refused it (an injected pool whose cap is full of stuck
//   calls), or this check's own rules did. A caller keeps what it knew. The rules, so dead shares hold
//   at most one thread:
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
import { createProbePool, createProber, PROBE_STUCK_CEILING_MS, rootOf, type ProbePool } from '../sessions/pathProbe'

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
/** How many worktree calls may exist at once, stuck ones included — a slot of their own, outside the PATH cap. */
export const PRESENCE_CONCURRENCY = 1
/** How long a root whose call timed out is left alone before it is probed again. */
export const PRESENCE_RETRY_MS = 5 * 60_000

export interface PresenceCheckDeps {
  /** Resolves when the path exists, rejects with an errno error otherwise. Defaults to fs.promises.access. */
  access?: (p: string) => Promise<void>
  timeoutMs?: number
  /** Defaults to a pool of this check's own, outside pathProbe's PATH cap (tests inject a shared one). */
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
  return makeCheck(d, false)
}

/**
 * The action lane: the checks a person or a merge waits on (creating and removing a worktree,
 * run-delete, run-merge, the merge's marker files). **One call per root at a time, not one for the
 * whole process.** The sweep's single slot is right for a background refresh, but while it hung on a
 * dead Z: share every other check was refused, on any drive: a merge into C: stopped on a Gate and a
 * worker's new worktree failed. Here a stuck call holds only its own root; a check on another root
 * goes ahead. The calls go through pathProbe's session-folder lane (`skipQueue`) in a pool of their
 * own, so a stuck root answers `timeout` at once, without a call, until its call settles or reaches
 * the ceiling — and then it is tried again (no PRESENCE_RETRY_MS rest: a person is asking now).
 * Stuck calls number at most one per dead root. **Past the stuck-call cap** (pathProbe's `pastCap`): a
 * root not known to be alive still gets its one call when three calls are stuck elsewhere.
 */
export function createActionPresenceCheck(d: PresenceCheckDeps = {}): PresenceCheck {
  return makeCheck(d, true)
}

function makeCheck(d: PresenceCheckDeps, perRoot: boolean): PresenceCheck {
  const access = d.access ?? ((p: string) => fs.access(p))
  const now = d.now ?? Date.now
  const ceilingMs = d.ceilingMs ?? PROBE_STUCK_CEILING_MS
  /** key → the one call that exists for it. The key is the root on the action lane, '' on the sweep's
   *  (PRESENCE_CONCURRENCY: one for the whole process). */
  const holders = new Map<string, Holder>()
  const waiters = new Map<string, Array<() => void>>()
  const keyOf = (p: string): string => (perRoot ? rootOf(p) : '')
  const wake = (key: string): void => {
    const list = waiters.get(key) ?? []
    waiters.delete(key)
    for (const w of list) w()
  }
  /** root → when it may be probed again, after a call on it timed out (the sweep's lane only). */
  const resting = new Map<string, number>()
  // Only one attempt runs at a time per key (holders), so the access wrapper knows whose call it is making.
  const prober = createProber({
    access: (p) => {
      const h = holders.get(keyOf(p))
      if (h) h.called = true
      // Through a promise, so an access that throws synchronously still reaches letGo below and the
      // worktree slot is released; otherwise every later check would wait on it forever.
      return Promise.resolve()
        .then(() => access(p))
        .then(
          () => h?.letGo(),
          (e: unknown) => {
            if (h) h.code = (e as NodeJS.ErrnoException | null)?.code
            h?.letGo()
            throw e
          }
        )
    },
    timeoutMs: d.timeoutMs,
    // Its own pool, not the PATH pool: a stuck worktree call must never take one of the two PATH slots
    // (see the header). The holders above already keep this pool to one call (per root, on the action lane).
    pool: d.pool ?? createProbePool(PRESENCE_CONCURRENCY),
    skipQueue: perRoot,
    // The action lane is asked by a person (or a merge) waiting now: its call goes past the stuck-call
    // cap, so dead drives elsewhere never make a live root's check "refused" (ProbeBudget.enter). A
    // root stuck itself is still refused. The sweep's background lane stays under the cap.
    pastCap: perRoot,
    log: d.log
  })
  const attempt = async (p: string, again = false): Promise<Attempt> => {
    const root = rootOf(p)
    const key = keyOf(p)
    const until = resting.get(root)
    if (until !== undefined) {
      if (now() < until) return 'refused'
      resting.delete(root)
    }
    for (let h = holders.get(key); h; h = holders.get(key)) {
      if (h.stuck) return 'refused'
      await new Promise<void>((r) => {
        const list = waiters.get(key) ?? []
        list.push(r)
        waiters.set(key, list)
      })
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
        if (holders.get(key) === h) holders.delete(key)
        wake(key)
      }
    }
    holders.set(key, h)
    const r = await prober(p)
    if (!h.called && r !== 'timeout') {
      // The pool handed this attempt the answer of a call already in flight for the same question (the
      // same path, the same prober): no call of its own was made, so nothing lets this slot go — the
      // next check on the root then waited forever. Let go here. `present` is the answer; for `absent`
      // the errno that tells "removed" from "cannot say" is not known, so ask once more, now alone.
      h.letGo()
      // Once only: a second shared `absent` is taken as "cannot say" (error → unreachable), never as removed.
      return r === 'present' ? 'present' : again ? 'error' : attempt(p, true)
    }
    if (r === 'present') return 'present'
    if (r === 'absent') return h.code === 'ENOENT' ? 'enoent' : 'error'
    if (!h.called) {
      h.letGo()
      return 'refused'
    }
    if (!h.done) {
      h.stuck = true
      if (!perRoot) resting.set(root, now() + PRESENCE_RETRY_MS)
      ceiling = setTimeout(h.letGo, ceilingMs)
      ceiling.unref?.()
      wake(key) // the waiters are refused now
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

/** How many times askUntilAnswered asks while the answer is `refused`, and how long it waits between. */
export const ASK_TRIES = 3
export const ASK_RETRY_MS = 500

/**
 * Asks `check` about `p`, and asks again while it answers `refused` (no call was made, nothing was
 * learned): at most ASK_TRIES times, ASK_RETRY_MS apart, so within the probe's own 1.5 s budget. A
 * refusal that lasts is still `refused`, never `unreachable` — the caller says "could not check".
 * On the action lane a refusal only ever means the same root has a call that gave no answer yet.
 * A check that rejects is `unreachable`. Never rejects.
 */
export async function askUntilAnswered(check: PresenceCheck, p: string): Promise<CheckResult> {
  for (let i = 1; ; i++) {
    let r: CheckResult
    try {
      r = await check(p)
    } catch {
      return 'unreachable'
    }
    if (r !== 'refused' || i >= ASK_TRIES) return r
    await new Promise((res) => setTimeout(res, ASK_RETRY_MS))
  }
}

let defaultAction: PresenceCheck | null = null
/** The process-wide action-lane check (createActionPresenceCheck): fs.promises.access, one call per root. */
export function defaultActionPresenceCheck(p: string): Promise<CheckResult> {
  defaultAction ??= createActionPresenceCheck()
  return defaultAction(p)
}

let defaultCheck: PresenceCheck | null = null
/** The process-wide check: fs.promises.access through its own one-slot pool, and the probe log. */
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
