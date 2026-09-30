// The one way the app and the Host write their log files (stage 3, task 3).
//
// A line used to be one `appendFileSync` — a synchronous open, write and close on the caller's thread,
// which on a profile folder an antivirus scans or OneDrive syncs is exactly the kind of stall that makes
// a window look frozen. Now a line goes into memory, and the file sees one asynchronous append per
// flush: every LOG_FLUSH_MS, or sooner once LOG_FLUSH_BYTES are waiting. The size is read once and then
// tracked in memory, so there is no `stat` per line either; a file that would pass LOG_MAX_BYTES is
// renamed to `<name>.1` (one old file, never more) and a new one is started.
//
// **Exit is the one synchronous moment.** `flushAllLogsSync` writes whatever is still buffered, and it
// runs from the process's `exit` event and from the quit paths (the app's before-quit and will-quit, the
// Host's leave), so the last lines of a run are not lost to the timer. A SIGKILL still loses at most
// one timer's worth.
//
// **Never throws, never rejects.** A write that fails is dropped and noted once per kind on stderr —
// never into a log, so logging about logging cannot loop.
//
// Imports only node builtins: both the app and the Host use it.
import * as nodeFs from 'node:fs'
import path from 'node:path'

/** A file's cap. A flush that would pass it rotates the file first. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024
/** How long a line waits in memory at most before its flush starts. */
export const LOG_FLUSH_MS = 200
/** A buffer this large flushes without waiting for the timer. */
export const LOG_FLUSH_BYTES = 64 * 1024
/** A disk that cannot keep up must not grow the heap without end: past this, new lines are dropped. */
export const LOG_MAX_PENDING_BYTES = 4 * 1024 * 1024
/** A rotation that failed (a `.1` another program holds open) is not tried again for this long. */
export const LOG_ROTATE_RETRY_MS = 60_000

/** The fs calls the writer makes, injectable for tests. */
export interface LogFs {
  appendFile(p: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  stat(p: string): Promise<{ size: number }>
  mkdir(p: string): Promise<unknown>
  appendFileSync(p: string, data: string): void
  renameSync(from: string, to: string): void
  statSync(p: string): { size: number }
  mkdirSync(p: string): unknown
}

const realFs: LogFs = {
  appendFile: (p, data) => nodeFs.promises.appendFile(p, data, 'utf8'),
  rename: (a, b) => nodeFs.promises.rename(a, b),
  stat: (p) => nodeFs.promises.stat(p),
  mkdir: (p) => nodeFs.promises.mkdir(p, { recursive: true }),
  appendFileSync: (p, data) => nodeFs.appendFileSync(p, data, 'utf8'),
  renameSync: (a, b) => nodeFs.renameSync(a, b),
  statSync: (p) => nodeFs.statSync(p),
  mkdirSync: (p) => nodeFs.mkdirSync(p, { recursive: true })
}

export interface LogWriter {
  readonly path: string
  /** Buffers one already-formatted chunk (a line with its `\n`). Touches no fs. Never throws. */
  write(chunk: string): void
  /** Starts a flush now and resolves once everything buffered before this call is written or dropped.
   *  Never rejects. */
  flush(): Promise<void>
  /** Writes what is buffered, synchronously. For exit only. Never throws. */
  flushSync(): void
}

export interface LogWriterOptions {
  path: string
  maxBytes?: number
  flushMs?: number
  flushBytes?: number
  /** Make the parent directory (once) before the first write. */
  ensureDir?: boolean
  fs?: LogFs
  /** Test injection for the rotation backoff's clock. */
  now?: () => number
}

const noted = new Set<string>()

/** One stderr line per kind of failure for the life of the process. Never throws, never logs. */
function note(op: string, file: string, err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code
  const kind = `${op}:${typeof code === 'string' ? code : err instanceof Error ? err.name : typeof err}`
  if (noted.has(kind)) return
  noted.add(kind)
  say(`[astera log] ${op} failed (${kind.slice(op.length + 1)}) for ${path.basename(file)}; later lines of this kind are dropped silently\n`)
}

/** One line on stderr. Never throws, never logs. */
function say(line: string): void {
  try {
    process.stderr.write(line)
  } catch {
    /* nowhere left to say it */
  }
}

/** Test hook: forget which kinds were already noted. */
export function _resetLogErrorNotesForTests(): void {
  noted.clear()
}

const isMissing = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 'ENOENT'

export function createLogWriter(o: LogWriterOptions): LogWriter {
  const file = o.path
  const fs = o.fs ?? realFs
  const maxBytes = o.maxBytes ?? LOG_MAX_BYTES
  const flushMs = o.flushMs ?? LOG_FLUSH_MS
  const flushBytes = o.flushBytes ?? LOG_FLUSH_BYTES

  let buf: string[] = []
  let bufBytes = 0
  /** Null until the first flush has read it. */
  let size: number | null = null
  let dirMade = !o.ensureDir
  let timer: ReturnType<typeof setTimeout> | null = null
  let chain: Promise<void> = Promise.resolve()
  let queued = false
  /** True while an async drain is between its take and its append (review I1). */
  let draining = false
  const now = o.now ?? Date.now
  /** A rename that failed (a locked .1, say) is not tried again before this time (review M3). */
  let rotateBlockedUntil = 0
  /** Inside a spell of failing renames: noted once at its start, not per attempt. */
  let rotateFailing = false
  const rotationAllowed = (): boolean => now() >= rotateBlockedUntil
  const rotated = (): void => {
    rotateFailing = false
    rotateBlockedUntil = 0
  }
  const rotationFailed = (err: unknown): void => {
    rotateBlockedUntil = now() + LOG_ROTATE_RETRY_MS
    if (rotateFailing) return
    rotateFailing = true
    const code = (err as { code?: unknown } | null)?.code
    say(`[astera log] could not rotate ${path.basename(file)} (${typeof code === 'string' ? code : 'error'}); it grows past its cap, next try in ${LOG_ROTATE_RETRY_MS / 1000} s\n`)
  }

  const take = (): { data: string; bytes: number } | null => {
    if (buf.length === 0) return null
    const data = buf.join('')
    buf = []
    bufBytes = 0
    return { data, bytes: Buffer.byteLength(data, 'utf8') }
  }

  const drain = async (): Promise<void> => {
    const t = take()
    if (!t) return
    if (!dirMade) {
      dirMade = true
      await fs.mkdir(path.dirname(file)).catch((err) => note('mkdir', file, err))
    }
    if (size === null) {
      size = await fs.stat(file).then(
        (s) => s.size,
        (err) => {
          if (!isMissing(err)) note('stat', file, err)
          return 0
        }
      )
    }
    if (size > 0 && size + t.bytes > maxBytes && rotationAllowed()) {
      // Read once more before renaming: another process that writes the same file (the Host and the
      // app share rolling.log and slack.log) may have rotated it already. Only at the cap, so rare.
      const actual = await fs.stat(file).then(
        (s) => s.size,
        () => 0
      )
      if (actual > 0 && actual + t.bytes > maxBytes) {
        try {
          await fs.rename(file, `${file}.1`)
          rotated()
          size = 0
        } catch (err) {
          rotationFailed(err)
          size = actual
        }
      } else size = actual
    }
    try {
      await fs.appendFile(file, t.data)
      size += t.bytes
    } catch (err) {
      note('append', file, err)
    }
  }

  const runDrain = async (): Promise<void> => {
    draining = true
    try {
      await drain()
    } finally {
      draining = false
    }
  }

  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!queued) {
      queued = true
      chain = chain
        .then(() => {
          queued = false
          return runDrain()
        })
        .catch((err) => note('flush', file, err))
    }
    return chain
  }

  const flushSync = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const t = take()
    if (!t) return
    try {
      if (!dirMade) {
        dirMade = true
        try {
          fs.mkdirSync(path.dirname(file))
        } catch (err) {
          note('mkdir', file, err)
        }
      }
      if (size === null) {
        try {
          size = fs.statSync(file).size
        } catch (err) {
          if (!isMissing(err)) note('stat', file, err)
          size = 0
        }
      }
      // **Not while an async drain is in flight** (review I1): that drain may be about to rename this
      // file, and lines appended here would go to .1 with it — or its own append would land in a file
      // this rename just emptied. Skipping costs one flush's worth past the cap, once.
      if (!draining && size > 0 && size + t.bytes > maxBytes && rotationAllowed()) {
        // Re-read first, as the async path does (review M2): another process may have rotated it.
        let actual = 0
        try {
          actual = fs.statSync(file).size
        } catch {
          actual = 0
        }
        if (actual > 0 && actual + t.bytes > maxBytes) {
          try {
            fs.renameSync(file, `${file}.1`)
            rotated()
            size = 0
          } catch (err) {
            rotationFailed(err)
            size = actual
          }
        } else size = actual
      }
      fs.appendFileSync(file, t.data)
      size += t.bytes
    } catch (err) {
      note('append', file, err)
    }
  }

  return {
    path: file,
    write(chunk) {
      try {
        if (bufBytes + chunk.length > LOG_MAX_PENDING_BYTES) {
          note('buffer', file, Object.assign(new Error('full'), { code: 'FULL' }))
          return
        }
        buf.push(chunk)
        bufBytes += chunk.length
        if (bufBytes >= flushBytes) void flush()
        else if (!timer) {
          timer = setTimeout(() => {
            timer = null
            void flush()
          }, flushMs)
          timer.unref?.()
        }
      } catch {
        /* a log line never costs its caller anything */
      }
    },
    flush,
    flushSync
  }
}

const writers = new Map<string, LogWriter>()
const keyOf = (p: string): string => {
  const r = path.resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

/** The process's one writer for this file, so every logger of one file shares one order and one size.
 *  Registered for `flushAllLogsSync`, and the process's exit hook is installed with the first one. */
export function logWriterFor(p: string, opts: Omit<LogWriterOptions, 'path'> = {}): LogWriter {
  const key = keyOf(p)
  let w = writers.get(key)
  if (!w) {
    w = createLogWriter({ ...opts, path: p })
    writers.set(key, w)
    installExitFlush(process)
  }
  return w
}

/** A logger in the format every log of the app has used: `<ISO time> <message>\n`. Never throws. */
export function lineLog(p: string, opts: Omit<LogWriterOptions, 'path'> = {}): (m: string) => void {
  const w = logWriterFor(p, opts)
  return (m) => {
    try {
      w.write(`${new Date().toISOString()} ${m}\n`)
    } catch {
      /* never */
    }
  }
}

/** Every shared writer's buffer drained, and every append already in flight awaited (review I1). For a
 *  way out that can wait — the Host's `leave` awaits this (capped) before its final `flushAllLogsSync`,
 *  so no sync line races an async one. Never rejects. */
export function flushAll(): Promise<void> {
  return Promise.all([...writers.values()].map((w) => w.flush().catch(() => {}))).then(
    () => undefined,
    () => undefined
  )
}

/** Writes every shared writer's buffer synchronously. For exit and quit paths. Never throws.
 *
 *  An async append already in flight is not waited for: a synchronous caller cannot. Where that
 *  matters, `await flushAll()` first. The app's `will-quit` cannot await (Electron does not wait on
 *  it), so there a flush that started within the last few milliseconds may land after these lines, or
 *  not at all if the process ends first; rotation is skipped while one is in flight, so no line lands
 *  in a file that is being renamed. */
export function flushAllLogsSync(): void {
  for (const w of writers.values()) {
    try {
      w.flushSync()
    } catch {
      /* flushSync never throws; this is the belt */
    }
  }
}

const hooked = new WeakSet<object>()

/** Hooks `flushAllLogsSync` onto the target's `exit` event, once per target. Idempotent. */
export function installExitFlush(target: { on(event: 'exit', l: () => void): unknown }): void {
  if (hooked.has(target)) return
  hooked.add(target)
  try {
    target.on('exit', () => flushAllLogsSync())
  } catch {
    /* no exit hook, the quit paths still flush */
  }
}
