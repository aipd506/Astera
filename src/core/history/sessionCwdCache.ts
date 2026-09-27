// Persisted `session file → cwd` memo (main only — it uses node:fs, so it is not in tsconfig.web).
//
// Only a provider whose folder name does not carry the project needs this. claude reads the cwd off
// at most 8 files per slug folder because the folder *is* the project; codex folders are dates, so
// "which projects exist" can only be answered by opening every rollout file. That made the codex
// project list cost grow linearly with the total number of sessions, on every single app start.
//
// A session file is append-only and the cwd sits in its head, so a hit stays valid for the whole life
// of the file. (mtimeMs, size) is still the key rather than the path alone: rolling relays copy
// transcripts between accounts, and a replaced file has to miss.
//
// **It is also the codex rollout index** (stage 4). Opening a codex project used to parse every
// rollout in every date folder (head + 256 KB tail) just to throw away the ones of other projects. The
// cwd this memo already holds says which files belong to the project, so an expansion now builds only
// those — and the row it builds (sessionId, title, awaitingReply) is kept here too, under the same
// (mtimeMs, size) key, so an unchanged file is not parsed again even after a restart. A row is a
// function of the file's bytes, and the key changes whenever the bytes do, so a hit is never stale.
// ROW_VERSION guards against the parser's rules changing between builds: a row written under another
// version is dropped at load (its cwd is kept — how the cwd is read has not changed).
//
// Entries of files that no longer exist are dropped by `prune`, which the codex strategy calls with
// the complete live file set of one scan root after each full listing.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { foldPathCase, legacyFoldedKey } from '../files/paths'

// The same rule as `norm` in index.ts, so a key survives a drive-letter or separator difference
// between two runs: resolved, and case-folded where the platform ignores case (foldPathCase).
//
// Older builds folded case on every platform, so on linux the file can hold `/a/x.jsonl` for
// `/a/X.jsonl`. get also tries that key — a hit still has to match (mtimeMs, size), so a legacy row
// of a different file that only shares the lower-cased name misses as it should. set writes the exact
// key and leaves the old row alone: it is a cache, the row costs a few bytes, and MAX_ENTRIES prunes it
// in time. Nothing changes on win32 or darwin.

/** [mtimeMs, size, cwd], or with the expansion row appended: [..., ROW_VERSION, sessionId, title,
 *  awaitingReply 0|1]. A null cwd is stored too, on purpose — a non-conversation record never gains
 *  one, and leaving it out would mean re-reading exactly those files on every pass. */
type CwdEntry = [number, number, string | null]
type RowEntry = [number, number, string, number, string, string, 0 | 1]
type Entry = CwdEntry | RowEntry

/** Bumped whenever what buildEntry derives from a rollout changes, so rows of an older build are
 *  rebuilt rather than trusted. */
export const ROW_VERSION = 1

/** What a codex project expansion shows for one rollout, besides its path and mtime. */
export interface RolloutRow {
  sessionId: string
  title: string
  awaitingReply: boolean
}

// Bound on the file. Only a history larger than this is pruned, and the pruning keeps the newest
// mtimes — the ones a project list actually reads.
const MAX_ENTRIES = 10_000

function isValidCwdPart(v: unknown[]): boolean {
  return (
    typeof v[0] === 'number' &&
    Number.isFinite(v[0]) &&
    typeof v[1] === 'number' &&
    Number.isFinite(v[1]) &&
    (v[2] === null || typeof v[2] === 'string')
  )
}

/** A stored value as this build reads it: a valid row, its cwd part alone when the row is from
 *  another version or malformed, or null when not even the cwd part is usable. */
function readEntry(v: unknown): Entry | null {
  if (!Array.isArray(v) || (v.length !== 3 && v.length !== 7) || !isValidCwdPart(v)) return null
  const cwdPart: CwdEntry = [v[0] as number, v[1] as number, v[2] as string | null]
  if (v.length === 3) return cwdPart
  const rowOk =
    v[3] === ROW_VERSION &&
    typeof v[2] === 'string' &&
    typeof v[4] === 'string' &&
    typeof v[5] === 'string' &&
    (v[6] === 0 || v[6] === 1)
  return rowOk ? (v as RowEntry) : cwdPart
}

export class SessionCwdCache {
  private map = new Map<string, Entry>()
  private dirty = false

  constructor(
    private filePath: string,
    private platform: string = process.platform,
    /** **Read-only: the file is read at load and never written** — neither by flush nor by the
     *  `.bak` a corrupt file gets. For the Host (host/projectRoots.ts), which lists the same projects
     *  with Astera closed: the file is the app's, and a second writer could interleave with the app's
     *  own flush. A miss is still parsed and remembered in memory, for the life of this object. */
    private opts: { readOnly?: boolean } = {}
  ) {}

  private keyOf(p: string): string {
    return foldPathCase(path.resolve(p), this.platform)
  }

  /** Same contract as the other stores: absent = empty, corrupt = keep a .bak and start empty. A
   *  cache is not worth failing startup over, so neither case throws. */
  async load(): Promise<{ recovered: boolean }> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('invalid schema')
      }
      for (const [k, v] of Object.entries(parsed)) {
        const entry = readEntry(v)
        if (entry) this.map.set(k, entry) // a single bad row is dropped, not fatal
      }
      return { recovered: false }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { recovered: false }
      if (!this.opts.readOnly) await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.map.clear()
      return { recovered: true }
    }
  }

  /** The memoized cwd, or undefined on a miss. A hit can legitimately be null (no cwd in the file),
   *  which is why a miss is undefined rather than null. */
  get(filePath: string, mtimeMs: number, size: number): string | null | undefined {
    return this.hit(filePath, mtimeMs, size)?.[2]
  }

  private hit(filePath: string, mtimeMs: number, size: number): Entry | undefined {
    const key = this.keyOf(filePath)
    const legacy = legacyFoldedKey(key, this.platform)
    const hit = this.map.get(key) ?? (legacy === null ? undefined : this.map.get(legacy))
    if (!hit || hit[0] !== mtimeMs || hit[1] !== size) return undefined
    return hit
  }

  /** Records the cwd. A row already stored under the same key and the same cwd is kept — the codex
   *  listing re-reports cwds it did not have to parse, and must not undo what an expansion built. */
  set(filePath: string, mtimeMs: number, size: number, cwd: string | null): void {
    const key = this.keyOf(filePath)
    const cur = this.map.get(key)
    if (cur && cur[0] === mtimeMs && cur[1] === size && cur[2] === cwd) return
    this.map.set(key, [mtimeMs, size, cwd])
    this.dirty = true
  }

  /** The expansion row, or undefined when the file changed or only its cwd is known. */
  getRow(filePath: string, mtimeMs: number, size: number): (RolloutRow & { cwd: string }) | undefined {
    const hit = this.hit(filePath, mtimeMs, size)
    if (!hit || hit.length !== 7) return undefined
    return { cwd: hit[2], sessionId: hit[4], title: hit[5], awaitingReply: hit[6] === 1 }
  }

  setRow(filePath: string, mtimeMs: number, size: number, cwd: string, row: RolloutRow): void {
    this.map.set(this.keyOf(filePath), [
      mtimeMs,
      size,
      cwd,
      ROW_VERSION,
      row.sessionId,
      row.title,
      row.awaitingReply ? 1 : 0
    ])
    this.dirty = true
  }

  /** Drops every entry under `root` whose file is not in `livePaths` — the complete set of files a
   *  listing of that root just found. Entries under other roots (another account, the other provider)
   *  are left alone. Returns how many were dropped. In memory only when read-only, like everything. */
  prune(root: string, livePaths: Iterable<string>): number {
    const base = this.keyOf(root)
    const prefix = base.endsWith(path.sep) ? base : base + path.sep
    const live = new Set<string>()
    for (const p of livePaths) live.add(this.keyOf(p))
    let dropped = 0
    for (const key of [...this.map.keys()]) {
      if (!key.startsWith(prefix) || live.has(key)) continue
      this.map.delete(key)
      dropped++
    }
    if (dropped > 0) this.dirty = true
    return dropped
  }

  /** Writes once per pass, and only when something was actually added. A write failure is swallowed —
   *  the next start just pays the parse again. */
  async flush(): Promise<void> {
    if (!this.dirty || this.opts.readOnly) return
    this.dirty = false
    if (this.map.size > MAX_ENTRIES) {
      const kept = [...this.map.entries()].sort((a, b) => b[1][0] - a[1][0]).slice(0, MAX_ENTRIES)
      this.map = new Map(kept)
    }
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      await fs.writeFile(this.filePath, JSON.stringify(Object.fromEntries(this.map)), 'utf8')
    } catch {
      /* a cache write failure must not break the project list */
    }
  }
}
