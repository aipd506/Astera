import { promises as fs, createReadStream, createWriteStream } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { git } from './git'
import { cancelledError, isCancelledError, throwIfCancelled } from './cancel'
import type { Message } from '../i18n'

export const INCLUDE_FILE = '.worktreeinclude'
const MAX_FILE_BYTES = 256 * 1024
const MAX_ENTRIES = 1000
const MAX_COPY_TOTAL_BYTES = 200 * 1024 * 1024
/** Files at or above this size are copied as a stream, so an abort can stop them part-way and the
 *  byte count moves while they copy. Smaller ones go through copyFile in one call. */
const STREAM_COPY_MIN_BYTES = 4 * 1024 * 1024

/** Only literal paths are allowed. globs, negations, absolute paths, .. and .git are warned about and skipped. */
export function parseWorktreeInclude(content: string): { entries: string[]; warnings: Message[] } {
  const entries: string[] = []
  const warnings: Message[] = []
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (entries.length >= MAX_ENTRIES) {
      warnings.push({ key: 'worktree.include.tooManyEntries', params: { max: MAX_ENTRIES } })
      break
    }
    if (line.includes('*') || line.includes('?') || line.startsWith('!')) {
      warnings.push({ key: 'worktree.include.globUnsupported', params: { line } })
      continue
    }
    const norm = line.replace(/\\/g, '/')
    if (path.isAbsolute(line) || /^[A-Za-z]:/.test(line)) {
      warnings.push({ key: 'worktree.include.absolutePath', params: { line } })
      continue
    }
    const segs = norm.split('/')
    if (segs.includes('..')) {
      warnings.push({ key: 'worktree.include.parentPath', params: { line } })
      continue
    }
    if (segs.includes('.git')) {
      warnings.push({ key: 'worktree.include.gitDir', params: { line } })
      continue
    }
    entries.push(norm.replace(/\/+$/, ''))
  }
  return { entries, warnings }
}

/** What one include entry would copy: its files (with sizes), its folders, and how many linked folders
 *  were left out. `rel` paths are relative to the measured root, with the platform separator. */
export interface TreePlan {
  files: Array<{ rel: string; size: number }>
  dirs: string[]
  bytes: number
  /** The walk stopped because `bytes` passed the limit. The plan is then incomplete on purpose. */
  over: boolean
  /** Linked folders (symlinks, junctions) found and not descended into. */
  linkedDirs: number
}

/** Walks a folder for copying, **bounded**:
 *
 *  - It never descends into a linked folder (symlink or junction). pnpm's node_modules is a tree of
 *    such links, and following them — with a realpath and a stat on every entry — made the size walk
 *    effectively unbounded. A linked folder is counted in `linkedDirs` and left out of the copy too, so
 *    what is measured and what is copied stay the same set (no cycle can form, so no realpath is needed).
 *  - A link to a **file** is followed (one stat, no walk): its target is what gets copied.
 *  - It stops the moment the byte count passes `limit` (`over`), instead of measuring everything.
 *  - It checks `signal` on every entry and throws WORKTREE_CANCELLED once it is aborted.
 *
 *  A broken link counts as nothing (it cannot be copied). A folder that cannot be read throws. */
export async function measureTree(
  root: string,
  opts: { limit?: number; signal?: AbortSignal } = {}
): Promise<TreePlan> {
  const limit = opts.limit ?? Infinity
  const plan: TreePlan = { files: [], dirs: [], bytes: 0, over: false, linkedDirs: 0 }
  const stack: string[] = ['']
  while (stack.length > 0) {
    throwIfCancelled(opts.signal)
    const relDir = stack.pop() as string
    const entries = await fs.readdir(path.join(root, relDir), { withFileTypes: true })
    for (const e of entries) {
      throwIfCancelled(opts.signal)
      const rel = relDir === '' ? e.name : path.join(relDir, e.name)
      const abs = path.join(root, rel)
      let size: number
      if (e.isDirectory()) {
        plan.dirs.push(rel)
        stack.push(rel)
        continue
      } else if (e.isFile()) {
        size = (await fs.lstat(abs)).size
      } else if (e.isSymbolicLink()) {
        let target
        try {
          target = await fs.stat(abs)
        } catch {
          continue // broken link — not copied, counts as nothing
        }
        if (target.isDirectory()) {
          plan.linkedDirs++
          continue
        }
        if (!target.isFile()) continue
        size = target.size
      } else {
        continue // sockets, fifos and the like are not copied
      }
      plan.files.push({ rel, size })
      plan.bytes += size
      if (plan.bytes > limit) {
        plan.over = true
        return plan
      }
    }
  }
  return plan
}

/** The byte size measureTree finds — linked folders not followed; stops early past `limit`. */
export async function dirSize(
  p: string,
  opts: { limit?: number; signal?: AbortSignal } = {}
): Promise<number> {
  return (await measureTree(p, opts)).bytes
}

/** Copy progress for one copyWorktreeInclude call. The first report is `{}` — the entries are being
 *  measured and there is nothing to count yet; every report after it carries all four numbers. */
export interface IncludeCopyProgress {
  bytesCopied?: number
  bytesTotal?: number
  filesCopied?: number
  filesTotal?: number
}

async function copyOneFile(
  src: string,
  dest: string,
  size: number,
  signal: AbortSignal | undefined,
  onBytes: (n: number) => void
): Promise<void> {
  if (size < STREAM_COPY_MIN_BYTES) {
    await fs.copyFile(src, dest)
    onBytes(size)
    return
  }
  const read = createReadStream(src)
  read.on('data', (chunk) => onBytes(chunk.length))
  try {
    await pipeline(read, createWriteStream(dest), signal ? { signal } : {})
  } catch (err) {
    if (signal?.aborted) throw cancelledError()
    throw err
  }
}

type PlannedEntry = { entry: string; src: string; dest: string; dir: boolean; plan: TreePlan }

/** Copies only the repo's .worktreeinclude entries that exist and are gitignored into the worktree. Returns the warning list.
 *
 *  Every entry is measured first (bounded — see measureTree), then everything is copied file by file, so
 *  `onProgress` can report bytes and files against known totals. A linked folder is never copied (a
 *  warning names the entry). `signal` stops the work between files, and inside a large one, with
 *  WORKTREE_CANCELLED; what was already copied is left to the caller's rollback, which removes the whole
 *  worktree. A copy failure of one entry is still only a warning. */
export async function copyWorktreeInclude(
  repoPath: string,
  worktreePath: string,
  opts: { signal?: AbortSignal; onProgress?: (p: IncludeCopyProgress) => void } = {}
): Promise<Message[]> {
  const { signal, onProgress } = opts
  const file = path.join(repoPath, INCLUDE_FILE)
  let content: string
  try {
    const stat = await fs.stat(file)
    if (stat.size > MAX_FILE_BYTES)
      return [{ key: 'worktree.include.fileTooLarge', params: { max: MAX_FILE_BYTES } }]
    content = await fs.readFile(file, 'utf8')
  } catch {
    return [] // no file = the convention is not in use
  }
  const { entries, warnings } = parseWorktreeInclude(content)
  onProgress?.({})
  let budget = MAX_COPY_TOTAL_BYTES
  const planned: PlannedEntry[] = []
  for (const entry of entries) {
    throwIfCancelled(signal)
    const src = path.join(repoPath, entry)
    let stat
    let linkedDir = false
    try {
      // The entry itself: a link to a file is followed, a link to a folder is not (see measureTree)
      const own = await fs.lstat(src)
      stat = own.isSymbolicLink() ? await fs.stat(src) : own
      linkedDir = own.isSymbolicLink() && stat.isDirectory()
    } catch {
      warnings.push({ key: 'worktree.include.missing', params: { entry } })
      continue
    }
    if (linkedDir) {
      warnings.push({ key: 'worktree.include.linkedDirSkipped', params: { entry, count: 1 } })
      continue
    }
    // copying a tracked file would overwrite what checkout produced, so only gitignored entries
    const check = await git(['check-ignore', '-q', entry], { cwd: repoPath, signal })
    throwIfCancelled(signal)
    if (!check.ok) {
      warnings.push({ key: 'worktree.include.notIgnored', params: { entry } })
      continue
    }
    let plan: TreePlan
    try {
      plan = stat.isDirectory()
        ? await measureTree(src, { limit: budget, signal })
        : { files: [{ rel: '', size: stat.size }], dirs: [], bytes: stat.size, over: stat.size > budget, linkedDirs: 0 }
    } catch (err) {
      if (isCancelledError(err)) throw err
      // a failure while measuring size (permission denied, deletion during the scan and other races) must not block creation itself
      warnings.push({
        key: 'worktree.include.sizeFailed',
        params: { entry, detail: err instanceof Error ? err.message : String(err) }
      })
      continue
    }
    if (plan.over) {
      warnings.push({ key: 'worktree.include.overLimit', params: { entry } })
      continue
    }
    if (plan.linkedDirs > 0)
      warnings.push({ key: 'worktree.include.linkedDirSkipped', params: { entry, count: plan.linkedDirs } })
    budget -= plan.bytes
    planned.push({ entry, src, dest: path.join(worktreePath, entry), dir: stat.isDirectory(), plan })
  }

  const progress: Required<IncludeCopyProgress> = {
    bytesCopied: 0,
    bytesTotal: planned.reduce((n, p) => n + p.plan.bytes, 0),
    filesCopied: 0,
    filesTotal: planned.reduce((n, p) => n + p.plan.files.length, 0)
  }
  const report = (): void => onProgress?.({ ...progress })
  report()
  for (const p of planned) {
    throwIfCancelled(signal)
    try {
      if (p.dir) {
        await fs.mkdir(p.dest, { recursive: true })
        for (const d of p.plan.dirs) await fs.mkdir(path.join(p.dest, d), { recursive: true })
      } else {
        await fs.mkdir(path.dirname(p.dest), { recursive: true })
      }
      for (const f of p.plan.files) {
        throwIfCancelled(signal)
        const from = p.dir ? path.join(p.src, f.rel) : p.src
        const to = p.dir ? path.join(p.dest, f.rel) : p.dest
        let seen = 0
        await copyOneFile(from, to, f.size, signal, (n) => {
          // a file that grew since it was measured must not push the count past the total
          const add = Math.max(0, Math.min(n, f.size - seen))
          seen += add
          progress.bytesCopied += add
          if (add > 0 && seen < f.size) report()
        })
        progress.bytesCopied += f.size - seen // a file that shrank still counts as done
        progress.filesCopied++
        report()
      }
    } catch (err) {
      if (isCancelledError(err)) throw err
      warnings.push({
        key: 'worktree.include.copyFailed',
        params: { entry: p.entry, detail: err instanceof Error ? err.message : String(err) }
      })
    }
  }
  return warnings
}
