import type { WorktreeCreateProgress } from '../types'

/** About four reports a second. Copying reports once per file, and thousands of small files would
 *  otherwise be thousands of IPC messages for a bar nobody can read that fast. */
export const PROGRESS_INTERVAL_MS = 250

export interface ProgressThrottle {
  push(p: WorktreeCreateProgress): void
  /** Sends the held report now, if there is one. */
  flush(): void
  /** Drops the held report and stops the timer; nothing is sent after this. */
  dispose(): void
}

/** Throttles createWorktree's progress for sending across a process boundary.
 *
 *  - A report for a **new stage** goes at once: which stage it is in is the one thing the person most
 *    needs to see, and stages change only a handful of times.
 *  - Within a stage, at most one report per PROGRESS_INTERVAL_MS; the one sent at the end of a window
 *    is the latest, so the last numbers are never lost.
 *  - A throwing `emit` (a window that went away) is swallowed: progress must never break the creation. */
export function throttleProgress(
  emit: (p: WorktreeCreateProgress) => void,
  intervalMs: number = PROGRESS_INTERVAL_MS
): ProgressThrottle {
  let lastStage: string | null = null
  let lastAt = -Infinity
  let held: WorktreeCreateProgress | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const send = (p: WorktreeCreateProgress): void => {
    lastStage = p.stage
    lastAt = Date.now()
    held = null
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    try {
      emit(p)
    } catch {
      // the receiver is gone — nothing to report to
    }
  }

  return {
    push(p) {
      if (disposed) return
      if (p.stage !== lastStage || Date.now() - lastAt >= intervalMs) {
        send(p)
        return
      }
      held = p
      if (!timer)
        timer = setTimeout(() => {
          timer = null
          if (held && !disposed) send(held)
        }, Math.max(0, lastAt + intervalMs - Date.now()))
    },
    flush() {
      if (held && !disposed) send(held)
    },
    dispose() {
      disposed = true
      held = null
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}
