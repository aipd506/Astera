// The re-push that follows a worktree presence answer (core/worktrees/presence.ts).
//
// The orchestration push folds the state with whatever presence the cache holds at that moment, and a
// path the cache had not checked yet counts as present ("unknown" is not "missing"). When the check
// answers later, the state is folded once more so a folder that turned out gone drops off the screen.
// Many answers land together (a sweep), so they share one fold on the next tick, and sameSnapshot in
// the push drops it if nothing on screen changed.

export interface PresenceRepushDeps<S> {
  /** The state to fold now, or null when there is none yet. Read when the fold runs, not when asked. */
  current(): S | null
  push(state: S): void
  log(m: string): void
  /** Defaults to setTimeout(fn, 0). */
  schedule?: (fn: () => void) => void
}

/** Returns the cache's onChange: coalesces answers into one fold on the next tick. Never throws. */
export function createPresenceRepush<S>(d: PresenceRepushDeps<S>): () => void {
  const schedule = d.schedule ?? ((fn: () => void): void => void setTimeout(fn, 0))
  let queued = false
  return () => {
    if (queued) return
    queued = true
    schedule(() => {
      queued = false
      try {
        const state = d.current()
        if (state !== null) d.push(state)
      } catch (err) {
        try {
          d.log(`orch:state re-push after a worktree presence answer failed: ${String(err)}`)
        } catch {
          /* a log that throws blocks nothing */
        }
      }
    })
  }
}
