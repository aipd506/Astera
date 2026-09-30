import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createLogWriter,
  logWriterFor,
  lineLog,
  flushAllLogsSync,
  installExitFlush,
  flushAll,
  LOG_MAX_PENDING_BYTES,
  LOG_ROTATE_RETRY_MS,
  LOG_MAX_BYTES,
  LOG_FLUSH_MS,
  LOG_FLUSH_BYTES,
  type LogFs,
  _resetLogErrorNotesForTests
} from './logWriter'

/** A fake fs that records every call and keeps files in memory. Async calls resolve on a microtask. */
function fakeFs(
  opts: { failAppend?: string; failAppendSync?: string; failRename?: string; failRenameSync?: string; gate?: Promise<void> | null } = {}
) {
  const files = new Map<string, string>()
  const calls: string[] = []
  const err = (code: string): Error => Object.assign(new Error(code), { code })
  const fs: LogFs = {
    appendFile: async (p, data) => {
      calls.push(`appendFile ${path.basename(p)}`)
      if (opts.gate) await opts.gate
      if (opts.failAppend) throw err(opts.failAppend)
      files.set(p, (files.get(p) ?? '') + data)
    },
    rename: async (a, b) => {
      calls.push(`rename ${path.basename(a)} ${path.basename(b)}`)
      if (opts.failRename) throw err(opts.failRename)
      files.set(b, files.get(a) ?? '')
      files.delete(a)
    },
    stat: async (p) => {
      calls.push(`stat ${path.basename(p)}`)
      if (!files.has(p)) throw err('ENOENT')
      return { size: Buffer.byteLength(files.get(p)!) }
    },
    mkdir: async () => {
      calls.push('mkdir')
    },
    appendFileSync: (p, data) => {
      calls.push(`appendFileSync ${path.basename(p)}`)
      if (opts.failAppendSync) throw err(opts.failAppendSync)
      files.set(p, (files.get(p) ?? '') + data)
    },
    renameSync: (a, b) => {
      calls.push(`renameSync ${path.basename(a)} ${path.basename(b)}`)
      if (opts.failRenameSync) throw err(opts.failRenameSync)
      files.set(b, files.get(a) ?? '')
      files.delete(a)
    },
    statSync: (p) => {
      calls.push(`statSync ${path.basename(p)}`)
      if (!files.has(p)) throw err('ENOENT')
      return { size: Buffer.byteLength(files.get(p)!) }
    },
    mkdirSync: () => {
      calls.push('mkdirSync')
    }
  }
  return { fs, files, calls }
}

const P = path.join(os.tmpdir(), 'astera-fake', 'x.log')

beforeEach(() => {
  vi.useFakeTimers()
  _resetLogErrorNotesForTests()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('createLogWriter', () => {
  it('names its limits as constants', () => {
    expect(LOG_MAX_BYTES).toBe(5 * 1024 * 1024)
    expect(LOG_FLUSH_MS).toBe(200)
    expect(LOG_FLUSH_BYTES).toBe(64 * 1024)
  })

  it('touches no fs on a write, sync or async, and appends once per flush', async () => {
    const f = fakeFs()
    const w = createLogWriter({ path: P, fs: f.fs })
    for (let i = 0; i < 500; i++) w.write(`line ${i}\n`)
    expect(f.calls).toEqual([])
    await vi.advanceTimersByTimeAsync(LOG_FLUSH_MS)
    await w.flush()
    // One initial stat, then one append for all 500 lines. No sync call at all.
    expect(f.calls).toEqual(['stat x.log', 'appendFile x.log'])
    expect(f.files.get(P)!.split('\n').filter(Boolean)).toHaveLength(500)
  })

  it('stats the file only once across many flushes', async () => {
    const f = fakeFs()
    const w = createLogWriter({ path: P, fs: f.fs })
    for (let r = 0; r < 5; r++) {
      w.write(`round ${r}\n`)
      await vi.advanceTimersByTimeAsync(LOG_FLUSH_MS)
      await w.flush()
    }
    expect(f.calls.filter((c) => c.startsWith('stat'))).toHaveLength(1)
    expect(f.calls.filter((c) => c.startsWith('appendFile'))).toHaveLength(5)
  })

  it('flushes early once the buffer passes the byte threshold', async () => {
    const f = fakeFs()
    const w = createLogWriter({ path: P, fs: f.fs, flushBytes: 100 })
    w.write('a'.repeat(60) + '\n')
    expect(f.calls).toEqual([])
    w.write('b'.repeat(60) + '\n')
    // No timer advanced: the threshold alone started the flush.
    await w.flush()
    expect(f.calls).toContain('appendFile x.log')
  })

  it('keeps lines in order across flushes, including lines written while a flush is in flight', async () => {
    const f = fakeFs()
    const w = createLogWriter({ path: P, fs: f.fs })
    for (let i = 0; i < 10; i++) w.write(`${i}\n`)
    const first = w.flush()
    for (let i = 10; i < 20; i++) w.write(`${i}\n`)
    const second = w.flush()
    for (let i = 20; i < 30; i++) w.write(`${i}\n`)
    await first
    await second
    await w.flush()
    const got = f.files.get(P)!.split('\n').filter(Boolean).map(Number)
    expect(got).toEqual(Array.from({ length: 30 }, (_, i) => i))
  })

  it('rotates to .1 when a flush would pass the cap, keeping one old file', async () => {
    const f = fakeFs()
    const w = createLogWriter({ path: P, fs: f.fs, maxBytes: 100 })
    w.write('a'.repeat(79) + '\n')
    await w.flush()
    w.write('b'.repeat(79) + '\n')
    await w.flush()
    expect(f.files.get(P + '.1')).toBe('a'.repeat(79) + '\n')
    expect(f.files.get(P)).toBe('b'.repeat(79) + '\n')
    w.write('c'.repeat(79) + '\n')
    await w.flush()
    // The older .1 is replaced: one old file, never more.
    expect(f.files.get(P + '.1')).toBe('b'.repeat(79) + '\n')
    expect(f.files.get(P)).toBe('c'.repeat(79) + '\n')
    expect([...f.files.keys()].sort()).toEqual([P, P + '.1'])
  })

  it('rotates on real disk at the cap', async () => {
    vi.useRealTimers()
    const dir = mkdtempSync(path.join(os.tmpdir(), 'astera-logw-'))
    try {
      const p = path.join(dir, 'r.log')
      writeFileSync(p, 'x'.repeat(95) + '\n')
      const w = createLogWriter({ path: p, maxBytes: 100 })
      w.write('new line\n')
      await w.flush()
      expect(readFileSync(p + '.1', 'utf8')).toBe('x'.repeat(95) + '\n')
      expect(readFileSync(p, 'utf8')).toBe('new line\n')
      expect(statSync(p).size).toBeLessThanOrEqual(100)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flushSync writes what is buffered at once, synchronously', () => {
    const f = fakeFs()
    const w = createLogWriter({ path: P, fs: f.fs })
    w.write('last words\n')
    w.flushSync()
    expect(f.files.get(P)).toBe('last words\n')
    expect(f.calls).toEqual(['statSync x.log', 'appendFileSync x.log'])
    // Nothing is left for the timer.
    w.flushSync()
    expect(f.calls.filter((c) => c.startsWith('appendFileSync'))).toHaveLength(1)
  })

  it('never throws or rejects when the disk refuses, and notes each error kind once on stderr', async () => {
    const f = fakeFs({ failAppend: 'EACCES', failAppendSync: 'EPERM' })
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const w = createLogWriter({ path: P, fs: f.fs })
    w.write('one\n')
    await expect(w.flush()).resolves.toBeUndefined()
    w.write('two\n')
    await expect(w.flush()).resolves.toBeUndefined()
    w.write('three\n')
    expect(() => w.flushSync()).not.toThrow()
    w.write('four\n')
    expect(() => w.flushSync()).not.toThrow()
    // EACCES once, EPERM once: two notes for four failures.
    expect(err).toHaveBeenCalledTimes(2)
    expect(String(err.mock.calls[0][0])).toMatch(/EACCES/)
    expect(String(err.mock.calls[1][0])).toMatch(/EPERM/)
  })

  it('a stderr that throws is swallowed too', async () => {
    const f = fakeFs({ failAppend: 'EIO' })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('stderr gone')
    })
    const w = createLogWriter({ path: P, fs: f.fs })
    w.write('x\n')
    await expect(w.flush()).resolves.toBeUndefined()
  })

  it('a failed rotation still appends, and does not throw', async () => {
    const f = fakeFs({ failRename: 'EBUSY' })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const w = createLogWriter({ path: P, fs: f.fs, maxBytes: 10 })
    w.write('0123456789\n')
    await w.flush()
    w.write('more\n')
    await expect(w.flush()).resolves.toBeUndefined()
    expect(f.files.get(P)).toBe('0123456789\nmore\n')
  })

  it('makes the parent directory once when asked to', async () => {
    const f = fakeFs()
    const w = createLogWriter({ path: P, fs: f.fs, ensureDir: true })
    w.write('a\n')
    await w.flush()
    w.write('b\n')
    await w.flush()
    expect(f.calls.filter((c) => c === 'mkdir')).toHaveLength(1)
  })
})

describe('follow-up: exit ordering and rotation (review I1, M2, M3, M8)', () => {
  const deferred = (): { promise: Promise<void>; release: () => void } => {
    let release = (): void => {}
    const promise = new Promise<void>((r) => (release = r))
    return { promise, release }
  }

  it('the async path re-stats at the cap and does not rotate a file another process already rotated', async () => {
    const f = fakeFs()
    const w = createLogWriter({ path: P, fs: f.fs, maxBytes: 100 })
    w.write('a'.repeat(79) + '\n')
    await w.flush()
    // The other process rotated: the file on disk is small again, while this writer still counts 80.
    f.files.set(P, 'short\n')
    w.write('b'.repeat(79) + '\n')
    await w.flush()
    expect(f.calls.filter((c) => c.startsWith('rename'))).toEqual([])
    expect(f.files.get(P)).toBe('short\n' + 'b'.repeat(79) + '\n')
  })

  it('flushSync re-stats before rotating too (M2)', async () => {
    const f = fakeFs()
    const w = createLogWriter({ path: P, fs: f.fs, maxBytes: 100 })
    w.write('a'.repeat(79) + '\n')
    await w.flush()
    f.files.set(P, 'short\n')
    w.write('b'.repeat(79) + '\n')
    w.flushSync()
    expect(f.calls.filter((c) => c.startsWith('rename'))).toEqual([])
    expect(f.calls).toContain('statSync x.log')
    expect(f.files.get(P)).toBe('short\n' + 'b'.repeat(79) + '\n')
  })

  it('flushSync still rotates when the re-stat confirms the file is at the cap', async () => {
    const f = fakeFs()
    const w = createLogWriter({ path: P, fs: f.fs, maxBytes: 100 })
    w.write('a'.repeat(79) + '\n')
    await w.flush()
    w.write('b'.repeat(79) + '\n')
    w.flushSync()
    expect(f.files.get(P + '.1')).toBe('a'.repeat(79) + '\n')
    expect(f.files.get(P)).toBe('b'.repeat(79) + '\n')
  })

  it('drops lines past LOG_MAX_PENDING_BYTES instead of growing the heap, and says so once', async () => {
    const f = fakeFs()
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const w = createLogWriter({ path: P, fs: f.fs })
    const line = 'x'.repeat(1023) + '\n'
    const n = Math.ceil((LOG_MAX_PENDING_BYTES * 1.5) / line.length)
    for (let i = 0; i < n; i++) w.write(line)
    await w.flush()
    const written = f.files.get(P)!.length
    expect(written).toBeLessThanOrEqual(LOG_MAX_PENDING_BYTES)
    expect(written).toBeGreaterThan(LOG_MAX_PENDING_BYTES - line.length * 2)
    expect(err).toHaveBeenCalledTimes(1)
    expect(String(err.mock.calls[0][0])).toMatch(/FULL/)
  })

  it('flushAll waits for an append already in flight, and for what is still buffered', async () => {
    const gate = deferred()
    const f = fakeFs({ gate: gate.promise })
    const w = logWriterFor(path.join(os.tmpdir(), 'astera-fake', 'flushall.log'), { fs: f.fs })
    w.write('first\n')
    void w.flush() // in flight, held at the gate
    await Promise.resolve()
    w.write('second\n')
    let done = false
    const all = flushAll().then(() => (done = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(false)
    gate.release()
    await all
    expect(done).toBe(true)
    expect(f.files.get(path.join(os.tmpdir(), 'astera-fake', 'flushall.log'))).toBe('first\nsecond\n')
  })

  it('flushSync during an in-flight drain appends without rotating (I1)', async () => {
    const f = fakeFs()
    f.files.set(P, 'x'.repeat(89) + '\n')
    const w = createLogWriter({ path: P, fs: f.fs, maxBytes: 100 })
    const gate = deferred()
    // The first drain: stat reads 90, no rotation, and the append is held in flight.
    w.write('a\n')
    const fsGate = f.fs.appendFile
    f.fs.appendFile = async (p, d) => {
      await gate.promise
      return fsGate(p, d)
    }
    const inflight = w.flush()
    await vi.advanceTimersByTimeAsync(0)
    w.write('b'.repeat(19) + '\n')
    w.flushSync()
    expect(f.calls.filter((c) => c.startsWith('rename'))).toEqual([])
    gate.release()
    await inflight
  })

  it('a rotation that keeps failing is retried only after a backoff, and noted once per spell (M3)', async () => {
    const opts: { failRename?: string } = { failRename: 'EPERM' }
    const f = fakeFs(opts)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    let t = 1_000_000
    const w = createLogWriter({ path: P, fs: f.fs, maxBytes: 10, now: () => t })
    const renames = (): number => f.calls.filter((c) => c.startsWith('rename')).length
    w.write('0123456789\n')
    await w.flush()
    for (let i = 0; i < 5; i++) {
      w.write('more\n')
      await w.flush()
    }
    expect(renames()).toBe(1)
    expect(err).toHaveBeenCalledTimes(1)
    // flushSync keeps the same backoff.
    w.write('sync\n')
    w.flushSync()
    expect(renames()).toBe(1)
    // After the backoff it tries again; still failing is the same spell, so no second note.
    t += LOG_ROTATE_RETRY_MS
    w.write('again\n')
    await w.flush()
    expect(renames()).toBe(2)
    expect(err).toHaveBeenCalledTimes(1)
    // The lock clears: the next attempt (after the backoff) rotates, and that spell is over.
    opts.failRename = undefined
    t += LOG_ROTATE_RETRY_MS
    w.write('rotates\n')
    await w.flush()
    expect(renames()).toBe(3)
    expect(f.files.get(P)).toBe('rotates\n')
    // A new failure is a new spell, and is noted again.
    opts.failRename = 'EPERM'
    w.write('y'.repeat(10) + '\n')
    await w.flush()
    expect(renames()).toBe(4)
    expect(err).toHaveBeenCalledTimes(2)
  })
})

describe('the shared writers', () => {
  let dir: string
  beforeEach(() => {
    vi.useRealTimers()
    dir = mkdtempSync(path.join(os.tmpdir(), 'astera-logs-'))
  })
  afterEach(() => {
    flushAllLogsSync()
    rmSync(dir, { recursive: true, force: true })
  })

  it('one writer per file, so two loggers on one file keep one order', () => {
    const p = path.join(dir, 'rolling.log')
    expect(logWriterFor(p)).toBe(logWriterFor(p))
    const a = lineLog(p)
    const b = lineLog(p)
    a('[host] one')
    b('[host][codex] two')
    a('[host] three')
    flushAllLogsSync()
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean)
    expect(lines.map((l) => l.replace(/^\S+ /, ''))).toEqual(['[host] one', '[host][codex] two', '[host] three'])
  })

  it('lineLog keeps the line format: an ISO stamp, a space, the message', () => {
    const p = path.join(dir, 'slack.log')
    lineLog(p)('hello')
    expect(existsSync(p)).toBe(false) // nothing on disk until a flush
    flushAllLogsSync()
    expect(readFileSync(p, 'utf8')).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z hello\n$/)
  })

  it('flushAllLogsSync is what exit runs: every buffered line of every file lands before it returns', () => {
    const a = path.join(dir, 'a.log')
    const b = path.join(dir, 'b.log')
    lineLog(a)('a1')
    lineLog(b)('b1')
    flushAllLogsSync()
    expect(readFileSync(a, 'utf8')).toMatch(/a1\n$/)
    expect(readFileSync(b, 'utf8')).toMatch(/b1\n$/)
  })

  it('installExitFlush hooks exit once per target, and the hook flushes synchronously', () => {
    const p = path.join(dir, 'exit.log')
    const target = new EventEmitter()
    installExitFlush(target)
    installExitFlush(target)
    expect(target.listenerCount('exit')).toBe(1)
    lineLog(p)('bye')
    target.emit('exit', 0)
    expect(readFileSync(p, 'utf8')).toMatch(/bye\n$/)
  })

  it('a logger never throws, even when its folder is gone', () => {
    const log = lineLog(path.join(dir, 'no-such', 'deeper', 'x.log'))
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(() => log('x')).not.toThrow()
    expect(() => flushAllLogsSync()).not.toThrow()
    err.mockRestore()
  })
})
