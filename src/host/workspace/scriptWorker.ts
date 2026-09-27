// The Host's `app js` runner: each script runs in a worker thread of its own, with the vm inside it,
// so a busy loop, before or after an `await`, blocks only that worker. The Host's thread, which holds
// every session's terminal, keeps running, owns the deadline and Stop, and ends the worker with
// `terminate()`, which cuts off a loop that never yields (the limit this replaces is gone from
// docs/agent-workspace-isolation.md, amendment 2026-09-27).
//
// The helpers stay on this thread, gated exactly as before (core/workspace/script.ts's gateHelpers),
// so `ctx.at`, the mirror's "helper running now" and the frames a helper asks for behave as they did.
// Inside the worker every helper name is an async proxy: it posts `{ id, name, args }` and this thread
// answers `{ id, ok, value }` or `{ id, ok: false, error: { message, at? } }`. `log` posts a line and
// waits for nothing. `help` is answered in the worker from the texts in workerData, so it stays
// synchronous (WORKSPACE_SYNCHRONOUS_HELPERS names no other helper, and one that did could not be
// proxied, so the runner refuses it).
//
// The agent browser's runner (core/agentBrowser/scriptRunner.ts) is untouched: it runs in the app.
// core/workspace/script.ts's runWorkspaceScript, the in-process runner this replaced for the Host, is
// the contract this one keeps. The worker is not a security boundary either: it is a clean global scope for a
// script written by the user's own agent, as the vm was.
import { Worker } from 'node:worker_threads'
import { Interrupted, SCRIPT_TIMEOUT_MS, type RunError, type RunResult } from '../../core/agentBrowser/script'
import type { RunContext } from '../../core/agentBrowser/scriptRunner'
import { helpTexts } from '../../core/workspace/helpers'
import { WORKSPACE_SYNCHRONOUS_HELPERS, gateHelpers } from '../../core/workspace/script'

/** The worker's whole code, loaded with `eval: true` so the build needs no second entry. It imports
 *  nothing from this repository. Plain ES2020, no template literals, so it sits in this string as is. */
export const WORKER_SOURCE = String.raw`
'use strict'
const { parentPort, workerData } = require('node:worker_threads')
const vm = require('node:vm')

// A helper the script called without await and whose promise nobody reads must not end the worker:
// the main thread's runner treated it as nothing, so this does too.
process.on('unhandledRejection', () => {})

const post = (msg) => parentPort.postMessage(msg)
const atOf = new WeakMap()
const pending = new Map()
let nextId = 0

const isErrorLike = (v) => Object.prototype.toString.call(v) === '[object Error]'
const printable = (v) => {
  try {
    return String(v)
  } catch {
    return Object.prototype.toString.call(v)
  }
}

// core/agentBrowser/script.ts's stringifyLog, run here so what crosses is always a string.
const stringify = (v) => {
  if (typeof v === 'string') return v
  if (v === undefined) return 'undefined'
  try {
    return JSON.stringify(v)
  } catch {
    return printable(v)
  }
}

// An argument the structured clone refuses: a function or a symbol becomes its text (the helpers
// read such arguments through String() anyway), and one nested in an object or array is left out,
// the way JSON leaves it out. Anything else is copied as the clone would copy it.
const cloneable = (v, top, seen) => {
  if (typeof v === 'function' || typeof v === 'symbol') return top ? printable(v) : undefined
  if (typeof v !== 'object' || v === null) return v
  if (seen.has(v)) return seen.get(v)
  if (Array.isArray(v)) {
    const out = []
    seen.set(v, out)
    for (const x of v) out.push(cloneable(x, false, seen))
    return out
  }
  try {
    structuredClone(v)
    return v
  } catch {}
  const out = {}
  seen.set(v, out)
  for (const k of Object.keys(v)) {
    const x = cloneable(v[k], false, seen)
    if (x !== undefined) out[k] = x
  }
  return out
}

const call = (name, args) =>
  new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    try {
      post({ type: 'call', id, name, args })
    } catch {
      try {
        const seen = new Map()
        post({ type: 'call', id, name, args: args.map((a) => cloneable(a, true, seen)) })
      } catch (err) {
        pending.delete(id)
        reject(err)
      }
    }
  })

parentPort.on('message', (m) => {
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  if (m.ok) return p.resolve(m.value)
  const err = new Error(m.error.message)
  if (typeof m.error.at === 'string') atOf.set(err, m.error.at)
  p.reject(err)
})

const shape = (err) => {
  if (isErrorLike(err)) {
    const out = { message: typeof err.message === 'string' ? err.message : printable(err) }
    if (atOf.has(err)) out.at = atOf.get(err)
    return out
  }
  return { message: printable(err) }
}

const sandbox = { console: undefined }
for (const name of workerData.names) sandbox[name] = (...args) => call(name, args)
const help = workerData.help
sandbox.help = (name) => {
  if (name === undefined) return help.all
  const n = String(name)
  const text = help.sections.get(n)
  return text !== undefined ? text : help.unknown[0] + n + help.unknown[1]
}
sandbox.log = (v) => post({ type: 'log', line: stringify(v) })

const start = () => {
  let wrapped
  try {
    wrapped = new vm.Script('(async () => {\n' + workerData.script + '\n})()', { filename: 'agent-script.js' })
  } catch (err) {
    return post({ type: 'done', error: shape(err) })
  }
  const context = vm.createContext(sandbox, { name: 'agent-app' })
  post({ type: 'begin' })
  let running
  try {
    running = Promise.resolve(wrapped.runInContext(context))
  } catch (err) {
    return post({ type: 'done', error: shape(err) })
  }
  post({ type: 'started' })
  running.then(
    () => post({ type: 'done' }),
    (err) => post({ type: 'done', error: shape(err) })
  )
}
start()
`

type FromWorker =
  | { type: 'log'; line: string }
  | { type: 'begin' }
  | { type: 'started' }
  | { type: 'call'; id: number; name: string; args: unknown[] }
  | { type: 'done'; error?: { message: string; at?: string } }

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** What a helper's failure carries across: its message, and the `at` of an Interrupted (a helper's own
 *  deadline), which outranks the running helper's name just as shapeError lets it. */
function errorOf(err: unknown): { message: string; at?: string } {
  if (err instanceof Interrupted) return { message: err.message, at: err.at }
  return { message: messageOf(err) }
}

/** Runs one script in a worker of its own. The contract is core/workspace/script.ts's
 *  runWorkspaceScript's, plus the guide `help()` answers from: the same result, `at`, log order and
 *  Stop and deadline mapping. `stop` and the deadline both end the worker, whatever it is doing. */
export async function runScriptInWorker(a: {
  script: string
  helpers: (ctx: RunContext) => Record<string, unknown>
  stop: AbortSignal
  onHelper(name: string | null): void
  guide: string
  timeoutMs?: number
}): Promise<RunResult> {
  const timeoutMs = a.timeoutMs ?? SCRIPT_TIMEOUT_MS
  const ctx: RunContext = { at: 'script' }
  const inner = new AbortController()
  const gated = gateHelpers(a.helpers(ctx), ctx, inner.signal, a.onHelper)
  const names = Object.keys(gated).filter((n) => typeof gated[n] === 'function' && n !== 'help' && n !== 'log')
  for (const n of names)
    if (WORKSPACE_SYNCHRONOUS_HELPERS.has(n)) throw new Error(`the script worker cannot proxy the synchronous helper ${n}`)
  const lines: string[] = []

  let worker: Worker
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { script: a.script, names, help: helpTexts(a.guide) } })
  } catch (err) {
    inner.abort()
    return { log: [], error: { message: `the script could not start: ${messageOf(err)}`, at: 'script' } }
  }

  return new Promise<RunResult>((resolve) => {
    let over = false
    let begun = false
    let started = false

    const finish = (error?: RunError): void => {
      if (over) return
      over = true
      clearTimeout(timer)
      a.stop.removeEventListener('abort', onStop)
      // Every way out aborts the gate, so a helper the manager is still running stops asking for more.
      inner.abort()
      worker.terminate().catch(() => undefined)
      resolve(error ? { log: [...lines], error } : { log: [...lines] })
    }

    const reply = (msg: { id: number; ok: true; value: unknown } | { id: number; ok: false; error: { message: string; at?: string } }): void => {
      if (over) return
      worker.postMessage(msg)
    }

    const serve = (m: { id: number; name: string; args: unknown[] }): void => {
      const fn = gated[m.name]
      if (typeof fn !== 'function') return reply({ id: m.id, ok: false, error: { message: `${m.name} is not a helper` } })
      let p: Promise<unknown>
      try {
        p = Promise.resolve((fn as (...args: unknown[]) => unknown)(...m.args))
      } catch (err) {
        p = Promise.reject(err)
      }
      // Both branches handled, and neither can throw: a helper that settles after the worker is gone
      // (a pending launch the deadline cut off) is dropped, never an unhandled rejection (R3).
      p.then(
        (value) => {
          try {
            reply({ id: m.id, ok: true, value })
          } catch (err) {
            try {
              reply({ id: m.id, ok: false, error: { message: `${m.name}: its result could not be handed to the script (${messageOf(err)})`, at: m.name } })
            } catch {
              /* the worker is gone */
            }
          }
        },
        (err: unknown) => {
          try {
            reply({ id: m.id, ok: false, error: errorOf(err) })
          } catch {
            /* the worker is gone */
          }
        }
      )
    }

    const onStop = (): void => {
      ctx.at = 'stopped'
      finish({ message: 'stopped', at: 'stopped' })
    }

    const timer = setTimeout(() => {
      // "Never awaited": the body was entered and its synchronous part has not returned yet.
      const never = begun && !started ? ' (it never awaited)' : ''
      finish({ message: `script did not finish within ${timeoutMs} ms${never}`, at: 'timeout' })
    }, timeoutMs)

    worker.on('message', (m: FromWorker) => {
      if (over) return
      if (m.type === 'log') lines.push(m.line)
      else if (m.type === 'begin') begun = true
      else if (m.type === 'started') started = true
      else if (m.type === 'call') serve(m)
      else if (m.type === 'done') finish(m.error ? { message: m.error.message, at: m.error.at ?? ctx.at } : undefined)
    })
    // Always listened to, also after the end: an 'error' event with no listener would throw in the Host.
    worker.on('error', (err) => finish({ message: `the script worker failed: ${messageOf(err)}`, at: ctx.at }))
    worker.on('exit', (code) => finish({ message: `the script worker exited early (code ${code})`, at: ctx.at }))

    if (a.stop.aborted) onStop()
    else a.stop.addEventListener('abort', onStop, { once: true })
  })
}
