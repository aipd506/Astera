// What the explorer shows while a delete or a paste/copy is running (pure, no DOM — timers only, so it
// is tested with fake timers). Slow is acceptable; looking frozen is not: the row being worked on gets
// the shared spinner once the work has lasted ROW_SPINNER_DELAY_MS (the same delay as a folder's
// re-read spinner, so quick operations never blink), and a status line with the running count appears
// once it has lasted OP_STATUS_DELAY_MS.
import type { FileOpProgress, FileOpStage } from '../types'
import { createDelayedPending, ROW_SPINNER_DELAY_MS } from './dirReload'

/** How long an operation runs before the status line ("Deleting… N items") appears. */
export const OP_STATUS_DELAY_MS = 1000

export type FileOpKind = 'delete' | 'copy'

export interface FileOpStatus {
  kind: FileOpKind
  /** The stage main last reported (null until the first report arrives). */
  stage: FileOpStage | null
  /** Entries done in that stage so far — null until the call now running has reported, so the line
   *  never shows "0 items" at the start or the previous item's number while the next one is measured. */
  count: number | null
}

export interface FileOpBusyView {
  /** Rows showing the busy spinner. */
  rows: ReadonlySet<string>
  /** The status line, or null while it is not (yet) shown. */
  status: FileOpStatus | null
}

export interface FileOpBusy {
  /** An operation (a whole batch — one confirm, one paste) starts. */
  begin(kind: FileOpKind): void
  /** The next call of the batch starts, on these rows. The previous call's stage and count are
   *  dropped: they described another item. */
  rows(paths: Iterable<string>): void
  /** A progress report from main for the call now running. */
  progress(p: FileOpProgress): void
  /** The operation finished (or failed): spinner and status line go at once. */
  end(): void
  /** Drops every timer without reporting (unmount). */
  dispose(): void
}

export function createFileOpBusy(
  onChange: (view: FileOpBusyView) => void,
  o: { rowDelayMs?: number; statusDelayMs?: number } = {}
): FileOpBusy {
  const statusDelayMs = o.statusDelayMs ?? OP_STATUS_DELAY_MS
  let shownRows: ReadonlySet<string> = new Set()
  let status: FileOpStatus | null = null
  let statusShown = false
  let statusTimer: ReturnType<typeof setTimeout> | null = null
  const report = (): void =>
    onChange({ rows: shownRows, status: statusShown && status ? { ...status } : null })
  const delayed = createDelayedPending((shown) => {
    shownRows = shown
    report()
  }, o.rowDelayMs ?? ROW_SPINNER_DELAY_MS)
  const stopTimer = (): void => {
    if (statusTimer) clearTimeout(statusTimer)
    statusTimer = null
  }

  return {
    begin(kind) {
      stopTimer()
      status = { kind, stage: null, count: null }
      statusShown = false
      statusTimer = setTimeout(() => {
        statusTimer = null
        statusShown = true
        report()
      }, statusDelayMs)
    },
    rows(paths) {
      if (status && (status.stage !== null || status.count !== null)) {
        status = { ...status, stage: null, count: null }
        if (statusShown) report()
      }
      delayed.update(new Set(paths))
    },
    progress(p) {
      if (!status) return
      status = { ...status, stage: p.stage, count: p.count }
      if (statusShown) report()
    },
    end() {
      const wasShown = statusShown || shownRows.size > 0
      stopTimer()
      delayed.clear()
      shownRows = new Set()
      status = null
      statusShown = false
      if (wasShown) report()
    },
    dispose() {
      stopTimer()
      delayed.clear()
      shownRows = new Set()
      status = null
      statusShown = false
    }
  }
}
