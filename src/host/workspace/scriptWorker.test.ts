// The Host's `app js` runner: the script runs in a worker thread the Host can terminate, and the
// helpers stay on this thread. The busy loops below are bounded (they end on their own after LOOP_MS)
// so that a runner which does run them on this thread fails these tests instead of hanging them.
//
// Nothing here times the worker's start: CI runners are shared and a worker can take long to start.
// Each loop test has the script call `mark()`, not awaited, right before its loop, and counts this
// thread's ticks from that call. Ticks while the loop runs prove this thread was not blocked; the
// outcome (cut off, never `log('never')`) proves the loop was ended rather than finished. The only
// time bound left is many seconds below the loop's own end.
import { describe, it, expect, vi } from 'vitest'
import { Interrupted } from '../../core/agentBrowser/script'
import { workspaceHelpers, type HelperDeps } from '../../core/workspace/helpers'
import { runScriptInWorker } from './scriptWorker'

// Counts the workers made, delegating to the real class, so a test can say none was started.
const made = vi.hoisted(() => ({ workers: 0 }))
vi.mock('node:worker_threads', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:worker_threads')>()
  class CountingWorker extends real.Worker {
    constructor(...a: ConstructorParameters<typeof real.Worker>) {
      super(...a)
      made.workers += 1
    }
  }
  return { ...real, Worker: CountingWorker, default: { ...real, Worker: CountingWorker } }
})

const LOOP_MS = 20_000
const LOOP_TEST_MS = 40_000
const TIMEOUT_MS = 3_000
const busy = `mark(); { const end = Date.now() + ${LOOP_MS}; while (Date.now() < end) {} }`
const GUIDE = '# guide\n\nIntro.\n\n## windows()\nLists them.\n\n## launch(spec)\nStarts it.\n\n## windows(again)\nNot this one.\n'

type Helpers = Record<string, unknown>
const run = (script: string, helpers: Helpers = {}, over: { stop?: AbortSignal; timeoutMs?: number; onHelper?: (n: string | null) => void } = {}) =>
  runScriptInWorker({
    script,
    guide: GUIDE,
    stop: over.stop ?? new AbortController().signal,
    onHelper: over.onHelper ?? (() => {}),
    timeoutMs: over.timeoutMs,
    helpers: () => helpers
  })

/** Runs a loop script with `mark` and `nop` helpers, and counts this thread's ticks from the moment
 *  the script called `mark()`: a blocked thread counts none. */
function loopRun(script: string, over: { stop?: AbortSignal; timeoutMs?: number } = {}) {
  let ticks = 0
  let markedAt: { ticks: number; ms: number } | null = null
  const iv = setInterval(() => (ticks += 1), 20)
  const result = run(script, { nop: async () => {}, mark: async () => void (markedAt = { ticks, ms: Date.now() }) }, over).then((value) => {
    clearInterval(iv)
    if (!markedAt) throw new Error('the script never reached its loop')
    return { value, ticksInLoop: ticks - markedAt.ticks, msInLoop: Date.now() - markedAt.ms }
  })
  return { result, marked: () => markedAt !== null, ticksSinceMark: () => (markedAt ? ticks - markedAt.ticks : 0) }
}

describe('a busy loop is cut off', () => {
  it('after an await, at the deadline, and this thread keeps running meanwhile', { timeout: LOOP_TEST_MS }, async () => {
    const r = await loopRun(`await nop(); ${busy}; log('never')`, { timeoutMs: TIMEOUT_MS }).result
    expect(r.value.log).toEqual([])
    expect(r.value.error?.at).toBe('timeout')
    expect(r.value.error?.message).toMatch(new RegExp(`^script did not finish within ${TIMEOUT_MS} ms`))
    expect(r.ticksInLoop).toBeGreaterThanOrEqual(3)
    expect(r.msInLoop).toBeLessThan(LOOP_MS - 10_000)
  })

  it('before any await, with the "never awaited" wording', { timeout: LOOP_TEST_MS }, async () => {
    const r = await loopRun(`log('first'); ${busy}; await nop()`, { timeoutMs: TIMEOUT_MS }).result
    expect(r.value).toEqual({ log: ['first'], error: { at: 'timeout', message: `script did not finish within ${TIMEOUT_MS} ms (it never awaited)` } })
    expect(r.ticksInLoop).toBeGreaterThanOrEqual(3)
    expect(r.msInLoop).toBeLessThan(LOOP_MS - 10_000)
  })

  it('by Stop, at "stopped"', { timeout: LOOP_TEST_MS }, async () => {
    const stop = new AbortController()
    const r = loopRun(`await nop(); ${busy}; log('never')`, { stop: stop.signal })
    await vi.waitFor(() => expect(r.ticksSinceMark()).toBeGreaterThanOrEqual(3), { timeout: LOOP_MS - 10_000, interval: 20 })
    stop.abort()
    const done = await r.result
    expect(done.value).toEqual({ log: [], error: { message: 'stopped', at: 'stopped' } })
    expect(done.msInLoop).toBeLessThan(LOOP_MS - 10_000)
  })

  it('a Stop already given returns at once, without starting a worker', async () => {
    const stop = new AbortController()
    stop.abort()
    const called = vi.fn()
    const before = made.workers
    const r = await run('await nop()', { nop: async () => called() }, { stop: stop.signal })
    expect(r).toEqual({ log: [], error: { message: 'stopped', at: 'stopped' } })
    expect(called).not.toHaveBeenCalled()
    expect(made.workers).toBe(before)
    await run("log('x')")
    expect(made.workers).toBe(before + 1)
  })
})

describe('helpers cross to this thread', () => {
  it('passes arguments and results, and reports each helper while it runs', async () => {
    const seen: Array<string | null> = []
    const r = await runScriptInWorker({
      script: "log(await add(1, 2)); log(await echo({ a: [1, 'x'], b: null })); log('end')",
      guide: GUIDE,
      stop: new AbortController().signal,
      onHelper: (n) => seen.push(n),
      helpers: (ctx) => ({
        add: async (x: number, y: number) => {
          ctx.at = 'add'
          return x + y
        },
        echo: async (v: unknown) => {
          ctx.at = 'echo'
          return v
        }
      })
    })
    expect(r).toEqual({ log: ['3', '{"a":[1,"x"],"b":null}', 'end'] })
    expect(seen).toEqual(['add', null, 'echo', null])
  })

  it('keeps log order around helper calls, and log stringifies in the script', async () => {
    const r = await run("log('a'); log(await v()); log(undefined); log({ f() {} }); const c = {}; c.c = c; log(c); log('z')", { v: async () => 'b' })
    expect(r).toEqual({ log: ['a', 'b', 'undefined', '{}', '[object Object]', 'z'] })
  })

  it('a helper error names the helper, and an Interrupted keeps its own at', async () => {
    const plain = await runScriptInWorker({
      script: "log('before'); await launch({})",
      guide: GUIDE,
      stop: new AbortController().signal,
      onHelper: () => {},
      helpers: (ctx) => ({
        launch: async () => {
          ctx.at = 'launch'
          throw new Error('launch: bad')
        }
      })
    })
    expect(plain).toEqual({ log: ['before'], error: { message: 'launch: bad', at: 'launch' } })

    const timed = await run('await waitFor(1)', { waitFor: async () => { throw new Interrupted('waitFor', 'waitFor did not finish within 30000 ms') } })
    expect(timed.error).toEqual({ message: 'waitFor did not finish within 30000 ms', at: 'waitFor' })
  })

  it('the script can catch a helper error and read its message', async () => {
    const r = await run("try { await bad() } catch (e) { log(e.message) } log('after')", { bad: async () => { throw new Error('nope') } })
    expect(r).toEqual({ log: ['nope', 'after'] })
  })

  it('a helper error that cannot be read still settles the call, with a fallback message', async () => {
    const unreadable = Object.create(null) as object
    const r = await runScriptInWorker({
      script: "try { await bad() } catch (e) { log(e.message) } log('after'); await bad()",
      guide: GUIDE,
      stop: new AbortController().signal,
      onHelper: () => {},
      timeoutMs: 5_000,
      helpers: (ctx) => ({
        bad: () => {
          ctx.at = 'bad'
          return Promise.reject(unreadable)
        }
      })
    })
    expect(r).toEqual({ log: ['bad: the helper failed with an error that cannot be read', 'after'], error: { message: 'bad: the helper failed with an error that cannot be read', at: 'bad' } })
  })

  it('an error the script throws itself is at "script", and so is a syntax error', async () => {
    expect((await run("throw new Error('mine')")).error).toEqual({ message: 'mine', at: 'script' })
    expect((await run("throw 'text'")).error).toEqual({ message: 'text', at: 'script' })
    expect((await run('await nop(); throw new Error("later")', { nop: async () => {} })).error).toEqual({ message: 'later', at: 'script' })
    const syntax = await run('this is not javascript')
    expect(syntax.error?.at).toBe('script')
    expect(syntax.error?.message).toMatch(/Unexpected/)
  })

  it('an argument that does not clone is converted rather than failing the call', async () => {
    const got: unknown[] = []
    const r = await run('await take(() => 1, { keep: 1, drop() {} }, Symbol("s")); log("ok")', {
      take: async (...a: unknown[]) => {
        got.push(...a)
      }
    })
    expect(r).toEqual({ log: ['ok'] })
    expect(got).toEqual(['() => 1', { keep: 1 }, 'Symbol(s)'])
  })

  it('a result that does not clone becomes the helper error', async () => {
    const r = await run('await give()', { give: async () => () => 1 })
    expect(r.error?.at).toBe('give')
    expect(r.error?.message).toMatch(/^give: its result could not be handed to the script/)
  })

  it('an un-awaited helper that rejects does not end the script', async () => {
    const r = await run("bad(); await nop(); log('after')", { bad: async () => { throw new Error('x') }, nop: async () => {} })
    expect(r).toEqual({ log: ['after'] })
  })

  it('a helper still pending when the worker is ended settles without an unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      let fail!: (e: Error) => void
      const r = await run('await slow()', { slow: () => new Promise((_, reject) => (fail = reject)) }, { timeoutMs: 200 })
      expect(r.error?.at).toBe('timeout')
      fail(new Error('late'))
      await new Promise((res) => setTimeout(res, 50))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('a helper the body calls after the script ended is never run', async () => {
    const after = vi.fn()
    let release!: () => void
    const stop = new AbortController()
    const p = run('await wait(); await next()', { wait: () => new Promise<void>((r) => (release = r)), next: async () => after() }, { stop: stop.signal })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    stop.abort()
    expect((await p).error).toEqual({ message: 'stopped', at: 'stopped' })
    release()
    await new Promise((r) => setTimeout(r, 50))
    expect(after).not.toHaveBeenCalled()
  })
})

describe('help', () => {
  it('answers in the worker, without await, exactly as the helper on this thread does', async () => {
    const own = workspaceHelpers({ guide: GUIDE } as HelperDeps, { at: 'script' }).help as (n?: unknown) => string
    const names = ['windows', 'launch', 'nope', 'constructor', '__proto__', 'Intro.']
    const r = await run(`log(help()); ${names.map((n) => `log(help(${JSON.stringify(n)}))`).join('; ')}; log(help(42))`)
    expect(r).toEqual({ log: [own(), ...names.map((n) => own(n)), own(42)] })
  })
})
