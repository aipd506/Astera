import { promises as fs } from 'node:fs'
import path from 'node:path'
import { buildIgnoreMatcher } from '../core/files/tree'
import { filterFilePaths } from '../core/files/fileMatch'

/** How many files one project's list holds. A repository larger than this is answered from the first
 *  slice of its walk, which is breadth-first, so what is missing is the deepest corners rather than
 *  an arbitrary tail. Big enough for every repository on this machine, small enough that the walk and
 *  the filter both stay off anyone's critical path. */
const MAX_FILES = 20_000

/** How long a walked list is reused. Long enough that typing a name never re-walks, short enough that
 *  a file created a moment ago shows up without anyone restarting anything. */
const TTL_MS = 30_000

/** How long `lookup` waits for a walk it started before answering with what it has. A small project
 *  finishes well inside this, so its menu never flashes "indexing"; a large one or a slow share answers
 *  at once with a partial list and says it is still indexing. */
const GRACE_MS = 150

/** How many entries the walk handles between turns it gives the event loop. A folder of thousands of
 *  files comes back from one readdir, and filtering it is a synchronous loop on main. */
const YIELD_EVERY = 500

/** The part of a Dirent the walk reads — what a test's in-memory tree has to provide. */
export interface DirEntry {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}

export interface FileIndexDeps {
  readdir?: (abs: string) => Promise<DirEntry[]>
  readFile?: (abs: string) => Promise<string>
  /** See GRACE_MS. */
  graceMs?: number
}

interface Entry {
  paths: string[]
  at: number
}

/** A walk under way: `found` grows as it goes (the partial list `lookup` answers with), `done` settles
 *  once with the whole list and never rejects. */
interface Walk {
  found: string[]
  done: Promise<string[]>
}

export interface FileIndexAnswer {
  paths: string[]
  /** True while the first walk of this root is still under way and `paths` is only what it has found
   *  so far. A refresh of a stale list is not "indexing": the stale list answers in the meantime. */
  indexing: boolean
}

export interface FileIndex {
  /** The best `limit` matches for `query` under `root`, as root-relative paths with forward slashes.
   *  An unreadable root answers an empty list rather than throwing: the caller is drawing a menu.
   *  Waits for a current list (joining a walk already under way). */
  search(root: string, query: string, limit: number): Promise<string[]>
  /** The same matches, answered now for a menu that is open: a current list if there is one; else the
   *  stale list while a refresh runs; else, when the first walk has not finished within a short grace
   *  period, what it has found so far with `indexing` set. Never rejects. */
  lookup(root: string, query: string, limit: number): Promise<FileIndexAnswer>
}

/**
 * The list of files a project offers to `@`.
 *
 * Walked breadth-first and filtered by the same matcher the file watcher uses — the curated list of
 * heavy directories plus the root .gitignore — so what is offered is what a person would call part of
 * the project, not a `node_modules` tree twenty times its size.
 *
 * One walk per root at a time: a search that arrives while one is under way awaits that walk rather
 * than starting its own.
 */
export function createFileIndex(now: () => number = Date.now, deps: FileIndexDeps = {}): FileIndex {
  const readdir =
    deps.readdir ?? ((abs: string) => fs.readdir(abs, { withFileTypes: true }) as Promise<DirEntry[]>)
  const readFile = deps.readFile ?? ((abs: string) => fs.readFile(abs, 'utf8'))
  const graceMs = deps.graceMs ?? GRACE_MS
  const cache = new Map<string, Entry>()
  const inflight = new Map<string, Walk>()

  const walk = async (root: string, out: string[]): Promise<void> => {
    let gitignore: string | null = null
    try {
      gitignore = await readFile(path.join(root, '.gitignore'))
    } catch {
      /* No .gitignore — the curated list only, exactly as the watcher does */
    }
    const ignored = buildIgnoreMatcher(gitignore)
    // Breadth-first, so a cap cuts the deepest corners rather than everything after one large folder.
    // Read by an index, never shifted: shift() moves the whole array each time, which made the walk
    // quadratic in the folder count. The folders already read stay in the array — strings, and at
    // most as many as the tree has folders.
    const queue: string[] = ['']
    let next = 0
    let sinceYield = 0
    while (next < queue.length && out.length < MAX_FILES) {
      const rel = queue[next++]
      let entries: DirEntry[]
      try {
        entries = await readdir(path.join(root, rel))
      } catch {
        continue // a folder that vanished or cannot be read is not worth failing the whole walk for
      }
      for (const entry of entries) {
        if (++sinceYield >= YIELD_EVERY) {
          sinceYield = 0
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        const child = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (ignored(child)) continue
        if (entry.isDirectory()) queue.push(child)
        else if (entry.isFile()) {
          out.push(child)
          if (out.length >= MAX_FILES) break
        }
      }
    }
  }

  /** The walk of this root under way, or a new one. Its `done` never rejects; on settling it fills the
   *  cache and leaves `inflight`. */
  const walkOf = (root: string): Walk => {
    const running = inflight.get(root)
    if (running) return running
    const found: string[] = []
    const done = walk(root, found)
      .then(
        () => found,
        () => [] as string[]
      )
      .then((paths) => {
        cache.set(root, { paths, at: now() })
        inflight.delete(root)
        return paths
      })
    const w: Walk = { found, done }
    inflight.set(root, w)
    return w
  }

  const fresh = (root: string): string[] | null => {
    const cached = cache.get(root)
    return cached && now() - cached.at < TTL_MS ? cached.paths : null
  }

  return {
    async search(root, query, limit) {
      if (root === '') return []
      const paths = fresh(root) ?? (await walkOf(root).done)
      return filterFilePaths(paths, query, limit)
    },
    async lookup(root, query, limit) {
      if (root === '') return { paths: [], indexing: false }
      const current = fresh(root)
      if (current) return { paths: filterFilePaths(current, query, limit), indexing: false }
      const w = walkOf(root)
      let timer: ReturnType<typeof setTimeout> | null = null
      const grace = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), graceMs)
      })
      const finished = await Promise.race([w.done, grace])
      if (timer) clearTimeout(timer)
      if (finished) return { paths: filterFilePaths(finished, query, limit), indexing: false }
      const stale = cache.get(root)
      if (stale) return { paths: filterFilePaths(stale.paths, query, limit), indexing: false }
      return { paths: filterFilePaths(w.found, query, limit), indexing: true }
    }
  }
}
