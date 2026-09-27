import { parentDir } from './paths'

export type FileChangeKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
export interface FileChange {
  path: string
  kind: FileChangeKind
}

/** One window's worth of watcher events, sent to the renderer as a single IPC message.
 *  `parents` is what the tree needs — the folders whose listing may have changed, deduplicated
 *  (a content `change` does not alter a listing, so it adds no parent). `changes` is what the open
 *  buffers and the run-config detection need — each path once, with its latest kind. */
export interface FileChangeBatch {
  parents: string[]
  changes: FileChange[]
}

/** How long watcher events are collected before one batch goes out. Long enough that a
 *  `git checkout` or `npm install` (thousands of events in a burst) becomes a handful of messages,
 *  short enough that a single save still shows up in the tree without a visible lag. */
export const FILE_CHANGE_BATCH_MS = 100

/** Folds a window of events into a batch. The same path seen several times keeps its latest kind
 *  (in the position it first appeared) — unlink then add is a recreation, and what the renderer
 *  wants is the state now. */
export function toBatch(events: readonly FileChange[]): FileChangeBatch {
  const byPath = new Map<string, FileChangeKind>()
  const parents = new Set<string>()
  for (const e of events) {
    byPath.set(e.path, e.kind)
    if (e.kind !== 'change') parents.add(parentDir(e.path))
  }
  return {
    parents: [...parents],
    changes: [...byPath].map(([path, kind]) => ({ path, kind }))
  }
}

export interface ChangeBatcher {
  push: (change: FileChange) => void
  /** Sends whatever is collected now and closes the window (unwatch, root switch). */
  flush: () => void
}

/** Collects events into fixed windows. The window opens on the first event and closes
 *  `delayMs` later — not a debounce that restarts on every event, which would hold the tree
 *  still for as long as an `npm install` keeps writing. A throwing `send` (the window already
 *  gone) is swallowed here, inside the timer callback, so it cannot surface as an uncaught error
 *  and does not stop the next window. */
export function createChangeBatcher(
  send: (batch: FileChangeBatch) => void,
  delayMs: number = FILE_CHANGE_BATCH_MS
): ChangeBatcher {
  let pending: FileChange[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (pending.length === 0) return
    const events = pending
    pending = []
    try {
      send(toBatch(events))
    } catch {
      /* the receiver is gone — nothing to deliver to */
    }
  }
  return {
    push: (change) => {
      pending.push(change)
      if (!timer) timer = setTimeout(flush, delayMs)
    },
    flush
  }
}
