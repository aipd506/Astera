import { promises as fs, createReadStream, createWriteStream } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { git } from './git'
import { comparablePath, isPathWithin } from '../files/tree'
import { createProber } from '../sessions/pathProbe'
import { cancelledError, isCancelledError, throwIfCancelled } from './cancel'
import type { Message } from '../i18n'

export const INCLUDE_FILE = '.worktreeinclude'
const MAX_FILE_BYTES = 256 * 1024
const MAX_ENTRIES = 1000
const MAX_COPY_TOTAL_BYTES = 200 * 1024 * 1024
/** Files at or above this size are copied as a stream, so an abort can stop them part-way and the
 *  byte count moves while they copy. Smaller ones go through copyFile in one call. */
const STREAM_COPY_MIN_BYTES = 4 * 1024 * 1024
/** How many entries one include walk looks at before it gives up on the entry (see measureTree). */
export const MAX_WALK_ENTRIES = 200_000

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

/** Drops entries another entry already covers, and duplicates: with both `a` and `a/x/y` listed, `a`
 *  copies `a/x/y` already, and copying it again as its own entry would write into a tree that may by
 *  then hold a recreated link (see copyWorktreeInclude). Compared by segment, with `.` segments dropped
 *  and case folded where the file system folds it; the first spelling of a kept entry wins. */
export function collapseIncludeEntries(entries: string[], platform: string = process.platform): string[] {
  const fold = platform === 'win32' || platform === 'darwin'
  const keyOf = (e: string): string => {
    const k = e.split('/').filter((seg) => seg !== '' && seg !== '.').join('/')
    return fold ? k.toLowerCase() : k
  }
  const keys = entries.map(keyOf)
  const all = new Set(keys)
  const coveredByOther = (k: string): boolean => {
    const segs = k.split('/')
    for (let i = 1; i < segs.length; i++) if (all.has(segs.slice(0, i).join('/'))) return true
    return false
  }
  const seen = new Set<string>()
  const out: string[] = []
  entries.forEach((e, i) => {
    const k = keys[i]
    if (seen.has(k) || coveredByOther(k)) return
    seen.add(k)
    out.push(e)
  })
  return out
}

/** Writes inside the worktree only through real folders.
 *
 *  Before anything is written — a folder, a file, a link — its folder is walked from the worktree root
 *  down with lstat, never following a link: every component must be a real folder, and a missing one is
 *  made (non-recursively) as a real folder. A link or junction on the way — one the checkout placed (a
 *  tracked symlink), or one an earlier entry recreated — would carry the write outside the worktree,
 *  usually onto the source itself; the first such component is returned instead, and nothing is made
 *  past it. A component that is a file throws (mkdir would), which the copy reports as copyFailed.
 *
 *  Verified folders are remembered for the whole copy, so each is checked once. Folders this call made
 *  are appended to `made`, for the caller's cleanup. */
function createSafeDirs(root: string): { ensure(dir: string, made: string[]): Promise<string | null> } {
  const verified = new Set<string>()
  return {
    async ensure(dir, made) {
      const rel = path.relative(root, dir)
      if (rel === '') return null
      if (rel.startsWith('..') || path.isAbsolute(rel)) return dir
      let at = root
      for (const seg of rel.split(path.sep)) {
        at = path.join(at, seg)
        const key = comparablePath(at)
        if (verified.has(key)) continue
        let st
        try {
          st = await fs.lstat(at)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
          try {
            await fs.mkdir(at)
            made.push(at)
          } catch (mkErr) {
            if ((mkErr as NodeJS.ErrnoException).code !== 'EEXIST') throw mkErr
          }
          st = await fs.lstat(at) // made here, or by someone else a moment ago: checked the same way
        }
        if (st.isSymbolicLink()) return at
        if (!st.isDirectory()) throw Object.assign(new Error(`ENOTDIR: not a folder: ${at}`), { code: 'ENOTDIR' })
        verified.add(key)
      }
      return null
    }
  }
}

/** A link found in a walk: where it sits, what it says (readlink, as written), and whether it leads to a
 *  folder. It is recreated as a link, never followed. */
export interface TreeLink {
  rel: string
  raw: string
  isDir: boolean
}

/** What one include entry would copy: its files (with sizes), its folders and its links. `rel` paths are
 *  relative to the measured root, with the platform separator. */
export interface TreePlan {
  files: Array<{ rel: string; size: number }>
  dirs: string[]
  links: TreeLink[]
  bytes: number
  /** The walk stopped early — past the byte limit, or past the entry limit (`overEntries`). The plan is
   *  then incomplete on purpose. */
  over: boolean
  overEntries: boolean
}

/** Walks a folder for copying, **bounded**:
 *
 *  - It never follows a link (symlink or junction), to a folder or to a file. pnpm's node_modules is a
 *    tree of such links, and following them — a realpath and a stat on every entry — made the walk
 *    effectively unbounded. A link is recorded as it is written (readlink) and counted as 0 bytes; the
 *    copy recreates it as a link (copyWorktreeInclude). One stat tells a folder link from a file link.
 *  - It stops the moment the byte count passes `limit`, or the number of entries seen passes
 *    `maxEntries` (MAX_WALK_ENTRIES by default) — hundreds of thousands of empty files are no cheaper to
 *    walk than a big one.
 *  - It checks `signal` on every entry and throws WORKTREE_CANCELLED once it is aborted.
 *
 *  A broken link is left out (there is nothing to copy it as). A folder that cannot be read throws. */
export async function measureTree(
  root: string,
  opts: { limit?: number; maxEntries?: number; signal?: AbortSignal } = {}
): Promise<TreePlan> {
  const limit = opts.limit ?? Infinity
  const maxEntries = opts.maxEntries ?? MAX_WALK_ENTRIES
  const plan: TreePlan = { files: [], dirs: [], links: [], bytes: 0, over: false, overEntries: false }
  let seen = 0
  const stack: string[] = ['']
  while (stack.length > 0) {
    throwIfCancelled(opts.signal)
    const relDir = stack.pop() as string
    const entries = await fs.readdir(path.join(root, relDir), { withFileTypes: true })
    for (const e of entries) {
      throwIfCancelled(opts.signal)
      if (++seen > maxEntries) {
        plan.over = true
        plan.overEntries = true
        return plan
      }
      const rel = relDir === '' ? e.name : path.join(relDir, e.name)
      const abs = path.join(root, rel)
      if (e.isDirectory()) {
        plan.dirs.push(rel)
        stack.push(rel)
      } else if (e.isFile()) {
        const size = (await fs.lstat(abs)).size
        plan.files.push({ rel, size })
        plan.bytes += size
        if (plan.bytes > limit) {
          plan.over = true
          return plan
        }
      } else if (e.isSymbolicLink()) {
        try {
          const raw = await fs.readlink(abs)
          const isDir = (await fs.stat(abs)).isDirectory()
          plan.links.push({ rel, raw, isDir })
        } catch {
          // broken link — nothing to recreate it as
        }
      }
      // sockets, fifos and the like are not copied
    }
  }
  return plan
}

/** The byte size measureTree finds — links not followed; stops early past `limit`. */
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

/** Makes one link — fs.symlink by default; a test seam. */
export type MakeLink = (target: string, linkPath: string, type: 'file' | 'dir' | 'junction') => Promise<void>

/** Where a copied link should point, and as what.
 *
 *  A link whose target lies inside the entry being copied is pointed at the same place **in the copy** —
 *  a relative link keeps its text (it resolves the same way from the copy), an absolute one is rewritten.
 *  A link pointing outside the entry keeps pointing at the same place, written absolute so that moving
 *  it into the worktree does not change what a relative text resolves to. On Windows a folder link is
 *  made as a junction, which needs no privilege but must be absolute. The entry's real path is checked
 *  as well as the given one: a junction's text is always a real, absolute path. */
export function linkTargetFor(a: {
  srcRoot: string
  srcRootReal: string
  destRoot: string
  linkAbs: string
  raw: string
  isDir: boolean
  platform?: NodeJS.Platform
}): { target: string; type: 'file' | 'dir' | 'junction' } {
  const platform = a.platform ?? process.platform
  const resolved = path.resolve(path.dirname(a.linkAbs), a.raw)
  const type = a.isDir ? (platform === 'win32' ? 'junction' : 'dir') : 'file'
  let rel: string | null = null
  if (a.linkAbs !== a.srcRoot) {
    if (isPathWithin(a.srcRoot, resolved, platform)) rel = path.relative(a.srcRoot, resolved)
    else if (isPathWithin(a.srcRootReal, resolved, platform)) rel = path.relative(a.srcRootReal, resolved)
  }
  if (rel === null) return { target: resolved, type }
  const mapped = path.join(a.destRoot, rel)
  if (type === 'junction' || path.isAbsolute(a.raw)) return { target: mapped, type }
  return { target: a.raw, type }
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

type PlannedEntry = {
  entry: string
  src: string
  dest: string
  kind: 'dir' | 'file' | 'link'
  plan: TreePlan
}

/** A link that could not be recreated. The whole entry is then taken out again and skipped: a
 *  node_modules with its package links missing looks installed and is not. */
class LinkFailed extends Error {}

/** Copies only the repo's .worktreeinclude entries that exist and are gitignored into the worktree. Returns the warning list.
 *
 *  Every entry is measured first (bounded — see measureTree), then copied: folders, then links, then the
 *  files one by one, so `onProgress` can report bytes and files against known totals. Links are
 *  recreated as links (linkTargetFor), 0 bytes each; a file link that needs a privilege the user lacks
 *  (EPERM, Windows without Developer Mode) is copied as the file instead. Any other failure to make a
 *  link skips the whole entry, with what was already made of it removed. `signal` stops the work between
 *  files, and inside a large one, with WORKTREE_CANCELLED; what was already copied is left to the
 *  caller's rollback, which removes the whole worktree. Any other copy failure of one entry is still only
 *  a warning. */
export async function copyWorktreeInclude(
  repoPath: string,
  worktreePath: string,
  opts: {
    signal?: AbortSignal
    onProgress?: (p: IncludeCopyProgress) => void
    makeLink?: MakeLink
  } = {}
): Promise<Message[]> {
  const { signal, onProgress } = opts
  const makeLink: MakeLink = opts.makeLink ?? ((t, p, type) => fs.symlink(t, p, type))
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
  const parsed = parseWorktreeInclude(content)
  const { warnings } = parsed
  const entries = collapseIncludeEntries(parsed.entries)
  onProgress?.({})
  let budget = MAX_COPY_TOTAL_BYTES
  const planned: PlannedEntry[] = []
  for (const entry of entries) {
    throwIfCancelled(signal)
    const src = path.join(repoPath, entry)
    let own
    let target
    try {
      own = await fs.lstat(src)
      target = own.isSymbolicLink() ? await fs.stat(src) : own // a broken link is "missing"
    } catch {
      warnings.push({ key: 'worktree.include.missing', params: { entry } })
      continue
    }
    // copying a tracked file would overwrite what checkout produced, so only gitignored entries
    const check = await git(['check-ignore', '-q', entry], { cwd: repoPath, signal })
    throwIfCancelled(signal)
    if (!check.ok) {
      warnings.push({ key: 'worktree.include.notIgnored', params: { entry } })
      continue
    }
    const dest = path.join(worktreePath, entry)
    const empty = (): TreePlan => ({ files: [], dirs: [], links: [], bytes: 0, over: false, overEntries: false })
    let plan: TreePlan
    let kind: PlannedEntry['kind']
    try {
      if (own.isSymbolicLink()) {
        // the entry itself is a link: recreated as one, never followed
        kind = 'link'
        plan = { ...empty(), links: [{ rel: '', raw: await fs.readlink(src), isDir: target.isDirectory() }] }
      } else if (own.isDirectory()) {
        kind = 'dir'
        plan = await measureTree(src, { limit: budget, signal })
      } else {
        kind = 'file'
        plan = { ...empty(), files: [{ rel: '', size: own.size }], bytes: own.size, over: own.size > budget }
      }
    } catch (err) {
      if (isCancelledError(err)) throw err
      // a failure while measuring size (permission denied, deletion during the scan and other races) must not block creation itself
      warnings.push({
        key: 'worktree.include.sizeFailed',
        params: { entry, detail: err instanceof Error ? err.message : String(err) }
      })
      continue
    }
    if (plan.overEntries) {
      warnings.push({ key: 'worktree.include.overFileCount', params: { entry, max: MAX_WALK_ENTRIES } })
      continue
    }
    if (plan.over) {
      warnings.push({ key: 'worktree.include.overLimit', params: { entry } })
      continue
    }
    budget -= plan.bytes
    planned.push({ entry, src, dest, kind, plan })
  }

  const progress: Required<IncludeCopyProgress> = {
    bytesCopied: 0,
    bytesTotal: planned.reduce((n, p) => n + p.plan.bytes, 0),
    filesCopied: 0,
    filesTotal: planned.reduce((n, p) => n + p.plan.files.length, 0)
  }
  const report = (): void => onProgress?.({ ...progress })
  // The cleanup after a failed link: what this call made of the entry, newest first — files and links
  // unlinked, folders removed only when empty. Never a recursive delete: the checkout's own files can
  // share those folders. One time-limited call for the lot.
  let undo: string[] = []
  const cleanupProbe = createProber({
    access: async () => {
      for (const x of [...undo].reverse()) {
        const st = await fs.lstat(x).catch(() => null)
        if (!st) continue
        if (st.isDirectory()) await fs.rmdir(x).catch(() => {})
        else await fs.unlink(x).catch(() => {})
      }
    },
    skipQueue: true
  })
  const safeDirs = createSafeDirs(worktreePath)
  report()
  for (const p of planned) {
    throwIfCancelled(signal)
    const at = {
      bytes: progress.bytesCopied,
      files: progress.filesCopied,
      bytesTotal: progress.bytesTotal,
      filesTotal: progress.filesTotal
    }
    const made: string[] = []
    undo = made
    /** Links found on the way (absolute), each reported once; everything under one is skipped. */
    const blocked: string[] = []
    const warnBlocked = (bad: string): void => {
      blocked.push(bad)
      warnings.push({
        key: 'worktree.include.unsafeDest',
        params: { entry: p.entry, path: path.relative(worktreePath, bad).split(path.sep).join('/') }
      })
    }
    const reach = async (dir: string): Promise<boolean> => {
      if (blocked.some((b) => isPathWithin(b, dir))) return false
      const bad = await safeDirs.ensure(dir, made)
      if (bad === null) return true
      if (!blocked.some((b) => isPathWithin(b, bad))) warnBlocked(bad)
      return false
    }
    /** The file itself must not be a link: copying onto one writes to its target. */
    const fileIsSafe = async (to: string): Promise<boolean> => {
      const st = await fs.lstat(to).catch(() => null)
      if (!st?.isSymbolicLink()) return true
      warnBlocked(to)
      return false
    }
    try {
      if (p.kind === 'dir') {
        if (await reach(p.dest)) for (const d of p.plan.dirs) await reach(path.join(p.dest, d))
      } else {
        await reach(path.dirname(p.dest))
      }
      if (p.plan.links.length > 0) {
        // An entry that is itself a link has nothing "inside" it — its target keeps pointing where it did
        const srcRootReal = p.kind === 'link' ? p.src : await fs.realpath(p.src).catch(() => p.src)
        for (const l of p.plan.links) {
          throwIfCancelled(signal)
          const linkAbs = l.rel === '' ? p.src : path.join(p.src, l.rel)
          const linkDest = l.rel === '' ? p.dest : path.join(p.dest, l.rel)
          if (!(await reach(path.dirname(linkDest)))) continue
          const { target, type } = linkTargetFor({
            srcRoot: p.src, srcRootReal, destRoot: p.dest, linkAbs, raw: l.raw, isDir: l.isDir
          })
          try {
            await makeLink(target, linkDest, type)
            made.push(linkDest)
          } catch (err) {
            // A file link the user lacks the privilege for (EPERM: Windows without Developer Mode) is
            // copied as the file instead. That one file is outside the byte budget and the progress
            // totals, which count links as 0 — it is one file, not a walk.
            if (type === 'file' && (err as NodeJS.ErrnoException).code === 'EPERM') {
              if (!(await fileIsSafe(linkDest))) continue
              try {
                await fs.copyFile(linkAbs, linkDest)
                made.push(linkDest)
                continue
              } catch (copyErr) {
                throw new LinkFailed(copyErr instanceof Error ? copyErr.message : String(copyErr))
              }
            }
            throw new LinkFailed(err instanceof Error ? err.message : String(err))
          }
        }
      }
      for (const f of p.plan.files) {
        throwIfCancelled(signal)
        const from = p.kind === 'dir' ? path.join(p.src, f.rel) : p.src
        const to = p.kind === 'dir' ? path.join(p.dest, f.rel) : p.dest
        if (!(await reach(path.dirname(to))) || !(await fileIsSafe(to))) {
          // not written: out of the totals, so the bar still ends full
          progress.bytesTotal -= f.size
          progress.filesTotal--
          report()
          continue
        }
        let seen = 0
        made.push(to)
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
      if (err instanceof LinkFailed) {
        // take out what this call made of the entry, and its share of the totals — no half-copied entry.
        // Time-limited: a root that stopped answering costs the probe limit, not a hang.
        await cleanupProbe(p.dest)
        progress.bytesCopied = at.bytes
        progress.filesCopied = at.files
        progress.bytesTotal = at.bytesTotal - p.plan.bytes
        progress.filesTotal = at.filesTotal - p.plan.files.length
        report()
        warnings.push({ key: 'worktree.include.linkFailed', params: { entry: p.entry, detail: err.message } })
        continue
      }
      warnings.push({
        key: 'worktree.include.copyFailed',
        params: { entry: p.entry, detail: err instanceof Error ? err.message : String(err) }
      })
    }
  }
  return warnings
}
