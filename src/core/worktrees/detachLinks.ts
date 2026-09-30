// Takes every link out of a worktree before `git worktree remove` runs on it.
//
// Git for Windows' `worktree remove`, with or without --force, walks INTO a junction and deletes the
// contents of the folder it points at (measured with 2.45.1); a directory symlink it leaves alone. A
// worktree can hold a junction to a folder outside it for many reasons: pnpm lays out a workspace's
// node_modules that way on Windows, `npm link` makes one, a person makes one by hand. The removal then
// empties the main repo's package sources, a shared venv, a data folder.
//
// So every removal path in this codebase (the create rollback, the panel remove, the run-delete reap)
// calls detachLinks first: a walk of the worktree that never follows a link, removing each link itself
// (unlink, or rmdir on the link — never a recursive delete through it). Only when the walk finished
// does the caller run git. A walk that failed or ran past its deadline answers `ok: false`, and the
// caller must then leave the folder alone and say it was kept unverified: running git anyway is
// exactly the deletion this exists to prevent.
//
// Links are removed on every platform. On POSIX git does not follow them, but the worktree is about to
// go either way, and one rule is easier to trust than two.
import { promises as nodeFs } from 'node:fs'
import path from 'node:path'
import { FS_WORK_TIMEOUT_MS } from './fsWork'

/** How many entries one walk looks at before it gives up (and the caller keeps the folder). A large
 *  pnpm node_modules is a few hundred thousand. */
export const DETACH_MAX_ENTRIES = 2_000_000

/** The part of the fs the walk uses — injected by the tests. */
export interface DetachFs {
  lstat(p: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean }>
  readdir(dir: string): Promise<Array<{ name: string; isSymbolicLink(): boolean; isDirectory(): boolean }>>
  unlink(p: string): Promise<void>
  rmdir(p: string): Promise<void>
}

const realFs: DetachFs = {
  lstat: (p) => nodeFs.lstat(p),
  readdir: (d) => nodeFs.readdir(d, { withFileTypes: true }),
  unlink: (p) => nodeFs.unlink(p),
  rmdir: (p) => nodeFs.rmdir(p)
}

export type DetachResult = { ok: true; unlinked: number } | { ok: false; reason: string }

const codeOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code

/**
 * Removes every symlink and junction under `root`, without ever following one.
 *
 * - The walk is async, never follows a link, and is bounded by `maxEntries` and `timeoutMs`
 *   (FS_WORK_TIMEOUT_MS: this is mutating work, run outside the probe budget).
 * - An entry the directory listing calls a link is confirmed with lstat first. On Windows the listing
 *   calls every reparse point a link (a OneDrive placeholder too); only a real symlink or junction is
 *   removed, and a reparse-point folder that is neither is walked like a folder.
 * - A link is removed with unlink, falling back to rmdir on the link itself (a junction on some
 *   Windows setups); neither follows it.
 * - `keep(rel)` spares a link, by its path relative to `root` with `/` separators. The non-force panel
 *   remove spares git's own tracked symlinks, which git does not follow and whose removal would make
 *   the worktree dirty.
 * - A root that is not there answers ok (nothing to walk into). A root that is itself a link answers
 *   not ok: the folder to remove is not the folder it seems.
 * - After the deadline nothing more is removed, and the answer is not ok.
 */
export async function detachLinks(
  root: string,
  opts: { fs?: DetachFs; timeoutMs?: number; maxEntries?: number; keep?: (rel: string) => boolean } = {}
): Promise<DetachResult> {
  const fs = opts.fs ?? realFs
  const maxEntries = opts.maxEntries ?? DETACH_MAX_ENTRIES
  let stopped = false
  let unlinked = 0

  const walk = async (): Promise<DetachResult> => {
    try {
      const st = await fs.lstat(root)
      if (st.isSymbolicLink()) return { ok: false, reason: `the folder itself is a link: ${root}` }
      if (!st.isDirectory()) return { ok: false, reason: `not a folder: ${root}` }
    } catch (err) {
      if (codeOf(err) === 'ENOENT') return { ok: true, unlinked: 0 }
      return { ok: false, reason: `cannot read ${root}: ${String(err)}` }
    }
    let seen = 0
    const stack: string[] = [root]
    while (stack.length > 0) {
      if (stopped) return { ok: false, reason: 'stopped' }
      const dir = stack.pop() as string
      let entries
      try {
        entries = await fs.readdir(dir)
      } catch (err) {
        if (dir !== root && codeOf(err) === 'ENOENT') continue // vanished under us: nothing in it to reach
        return { ok: false, reason: `cannot list ${dir}: ${String(err)}` }
      }
      for (const e of entries) {
        if (stopped) return { ok: false, reason: 'stopped' }
        if (++seen > maxEntries) return { ok: false, reason: `more than ${maxEntries} entries` }
        const abs = path.join(dir, e.name)
        if (e.isSymbolicLink()) {
          let st
          try {
            st = await fs.lstat(abs)
          } catch (err) {
            if (codeOf(err) === 'ENOENT') continue
            return { ok: false, reason: `cannot read ${abs}: ${String(err)}` }
          }
          if (!st.isSymbolicLink()) {
            if (st.isDirectory()) stack.push(abs) // a reparse-point folder that is not a link: walked
            continue
          }
          const rel = path.relative(root, abs).split(path.sep).join('/')
          if (opts.keep?.(rel)) continue
          if (stopped) return { ok: false, reason: 'stopped' }
          try {
            await fs.unlink(abs)
          } catch (err) {
            if (codeOf(err) === 'ENOENT') continue
            try {
              await fs.rmdir(abs) // the link itself; rmdir never follows it
            } catch (err2) {
              return { ok: false, reason: `cannot remove the link ${abs}: ${String(err2)}` }
            }
          }
          unlinked++
        } else if (e.isDirectory()) {
          stack.push(abs)
        }
      }
    }
    return { ok: true, unlinked }
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<DetachResult>((resolve) => {
    timer = setTimeout(() => {
      stopped = true
      resolve({ ok: false, reason: `the link walk took longer than ${opts.timeoutMs ?? FS_WORK_TIMEOUT_MS}ms` })
    }, opts.timeoutMs ?? FS_WORK_TIMEOUT_MS)
  })
  try {
    return await Promise.race([
      walk().catch((err: unknown): DetachResult => ({ ok: false, reason: String(err) })),
      deadline
    ])
  } finally {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
