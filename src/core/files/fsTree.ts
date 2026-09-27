// Removing and copying whole trees for the explorer (main only — it uses node:fs, so it is not in
// tsconfig.web). fs.rm(recursive) and fs.cp say nothing until they finish, and on a folder of tens of
// thousands of small files that is long enough for the explorer to look frozen; these do the same work
// and report each entry as it is done, so main can pass a running count to the renderer. All async:
// this runs in main, where a sync walk would freeze every window.
//
// **Each operation asks its roots once through the probe budget first** (gateRoot, stage 4 T1). Async
// is not enough on its own: every call here runs on the libuv threadpool, outside the budget, and on a
// dead share each one can hold a thread for as long as SMB takes — four of them stop every async fs
// call in the process. A root that does not answer, or that the budget already holds as stuck, is
// refused with ROOT_UNREACHABLE before any call: nothing is copied, snapshotted or removed. The
// per-entry calls are not gated one by one; a root that just answered is alive.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FileOpStage } from '../types'
import type { HistoryEntry } from './localHistory'
import { gateRoot, type Probe } from '../sessions/pathProbe'

/** How many entries of one folder are removed at once. Sequential unlinks are slow on a big folder;
 *  unbounded ones open thousands of handles at a time. Sub-folders are still walked one at a time,
 *  so the total stays at this. */
const REMOVE_CHUNK = 16

const tick = (onEntry: (() => void) | undefined): void => {
  if (!onEntry) return
  try {
    onEntry()
  } catch {
    // the progress receiver is gone — the removal goes on
  }
}

/** The single-entry removal removeTree uses — fs.rm; replaceable so a test can make one entry fail. */
export interface RemoveTreeDeps {
  rm: typeof fs.rm
  /** The probe the target is asked through first (the budgeted session-folder probe by default). */
  gate?: Probe
}

/** The first failure of a removal. Kept rather than thrown so the walk goes on to the siblings. */
interface FirstError {
  failed: boolean
  error?: unknown
}
const note = (f: FirstError, error: unknown): void => {
  if (f.failed) return
  f.failed = true
  f.error = error
}

/** Removes everything under dir. Like fs.rm(recursive), a failing entry (a locked file, a permission
 *  error) does not stop the rest: every sibling and every other sub-folder is still tried, and the
 *  first failure is recorded in f for the caller to throw once the walk is over. A folder whose
 *  children did not all go is left in place (removing it would fail anyway). */
async function removeChildren(
  dir: string,
  onEntry: (() => void) | undefined,
  d: RemoveTreeDeps,
  f: FirstError
): Promise<void> {
  let list
  try {
    list = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    note(f, err)
    return
  }
  const leaves: string[] = []
  for (const e of list) {
    const child = path.join(dir, e.name)
    // Only a real directory is walked into. A symbolic link or a Windows junction to a directory is
    // not isDirectory() on its dirent, so it lands with the leaves and only the link itself is
    // removed — the same rule as fs.rm, which never deletes through a link.
    if (e.isDirectory()) {
      const sub: FirstError = { failed: false }
      await removeChildren(child, onEntry, d, sub)
      if (sub.failed) {
        note(f, sub.error)
        continue
      }
      try {
        await d.rm(child, { recursive: true })
        tick(onEntry)
      } catch (err) {
        note(f, err)
      }
    } else leaves.push(child)
  }
  for (let i = 0; i < leaves.length; i += REMOVE_CHUNK) {
    const results = await Promise.allSettled(
      leaves.slice(i, i + REMOVE_CHUNK).map((p) => d.rm(p, { recursive: true }).then(() => tick(onEntry)))
    )
    // Every rejection is consumed here; only the first is kept to report.
    for (const r of results) if (r.status === 'rejected') note(f, r.reason)
  }
}

/** fs.rm(target, { recursive: true }), reporting every entry it removes (the target itself last).
 *  Each single removal is still fs.rm, so its Windows handling (a read-only file, a directory link)
 *  is exactly what it was. A missing target rejects with ENOENT, as fs.rm does. When some entries
 *  cannot be removed, everything else still is, and the first failure is thrown at the end. */
export async function removeTree(
  target: string,
  onEntry?: () => void,
  deps: RemoveTreeDeps = { rm: fs.rm }
): Promise<void> {
  await gateRoot(target, deps.gate)
  const st = await fs.lstat(target)
  if (st.isDirectory()) {
    const f: FirstError = { failed: false }
    await removeChildren(target, onEntry, deps, f)
    if (f.failed) throw f.error
  }
  await deps.rm(target, { recursive: true })
  tick(onEntry)
}

/** fs.cp(from, to, { recursive: true, errorOnExist: true, force: false }) — the explorer's copy, which
 *  never overwrites — reporting each entry as it is reached (fs.cp's filter hook, which here only
 *  counts and always answers yes, so what is copied is unchanged). */
export async function copyTree(from: string, to: string, onEntry?: () => void, gate?: Probe): Promise<void> {
  // Both ends: a copy between two drives touches both, and either may be the dead one.
  await gateRoot(from, gate)
  await gateRoot(path.dirname(to), gate)
  await fs.cp(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    ...(onEntry
      ? {
          filter: () => {
            tick(onEntry)
            return true
          }
        }
      : {})
  })
}

/** The Local History store's part in a delete (LocalHistoryStore; an interface so a failure can be staged). */
export interface SnapshotHistory {
  snapshot(
    projectPath: string,
    targetPath: string,
    isDir: boolean,
    opts?: { onEntry?: () => void }
  ): Promise<HistoryEntry | null>
  discard(projectPath: string, id: string): Promise<void>
}

/** files.remove after its path checks: the snapshot taken just before deleting, then the delete.
 *  Deletion is still permanent — Local History is not a recycle bin but the safety net in front of
 *  one, so a skipped snapshot (over the byte or the entry cap → 'too-large') or a failed one (a
 *  permissions error, … → 'failed') does not block the delete; the reason is returned and the renderer
 *  tells the user. onEntry hears each entry copied ('snapshot') and then each removed ('delete'). */
export async function removeWithSnapshot(o: {
  projectRoot: string
  targetPath: string
  history: SnapshotHistory
  onEntry?: (stage: FileOpStage) => void
  /** The probe the target is asked through first (the budgeted session-folder probe by default). */
  gate?: Probe
}): Promise<{ snapshotSkipped: 'too-large' | 'failed' | null; snapshotId: string | null }> {
  const { projectRoot, targetPath, history, onEntry, gate } = o
  // Before the snapshot, not only before the delete: a target that does not answer is neither
  // snapshotted nor deleted — "could not check" never proceeds to a delete.
  await gateRoot(targetPath, gate)
  let snapshotSkipped: 'too-large' | 'failed' | null = null
  let snapshotId: string | null = null
  let isDir = false
  try {
    isDir = (await fs.stat(targetPath)).isDirectory()
    const entry = await history.snapshot(projectRoot, targetPath, isDir, {
      onEntry: onEntry && (() => onEntry('snapshot'))
    })
    if (entry === null) snapshotSkipped = 'too-large'
    else snapshotId = entry.id
  } catch {
    snapshotSkipped = 'failed'
  }
  try {
    await removeTree(targetPath, onEntry && (() => onEntry('delete')), { rm: fs.rm, ...(gate ? { gate } : {}) })
  } catch (err) {
    // Even when the delete fails the snapshot is already committed to the index — leaving it means a
    // file that was not deleted shows up in Local History as "deleted", and pressing restore creates a
    // duplicate next to the original.
    // A file: deleting a single entry is atomic, so on failure the original is intact → discard the
    // snapshot, nothing is lost. A folder: a recursive delete can fail after deleting some children, so
    // discarding the snapshot would lose the only copy of children that are already gone → leave the
    // snapshot in place.
    // A failed discard is swallowed too — it must not mask the original failure.
    if (snapshotId !== null && !isDir) {
      await history.discard(projectRoot, snapshotId).catch(() => {})
    }
    throw err
  }
  return { snapshotSkipped, snapshotId }
}
