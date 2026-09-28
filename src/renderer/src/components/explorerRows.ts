// The explorer tree as a flat list of rows, and the windowing maths that picks which of them to draw.
// A folder with thousands of entries used to render every row, and every watcher batch re-rendered all
// of them; now the tree renders only the rows in the viewport plus OVERSCAN on each side. Pure functions,
// so the traversal and the window can be pinned down by unit tests (the renderer tests run in node,
// with no DOM).
import type { DirState, Entry } from '../hooks/useFileTree'
import type { Editing } from '../hooks/useFileOps'

/** A tree row's height. Every row (entry, note, root reading) is drawn at exactly this height — the
 *  stylesheet does not decide it, the row's inline style does — so the offsets below are the truth. */
export const ROW_H = 22
/** The inline edit row (new file / rename): the input needs a little more than a plain row */
export const EDIT_H = 26
/** Extra height of the edit row while its invalid-name reason is shown under the input */
export const EDIT_REASON_H = 16
/** Rows drawn beyond each edge of the viewport, so a fast scroll does not show blank space first */
export const OVERSCAN = 8
/** The viewport height assumed before the tree has been measured (the first render) */
export const DEFAULT_VIEWPORT_H = 600

/** The key of the new-file / new-folder edit row under dirPath. A rename row keeps the entry's own path as its key. */
export const createRowKey = (dirPath: string): string => `create:${dirPath}`

/** The key of the row that is being edited, or null — what the tree keeps rendered and scrolls into view */
export function editRowKey(editing: Editing): string | null {
  if (!editing) return null
  return editing.kind === 'create' ? createRowKey(editing.parentDir) : editing.path
}

export type TreeRow =
  | { kind: 'entry'; key: string; entry: Entry; depth: number; open: boolean }
  | { kind: 'edit'; key: string; depth: number; isDir: boolean }
  | { kind: 'note'; key: string; depth: number; note: 'loading' | 'readFailed' | 'empty'; detail?: string }
  | { kind: 'rootReading'; key: string; depth: number }

/** The visible tree as rows, in the order the tree used to render them: a folder's create row first,
 *  then its entries, each expanded folder's children right after it (so the entry rows are exactly
 *  flattenVisible's order, which Shift ranges use). A folder with no listing yet, a failed read or no
 *  entries gets one note row. A renamed entry becomes the edit row in its own place. */
export function buildTreeRows(
  root: string,
  dirs: Record<string, DirState>,
  expanded: ReadonlySet<string>,
  editing: Editing,
  /** Whether the root's first read has been out longer than ROOT_SLOW_MS. Before that RootReading draws
   *  nothing, so no row is reserved for it either (a blank 22px line at the top would be all it showed). */
  opts: { rootSlow?: boolean } = {}
): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (dirPath: string, depth: number): void => {
    if (editing?.kind === 'create' && editing.parentDir === dirPath)
      rows.push({ kind: 'edit', key: createRowKey(dirPath), depth, isDir: editing.isDir })
    const state = dirs[dirPath]
    if (!state) {
      if (dirPath === root) {
        if (opts.rootSlow) rows.push({ kind: 'rootReading', key: 'rootReading:', depth })
      }
      else rows.push({ kind: 'note', key: `note:${dirPath}`, depth, note: 'loading' })
      return
    }
    if (state.error) {
      rows.push({ kind: 'note', key: `note:${dirPath}`, depth, note: 'readFailed', detail: state.error })
      return
    }
    if (!state.entries || state.entries.length === 0) {
      rows.push({ kind: 'note', key: `note:${dirPath}`, depth, note: 'empty' })
      return
    }
    for (const entry of state.entries) {
      const open = entry.isDir && expanded.has(entry.path)
      if (editing?.kind === 'rename' && editing.path === entry.path)
        rows.push({ kind: 'edit', key: entry.path, depth, isDir: entry.isDir })
      else rows.push({ kind: 'entry', key: entry.path, entry, depth, open })
      if (open) walk(entry.path, depth + 1)
    }
  }
  walk(root, 0)
  return rows
}

/** The paths of the entry rows, in order — what keyboard movement walks over */
export function entryPaths(rows: readonly TreeRow[]): string[] {
  const out: string[] = []
  for (const r of rows) if (r.kind === 'entry') out.push(r.entry.path)
  return out
}

/** Index of the row showing this path (an entry, or the rename row standing in its place); -1 if none */
export function indexOfPath(rows: readonly TreeRow[], path: string): number {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (r.kind === 'entry' ? r.entry.path === path : r.kind === 'edit' && r.key === path) return i
  }
  return -1
}

/** Row tops: offsets[i] is row i's top, offsets[rows.length] the total height. editTall — the edit
 *  row is showing its reason line. */
export function rowOffsets(rows: readonly TreeRow[], editTall: boolean): number[] {
  const out = new Array<number>(rows.length + 1)
  let y = 0
  for (let i = 0; i < rows.length; i++) {
    out[i] = y
    y += rows[i].kind === 'edit' ? EDIT_H + (editTall ? EDIT_REASON_H : 0) : ROW_H
  }
  out[rows.length] = y
  return out
}

/** First index i in [0, n] with offsets[i] > y (offsets ascending) */
function firstAbove(offsets: readonly number[], y: number, n: number): number {
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] > y) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** The rows to draw, [start, end): those overlapping [scrollTop, scrollTop + viewportH), widened by
 *  overscan rows on each side */
export function visibleRange(
  offsets: readonly number[],
  scrollTop: number,
  viewportH: number,
  overscan: number
): { start: number; end: number } {
  const n = offsets.length - 1
  if (n <= 0) return { start: 0, end: 0 }
  // the first row whose bottom is below scrollTop: bottoms are offsets[1..n]
  const first = Math.min(n, firstAbove(offsets, scrollTop, n + 1) - 1)
  // the first row whose top is at or past the viewport's bottom
  const bottom = scrollTop + viewportH
  let past = firstAbove(offsets, bottom - 1e-9, n + 1)
  past = Math.min(n, Math.max(first + 1, past))
  return { start: Math.max(0, first - overscan), end: Math.min(n, past + overscan) }
}

/** The scrollTop that brings row index into view with the least movement: unchanged if it is already
 *  wholly visible, its top at the viewport's top if it is above, its bottom at the viewport's bottom if
 *  it is below. */
export function revealScrollTop(
  offsets: readonly number[],
  index: number,
  scrollTop: number,
  viewportH: number
): number {
  const top = offsets[index]
  const bottom = offsets[index + 1]
  if (top < scrollTop) return top
  if (bottom > scrollTop + viewportH) return Math.max(0, bottom - viewportH)
  return scrollTop
}

export type CursorKey = 'up' | 'down' | 'home' | 'end' | 'pageUp' | 'pageDown'

/** Where a keyboard move lands, over the entry rows' paths. With no current row (or one that has gone)
 *  the move starts from the first row — End from the last. Stops at the ends; null only for no rows. */
export function moveCursor(
  paths: readonly string[],
  current: string | null,
  key: CursorKey,
  pageSize: number
): string | null {
  const n = paths.length
  if (n === 0) return null
  if (key === 'home') return paths[0]
  if (key === 'end') return paths[n - 1]
  const i = current === null ? -1 : paths.indexOf(current)
  if (i < 0) return paths[0]
  const step = Math.max(1, pageSize)
  const delta = key === 'down' ? 1 : key === 'up' ? -1 : key === 'pageDown' ? step : -step
  return paths[Math.min(n - 1, Math.max(0, i + delta))]
}

/** The row indices to draw, ascending: the window [start, end) plus the pinned rows outside it — the
 *  rows that must stay mounted wherever the scroll is. Ascending, so every row keeps one place among its
 *  siblings and React never has to move (or re-parent) a mounted row. */
export function drawnRows(range: { start: number; end: number }, pinned: readonly number[]): number[] {
  const out: number[] = []
  const outside = [...new Set(pinned)].filter((i) => i < range.start || i >= range.end).sort((a, b) => a - b)
  let pi = 0
  for (let i = range.start; i < range.end; i++) {
    while (pi < outside.length && outside[pi] < i) out.push(outside[pi++])
    out.push(i)
  }
  while (pi < outside.length) out.push(outside[pi++])
  return out
}

/** A reveal waiting for its row: the row's key, and the time (ms) after which it is given up */
export interface PendingReveal {
  key: string
  until: number
}

/** What to do with a pending reveal after a render. Expiry is checked first: a reveal whose row turns up
 *  only after the wait (a paste into a collapsed folder, expanded much later) must not jump the view,
 *  so it is dropped without scrolling. Otherwise the row's index to scroll to (done), or keep waiting. */
export function resolveReveal(
  rows: readonly TreeRow[],
  reveal: PendingReveal,
  now: number
): { index: number; done: boolean } {
  if (now > reveal.until) return { index: -1, done: true }
  const index = rows.findIndex((r) => r.key === reveal.key)
  return index >= 0 ? { index, done: true } : { index: -1, done: false }
}

/** The row a keyboard move starts from: the moving end of the last keyboard move while it is still
 *  selected, else the anchor while it is still listed, else the last selected path in tree order.
 *  null when nothing is selected — the move then starts at the first row (moveCursor). */
export function cursorOrigin(
  paths: readonly string[],
  selection: ReadonlySet<string>,
  anchor: string | null,
  cursor: string | null
): string | null {
  if (cursor !== null && selection.has(cursor) && paths.includes(cursor)) return cursor
  if (anchor !== null && paths.includes(anchor)) return anchor
  for (let i = paths.length - 1; i >= 0; i--) if (selection.has(paths[i])) return paths[i]
  return null
}
