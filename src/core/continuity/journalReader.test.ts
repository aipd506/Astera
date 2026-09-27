import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BUSY_TIMEOUT_MS, ContinuityJournal, isBusyError } from './journal'
import { JournalReader, READER_BUSY_TIMEOUT_MS } from './journalReader'
import { holdLock, holdLockFor, schemaVersionIn } from './sqliteLockFixtures'
import type { ContinuityEvent } from './events'

let dir: string
const open: Array<{ close(): void }> = []
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-journal-reader-'))
})
afterEach(async () => {
  for (const o of open.splice(0)) o.close()
  await fs.rm(dir, { recursive: true, force: true })
})
const file = (): string => path.join(dir, 'continuity.sqlite')
const ev = (key: string): ContinuityEvent => ({
  runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', type: 'TASK_STARTED', at: '2026-09-26T10:00:00.000Z',
  idempotencyKey: key, payload: {}, actor: { surface: 'host' }
})
const reader = (): JournalReader => {
  const r = new JournalReader(file())
  open.push(r)
  return r
}
const writer = (): ContinuityJournal => {
  const w = new ContinuityJournal(file())
  open.push(w)
  return w
}

describe('JournalReader (P13)', () => {
  it('reads nothing for a file that does not exist yet, creates nothing, and sees the file once it exists', () => {
    const r = reader()
    expect(r.eventsFor('run_1')).toEqual([])
    expect(r.firstCheckpointFor('dsp_1')).toBeNull()
    expect(r.lastEvent()).toBeNull()
    expect(existsSync(file())).toBe(false)
    writer().append([ev('a')])
    expect(r.eventsFor('run_1').map((e) => [e.idempotencyKey, e.actor])).toEqual([['a', { surface: 'host' }]])
  })

  it('sees what the writer appends after the reader opened (WAL)', () => {
    const w = writer()
    w.append([ev('a')])
    const r = reader()
    expect(r.eventsFor('run_1')).toHaveLength(1)
    w.append([ev('b')])
    expect(r.eventsFor('run_1').map((e) => e.idempotencyKey)).toEqual(['a', 'b'])
    expect(r.lastEvent()?.idempotencyKey).toBe('b')
  })

  it('reads a v2 file without migrating it: actor null, and the file stays at version 2', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(file())
    raw.exec(
      "CREATE TABLE schema_meta (version INTEGER NOT NULL); INSERT INTO schema_meta VALUES (2);" +
        'CREATE TABLE journal_events (event_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, run_id TEXT NOT NULL, task_id TEXT, dispatch_id TEXT, event_type TEXT NOT NULL, created_at TEXT NOT NULL, idempotency_key TEXT UNIQUE, payload_json TEXT NOT NULL);' +
        "INSERT INTO journal_events VALUES ('e1', 2, 'run_1', 'tsk_1', 'dsp_1', 'ATTEMPT_LOST', '2026-09-08T10:00:00.000Z', 'k1', '{}');"
    )
    raw.close()
    const r = reader()
    expect(r.eventsFor('run_1')).toEqual([expect.objectContaining({ eventId: 'e1', type: 'ATTEMPT_LOST', actor: null })])
    r.close()
    open.splice(open.indexOf(r), 1)
    expect(schemaVersionIn(file())).toBe(2)
    const check = new DatabaseSync(file())
    const cols = (check.prepare('PRAGMA table_info(journal_events)').all() as { name: string }[]).map((c) => c.name)
    check.close()
    expect(cols).not.toContain('actor_json')
  })

  it('refuses to write: the connection is read-only', () => {
    writer().append([ev('a')])
    const r = reader()
    r.eventsFor('run_1')
    // A reader has no schema step to be tricked into, and the connection itself refuses a write.
    expect(() => r.execForTest('DELETE FROM journal_events')).toThrow(/readonly/i)
  })

  // Final review I2: the reader waits out a lock the writer holds for a moment (busy_timeout), and a lock
  // held past it is a failed read (P13: it throws), never a reason to touch the file.
  it('waits out a lock another connection holds for a moment', async () => {
    const w = new ContinuityJournal(file())
    w.append([ev('a')])
    w.close()
    // Shorter than the reader's own timeout (READER_BUSY_TIMEOUT_MS), which the reader waits out.
    const held = await holdLockFor(file(), 100)
    const r = reader()
    expect(r.eventsFor('run_1')).toHaveLength(1)
    await held.done
  })

  it('a lock held past its timeout throws after waiting for it, and the next read after it is let go works', () => {
    const w = new ContinuityJournal(file())
    w.append([ev('a')])
    w.close()
    const r = new JournalReader(file(), { busyTimeoutMs: 100 })
    open.push(r)
    const lock = holdLock(file())
    try {
      const t0 = Date.now()
      expect(() => r.eventsFor('run_1')).toThrow(/database is locked/)
      // It waited for the lock before it gave up: the timeout is set on this connection.
      expect(Date.now() - t0).toBeGreaterThanOrEqual(90)
    } finally {
      lock.release()
    }
    expect(r.eventsFor('run_1')).toHaveLength(1)
    expect(existsSync(file())).toBe(true)
  })
})

// Stage 3 T1: the app reads on Electron's main thread, so a lock the Host's writer holds must never
// stall it for the writer's 5 s. The reader's own timeout is short; a lock past it throws busy at once.
describe('JournalReader on the main thread (stage 3 T1)', () => {
  it('has a busy timeout far shorter than the writer’s', () => {
    expect(READER_BUSY_TIMEOUT_MS).toBeLessThanOrEqual(250)
    expect(READER_BUSY_TIMEOUT_MS).toBeLessThan(BUSY_TIMEOUT_MS)
  })

  it('under a held write lock, a read gives up busy within about 300 ms, not the writer’s 5 s', () => {
    const w = new ContinuityJournal(file())
    w.append([ev('a')])
    w.close()
    const r = reader()
    const lock = holdLock(file())
    let caught: unknown = null
    const t0 = Date.now()
    try {
      r.eventsFor('run_1')
    } catch (err) {
      caught = err
    } finally {
      lock.release()
    }
    const took = Date.now() - t0
    expect(isBusyError(caught)).toBe(true)
    expect(took).toBeLessThan(2_000) // gave up long before the writer's 5 s; Windows takes ~370 ms for a 250 ms timeout
    expect(r.eventsFor('run_1')).toHaveLength(1)
  }, 15_000)
})

describe('JournalReader.eventsFor, bounded (stage 3 T1)', () => {
  const at = (i: number, over: Partial<ContinuityEvent> = {}): ContinuityEvent => ({
    ...ev(`k${i}`),
    at: `2026-09-26T10:00:${String(i).padStart(2, '0')}.000Z`,
    payload: { i },
    ...over
  })
  it('returns the newest rows up to the limit, oldest first, and pages older ones with the cursor', () => {
    writer().append(Array.from({ length: 7 }, (_, i) => at(i)))
    const r = reader()
    const newest = r.eventsFor('run_1', { limit: 3 })
    expect(newest.map((e) => e.payload.i)).toEqual([4, 5, 6])
    const older = r.eventsFor('run_1', { limit: 3, before: newest[0].sequence })
    expect(older.map((e) => e.payload.i)).toEqual([1, 2, 3])
    const oldest = r.eventsFor('run_1', { limit: 3, before: older[0].sequence })
    expect(oldest.map((e) => e.payload.i)).toEqual([0])
    expect(r.eventsFor('run_1', { limit: 3, before: oldest[0].sequence })).toEqual([])
    // No page: every row, as before (the Host's own reads).
    expect(r.eventsFor('run_1')).toHaveLength(7)
  })

  it('narrows by type and by dispatch before the limit is applied', () => {
    writer().append([
      at(0, { type: 'ATTEMPT_LOST' }),
      at(1, { dispatchId: 'dsp_2', type: 'PROMPT_WRITE_CONFIRMED' }),
      at(2),
      at(3),
      at(4, { type: 'RECOVERY_STRATEGY_SELECTED' })
    ])
    const r = reader()
    expect(r.eventsFor('run_1', { limit: 10, types: ['ATTEMPT_LOST', 'RECOVERY_STRATEGY_SELECTED'] }).map((e) => e.payload.i)).toEqual([0, 4])
    expect(r.eventsFor('run_1', { limit: 1, types: ['ATTEMPT_LOST', 'RECOVERY_STRATEGY_SELECTED'] }).map((e) => e.payload.i)).toEqual([4])
    expect(r.eventsFor('run_1', { limit: 5, dispatchId: 'dsp_2' }).map((e) => e.payload.i)).toEqual([1])
    expect(r.eventsFor('run_1', { limit: 5, dispatchId: 'dsp_1', types: ['PROMPT_WRITE_CONFIRMED'] })).toEqual([])
  })
})

/** A version 1 file whose upgrade failed before recovery_actions was made: an index squats on the
 *  table's name, so the schema step throws there and the file is kept as v1 left it (Task 7 carry). */
const writeFailedV1File = async (at: string): Promise<void> => {
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(at)
  raw.exec(`
CREATE TABLE schema_meta (version INTEGER NOT NULL);
CREATE TABLE journal_events (event_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, run_id TEXT NOT NULL,
  task_id TEXT, dispatch_id TEXT, event_type TEXT NOT NULL, created_at TEXT NOT NULL, idempotency_key TEXT UNIQUE,
  payload_json TEXT NOT NULL);
CREATE INDEX recovery_actions ON journal_events(run_id);
INSERT INTO schema_meta (version) VALUES (1);
`)
  raw.close()
}

describe('JournalReader on a v1 file whose upgrade failed (Task 7 carry)', () => {
  it('reads its events without throwing', async () => {
    await writeFailedV1File(file())
    const r = reader()
    expect(r.eventsFor('run_1')).toEqual([])
    expect(r.lastEvent()).toBeNull()
  })
})
