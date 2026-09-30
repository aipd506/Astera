// "Scanning Codex history… N/M" — the progress of reading rollout heads the index does not know yet.
//
// Only a scan that has real work to do is shown: a cwd lookup whose misses are fewer than `minTotal`
// finishes before a label could be read, and on a busy account a new rollout lands every few seconds
// (this app's own `codex exec` runs among them), so reporting every one would make the panel flicker.
// Several scans can overlap (two codex accounts, or a listing and an expansion); they are summed into
// one figure, and the label goes away when the last of them ends.

export interface ScanProgressEvent {
  active: boolean
  done: number
  total: number
}

export interface ScanHandle {
  tick(): void
  end(): void
}

const NOOP: ScanHandle = { tick: () => {}, end: () => {} }

export class ScanProgress {
  private scans = new Set<{ done: number; total: number }>()
  private done = 0
  private total = 0
  private lastEmit = 0

  constructor(
    private emit: (e: ScanProgressEvent) => void,
    private opts: { minTotal?: number; intervalMs?: number; now?: () => number } = {}
  ) {}

  /** Starts one scan of `total` files. Below the threshold it reports nothing at all. */
  begin(total: number): ScanHandle {
    if (total < (this.opts.minTotal ?? 20)) return NOOP
    const scan = { done: 0, total }
    this.scans.add(scan)
    this.total += total
    this.send(true)
    let ended = false
    return {
      tick: () => {
        if (ended) return
        scan.done++
        this.done++
        const now = (this.opts.now ?? Date.now)()
        if (now - this.lastEmit >= (this.opts.intervalMs ?? 250)) this.send(false)
      },
      end: () => {
        if (ended) return
        ended = true
        this.scans.delete(scan)
        if (this.scans.size > 0) return
        const final = { active: false, done: this.done, total: this.total }
        this.done = 0
        this.total = 0
        this.deliver(final)
      }
    }
  }

  private send(force: boolean): void {
    if (!force && this.scans.size === 0) return
    this.lastEmit = (this.opts.now ?? Date.now)()
    this.deliver({ active: true, done: this.done, total: this.total })
  }

  /** A listener that throws must not break the scan it is watching (R3: the scan's own promise is
   *  what the caller awaits). */
  private deliver(e: ScanProgressEvent): void {
    try {
      this.emit(e)
    } catch {
      /* the listener's problem, not the scan's */
    }
  }
}
