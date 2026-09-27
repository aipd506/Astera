// The Host's `app js` runner: the script runs in a worker thread the Host can terminate, and the
// helpers stay on this thread. The busy loops below are bounded (they end on their own after LOOP_MS)
// so that a runner which does run them on this thread fails these tests instead of hanging them.
import { describe, it, expect, vi } from 'vitest'
import { Interrupted } from '../../core/agentBrowser/script'
import { workspaceHelpers, type HelperDeps } from '../../core/workspace/helpers'
import { runScriptInWorker } from './scriptWorker'

const LOOP_MS = 2_000
const busy = `{ const end = Date.now() + ${LOOP_MS}; while (Date.now() < end) {} }`
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

/** Counts this thread's timer ticks while `p` runs: a blocked thread counts none. */
async function ticksDuring<T>(p: Promise<T>): Promise<{ value: T; ticks: number; ms: number }> {
  const t0 = Date.now()
  let ticks = 0
  const iv = setInterval(() => (ticks += 1), 20)
  try {
    const value = await p
    return { value, ticks, ms: Date.now() - t0 }
  } finally {
    clearInterval(iv)
  }
}

describe('a busy loop is cut off', () => {
  it('after an await, at the deadline, and this thread keeps running meanwhile', async () => {
    const r = await ticksDuring(run(`await nop(); ${busy}; log('never')`, { nop: async () => {} }, { timeoutMs: 400 }))
    expect(r.value).toEqual({ log: [], error: { at: 'timeout', message: 'script did not finish within 400 ms' } })
    expect(r.ms).toBeLessThan(LOOP_MS - 500)
    expect(r.ticks).toBeGreaterThanOrEqual(5)
  })

  it('before any await, with the "never awaited" wording', async () => {
    const r = await ticksDuring(run(`log('first'); ${busy}; await nop()`, { nop: async () => {} }, { timeoutMs: 400 }))
    expect(r.value.error).toEqual({ at: 'timeout', message: 'script did not finish within 400 ms (it never awaited)' })
    expect(r.value.log).toEqual(['first'])
    expect(r.ms).toBeLessThan(LOOP_MS - 500)
    expect(r.ticks).toBeGreaterThanOrEqual(5)
  })

  it('by Stop, at "stopped"', async () => {
    const stop = new AbortController()
    const entered = vi.fn()
    const p = ticksDuring(run(`await nop(); ${busy}`, { nop: async () => entered() }, { stop: stop.signal }))
    await vi.waitFor(() => expect(entered).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 100))
    stop.abort()
    const r = await p
    expect(r.value.error).toEqual({ message: 'stopped', at: 'stopped' })
    expect(r.ms).toBeLessThan(LOOP_MS - 500)
  })

  it('a Stop already given ends the script before it starts', async () => {
    const stop = new AbortController()
    stop.abort()
    const called = vi.fn()
    const r = await run('await nop()', { nop: async () => called() }, { stop: stop.signal })
    expect(r).toEqual({ log: [], error: { message: 'stopped', at: 'stopped' } })
    expect(called).not.toHaveBeenCalled()
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
