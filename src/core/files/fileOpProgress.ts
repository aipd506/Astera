import type { FileOpProgress, FileOpStage } from '../types'
import { throttleProgress, PROGRESS_INTERVAL_MS } from '../worktrees/progress'

export type { FileOpProgress, FileOpStage }

export interface FileOpCounter {
  /** One more entry done in this stage. */
  entry(stage: FileOpStage): void
  /** Sends the latest count still held in the window, then stops; nothing is sent after this. */
  end(): void
}

/** Counts the entries an explorer delete or copy goes through and reports the running count, throttled
 *  for the trip to the renderer: the first report of a stage goes at once, then at most one per
 *  PROGRESS_INTERVAL_MS (about 4 a second) carrying the latest count. A throwing `emit` (the window
 *  went away) is swallowed by the throttle — progress never breaks the operation it describes. */
export function countFileOp(
  emit: (p: FileOpProgress) => void,
  intervalMs: number = PROGRESS_INTERVAL_MS
): FileOpCounter {
  const throttle = throttleProgress<FileOpProgress>(emit, intervalMs)
  let stage: FileOpStage | null = null
  let count = 0
  let ended = false
  return {
    entry(s) {
      if (ended) return
      if (s !== stage) {
        stage = s
        count = 0
      }
      count++
      throttle.push({ stage: s, count })
    },
    end() {
      if (ended) return
      ended = true
      throttle.flush()
      throttle.dispose()
    }
  }
}
