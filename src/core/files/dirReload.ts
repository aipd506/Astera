/** Per-folder single flight for the explorer's directory reads.
 *
 *  A watcher batch, a toggle and a refresh can all ask for the same folder while a read of it is
 *  still out — on a shared drive a readdir can take seconds. Running them side by side wastes the
 *  drive and lets an older answer land after a newer one. So: at most one read per folder at a time,
 *  and a request that arrives during a read turns into exactly one more read after it (however many
 *  arrived), because the running read may already have passed the change that triggered them.
 *
 *  `onChange` reports the set of folders being read — the explorer's loading indicator. A folder stays
 *  in it across the follow-up read, so the spinner does not blink off and on between the two. */
export interface DirLoadQueue {
  request: (dir: string) => void
  isPending: (dir: string) => boolean
}

export function createDirLoadQueue(
  load: (dir: string) => Promise<void>,
  onChange?: (pending: ReadonlySet<string>) => void
): DirLoadQueue {
  const running = new Set<string>()
  const again = new Set<string>()
  const notify = (): void => onChange?.(new Set(running))

  const start = (dir: string): void => {
    let p: Promise<void>
    try {
      p = load(dir)
    } catch (e) {
      p = Promise.reject(e)
    }
    // Both outcomes end the same way; a failed read is the loader's to report (it caches the error
    // for the tree), so the rejection is consumed here and never goes unhandled.
    const done = (): void => {
      if (again.delete(dir)) start(dir)
      else {
        running.delete(dir)
        notify()
      }
    }
    p.then(done, done)
  }

  return {
    request: (dir) => {
      if (running.has(dir)) {
        again.add(dir)
        return
      }
      running.add(dir)
      notify()
      start(dir)
    },
    isPending: (dir) => running.has(dir)
  }
}

/** Which folders one watcher batch re-reads. Only folders already in the cache matter (an uncached
 *  one is read fresh when it is first expanded). Of those, the root and the expanded folders are on
 *  screen and are re-read; a collapsed folder is not re-read now — its cache is dropped instead, so
 *  expanding it later reads it fresh rather than showing a listing from before the change. Each
 *  folder appears once however often the batch names it. */
export function planBatchReload(
  parents: readonly string[],
  o: { root: string; isCached: (dir: string) => boolean; isExpanded: (dir: string) => boolean }
): { reload: string[]; evict: string[] } {
  const reload: string[] = []
  const evict: string[] = []
  for (const dir of new Set(parents)) {
    if (!o.isCached(dir)) continue
    if (dir === o.root || o.isExpanded(dir)) reload.push(dir)
    else evict.push(dir)
  }
  return { reload, evict }
}
