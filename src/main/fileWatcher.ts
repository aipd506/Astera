import chokidar, { type FSWatcher } from 'chokidar'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { buildIgnoreMatcher } from '../core/files/tree'
import { createChangeBatcher, type ChangeBatcher, type FileChangeBatch, type FileChangeKind } from '../core/files/changeBatch'

export type { FileChange, FileChangeKind } from '../core/files/changeBatch'

/** Recursively watches one explorer root and emits changes. The watch exclusions are language-neutral
 *  (buildIgnoreMatcher).
 *
 *  chokidar, not the native recursive fs.watch HistoryIndex moved to. That move was worth 5.5s of
 *  startup there because the index only needs to know *that* some .jsonl changed; this has to tell
 *  add/change/unlink/addDir/unlinkDir apart and drop the ignored paths, and a native watcher reports
 *  only rename/change — no file-or-directory distinction, no filtering. The per-file walk that made
 *  chokidar expensive is exactly what lets it answer that, so it stays.
 *
 *  Events leave in batches (createChangeBatcher, FILE_CHANGE_BATCH_MS): one IPC message per window
 *  instead of one per event, so a git checkout or npm install in the watched folder is a handful of
 *  messages rather than thousands. */
export class FileWatcher {
  private watcher: FSWatcher | null = null
  private root: string | null = null
  // watch/unwatch serialisation chain — even when the calls overlap (fire-and-forget IPC, StrictMode double
  // invocation), it stops this.watcher being overwritten and leaking the previous chokidar instance without a close. Same pattern as HistoryIndex.reloading.
  private ops: Promise<void> = Promise.resolve()

  private batcher: ChangeBatcher

  constructor(
    emit: (batch: FileChangeBatch) => void,
    private log: (m: string) => void = () => {}
  ) {
    this.batcher = createChangeBatcher(emit)
  }

  watch(root: string): Promise<void> {
    const p = this.ops.then(() => this.doWatch(root))
    this.ops = p.catch(() => {}) // Keeps the chain uncontaminated — one failed operation must not block later watch/unwatch calls
    return p
  }

  unwatch(): Promise<void> {
    const p = this.ops.then(() => this.close())
    this.ops = p.catch(() => {})
    return p
  }

  private async doWatch(root: string): Promise<void> {
    if (this.root === root && this.watcher) return // A repeat request for the same root is ignored
    await this.close()
    this.root = root
    let gitignore: string | null = null
    try {
      gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8')
    } catch {
      /* No .gitignore — the curated list only */
    }
    const ignored = buildIgnoreMatcher(gitignore)
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ignored: (p: string) => ignored(path.relative(root, p))
    })
    const kinds: FileChangeKind[] = ['add', 'change', 'unlink', 'addDir', 'unlinkDir']
    for (const kind of kinds) this.watcher.on(kind, (p: string) => this.batcher.push({ path: p, kind }))
    this.watcher.on('error', (e) => this.log(`watch error: ${e instanceof Error ? e.message : String(e)}`))
  }

  async close(): Promise<void> {
    // What the closing watcher already saw still goes out — an open buffer must not miss its last change
    this.batcher.flush()
    await this.watcher?.close().catch(() => {})
    this.watcher = null
    this.root = null
  }
}
