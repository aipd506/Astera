// The Host's `app js` runner: each script runs in a child process of its own, and inside it in a worker
// thread, with the vm inside that. A busy loop, before or after an `await`, blocks only that worker, and
// memory the script takes is the child's, so running out of it ends the child, never the Host
// (docs/agent-workspace-isolation.md, P13 and P14). The Host's thread, which holds every session's
// terminal, keeps running, owns the deadline and Stop, and ends the child's process tree for both.
//
// Memory is bounded twice. The worker's `resourceLimits` bound its V8 heap (SCRIPT_HEAP_LIMIT_MB), and
// the child's main thread reads its rss every SCRIPT_MEMORY_WATCH_MS and ends the child above
// SCRIPT_MEMORY_CAP_MB, which covers ArrayBuffer and TypedArray memory the heap limit does not see.
// Either ends the run at `at: 'memory'`; V8 ending the child outright is read from its stderr and is
// `at: 'memory'` too; a child that dies any other way is `at: 'crashed'`.
//
// The helpers stay on this thread, gated exactly as before (core/workspace/script.ts's gateHelpers),
// so `ctx.at`, the mirror's "helper running now" and the frames a helper asks for behave as they did.
// Inside the worker every helper name is an async proxy: it posts `{ id, name, args }`, the child's
// main thread relays it over the IPC channel unchanged, and this thread answers `{ id, ok, value }` or
// `{ id, ok: false, error: { message, at? } }` the same way back. `log` posts a line and waits for
// nothing. `help` is answered in the worker from the texts in workerData, so it stays synchronous
// (WORKSPACE_SYNCHRONOUS_HELPERS names no other helper, and one that did could not be proxied, so the
// runner refuses it).
//
// The agent browser's runner (core/agentBrowser/scriptRunner.ts) is untouched: it runs in the app.
// core/workspace/script.ts's runWorkspaceScript, the in-process runner this replaced for the Host, is
// the contract this one keeps. Neither the worker nor the child is a security boundary: they are a
// clean global scope and a separate heap for a script written by the user's own agent, as the vm was.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import { treeKillCommand } from '../../core/run/kill'
import { Interrupted, SCRIPT_TIMEOUT_MS, type RunError, type RunResult } from '../../core/agentBrowser/script'
import type { RunContext } from '../../core/agentBrowser/scriptRunner'
import { helpTexts } from '../../core/workspace/helpers'
import { ScriptDeadline, WORKSPACE_SYNCHRONOUS_HELPERS, gateHelpers, type ScriptClock } from '../../core/workspace/script'

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

/** The child's rss cap. rss counts what the V8 heap does not, such as ArrayBuffer and TypedArray memory,
 *  which a worker's `resourceLimits` cannot bound: above this the child reports and ends itself. */
export const SCRIPT_MEMORY_CAP_MB = 512
/** The worker's old generation heap limit inside the child (`resourceLimits.maxOldGenerationSizeMb`). */
export const SCRIPT_HEAP_LIMIT_MB = 256
/** How often the child reads its own rss. */
export const SCRIPT_MEMORY_WATCH_MS = 250
/** The code the child exits with when it ends itself over the rss cap. The Host reads it as `memory`
 *  even when the report sent just before it was never read. */
export const SCRIPT_MEMORY_EXIT_CODE = 75

/** The child's main thread, sent over the IPC channel as its first message and run with `new Function`,
 *  so the build needs no second entry and the command line stays one short line. It starts the worker
 *  from WORKER_SOURCE with the heap limit, relays every message both ways unchanged, and watches rss.
 *  `init` is `{ workerSource, workerData, heapMb, capMb, watchMs, memoryExitCode }`. Plain ES2020, no template literals. */
export const CHILD_SOURCE = String.raw`
'use strict'
const { Worker } = require('node:worker_threads')

let leaving = false
const leave = (code) => {
  if (leaving) return
  leaving = true
  process.exit(code)
}
const messageOf = (err) => {
  try {
    return err && typeof err.message === 'string' ? err.message : String(err)
  } catch {
    return 'an error that cannot be read'
  }
}
// A send can fail only when the Host has gone, and then nothing is left to tell.
const send = (m, done) => {
  try {
    process.send(m, done)
  } catch {
    if (done) done()
  }
}
// The Host closed the channel or died: this process has no one to answer to, so it ends.
process.on('disconnect', () => leave(0))

let worker
try {
  worker = new Worker(init.workerSource, { eval: true, workerData: init.workerData, resourceLimits: { maxOldGenerationSizeMb: init.heapMb } })
} catch (err) {
  send({ type: 'failed', message: messageOf(err) })
}
if (worker) {
  worker.on('message', (m) => {
    try {
      process.send(m)
    } catch (err) {
      // The worker's structured clone took it, so the channel's serializer, the same one, takes it too;
      // a call that still cannot cross is answered here rather than left waiting for the deadline.
      if (m && m.type === 'call')
        worker.postMessage({ id: m.id, ok: false, error: { message: m.name + ': its arguments could not be handed to the Host (' + messageOf(err) + ')' } })
    }
  })
  process.on('message', (m) => worker.postMessage(m))
  worker.on('error', (err) => {
    if (err && err.code === 'ERR_WORKER_OUT_OF_MEMORY') send({ type: 'memory', heap: true })
    else send({ type: 'failed', message: messageOf(err) })
  })
  worker.on('exit', (code) => send({ type: 'exited', code }))
  const cap = init.capMb * 1024 * 1024
  const watch = setInterval(() => {
    if (process.memoryUsage().rss <= cap) return
    clearInterval(watch)
    send({ type: 'memory' }, () => leave(init.memoryExitCode))
    // A Host too busy to take the report does not keep this process growing.
    setTimeout(() => leave(init.memoryExitCode), 200)
  }, init.watchMs)
}
`

/** The whole `-e` program: it waits for CHILD_SOURCE and its `init` on the IPC channel and runs it. */
const CHILD_BOOT = "process.once('message', (m) => new Function('require', 'init', m.source)(require, m.init))"

/** What the child's environment may hold beyond ELECTRON_RUN_AS_NODE: only what Node itself reads on
 *  start. No ASTERA_, CLAUDE_ or CODEX_ variable, no NODE_OPTIONS, no PATH. */
const CHILD_ENV_KEYS = ['SystemRoot', 'windir', 'TEMP', 'TMP', 'TMPDIR']

/** The child's environment, built from nothing. ELECTRON_RUN_AS_NODE makes the Host's own binary, when
 *  it is Electron, run as Node, and a plain node.exe ignores it. Names are matched without case, as a
 *  Windows environment block is. */
export function scriptChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
  for (const [k, v] of Object.entries(env)) {
    const name = CHILD_ENV_KEYS.find((n) => n.toLowerCase() === k.toLowerCase())
    if (name !== undefined && v !== undefined && out[name] === undefined) out[name] = v
  }
  return out
}

/** How much of the child's stderr is kept: enough for V8's fatal out-of-memory banner. */
const STDERR_KEEP = 16 * 1024
/** V8's words when it ends a process for want of memory ("... Allocation failed - JavaScript heap out
 *  of memory"). */
const FATAL_OOM = /heap out of memory|allocation failed/i

type FromChild =
  | { type: 'log'; line: string }
  | { type: 'begin' }
  | { type: 'started' }
  | { type: 'call'; id: number; name: string; args: unknown[] }
  | { type: 'done'; error?: { message: string; at?: string } }
  | { type: 'memory'; heap?: boolean }
  | { type: 'failed'; message: string }
  | { type: 'exited'; code: number }

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** What a helper's failure carries across: its message, and the `at` of an Interrupted (a helper's own
 *  deadline), which outranks the running helper's name just as shapeError lets it. An error nothing can
 *  read (String() throws on it, or its message is not a string) still gets an answer, with a fallback
 *  message, so the script's call settles at once instead of waiting for the deadline. */
function errorOf(err: unknown, name: string): { message: string; at?: string } {
  try {
    if (err instanceof Interrupted) return { message: err.message, at: err.at }
    const message: unknown = messageOf(err)
    if (typeof message === 'string') return { message }
  } catch {
    /* unreadable: the fallback below */
  }
  return { message: `${name}: the helper failed with an error that cannot be read` }
}

const alive = (c: ChildProcess): boolean => c.exitCode === null && c.signalCode === null

/** Ends the child and anything it started. The script cannot reach `require`, but the vm is no boundary,
 *  so a process it started is ended with it: taskkill /T on win32, the child's own process group (it is
 *  spawned detached) elsewhere. The plain kill follows either way, so a failed tree kill still ends it.
 *  Off win32 the group is killed even when the child has already exited, since what it started may
 *  still be in the group (ESRCH, an empty group, is fine). On win32 taskkill /T walks the tree from a
 *  live parent, so a child already gone leaves nothing it can find. Exported for its tests. */
export function endChild(c: ChildProcess, platform: NodeJS.Platform = process.platform, kill: typeof process.kill = process.kill): void {
  if (c.pid === undefined) return
  const tree = treeKillCommand(platform, c.pid)
  if (tree && !alive(c)) return
  const hard = (): void => {
    try {
      if (alive(c)) c.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  if (tree) {
    try {
      execFile(tree.file, tree.args, { windowsHide: true, timeout: 10_000 }, hard)
    } catch {
      hard()
    }
    return
  }
  try {
    kill(-c.pid, 'SIGKILL')
  } catch {
    /* no group left (ESRCH): the plain kill below */
  }
  hard()
}

/** Runs one script in a worker inside a child process of its own. The contract is
 *  core/workspace/script.ts's runWorkspaceScript's, plus the guide `help()` answers from: the same
 *  result, `at`, log order and Stop and deadline mapping. `stop` and the deadline both end the child,
 *  whatever it is doing. Memory the script takes ends the child too, at `at: 'memory'`, and a child
 *  that dies without saying why ends the run at `at: 'crashed'`. The caps are parameters for the tests;
 *  the Host uses the defaults.
 *
 *  The deadline is a ScriptDeadline, handed to the helpers as their clock: the time a helper on this
 *  thread spends in a launch wait (the app's port and page) does not count, up to LAUNCH_WAIT_MAX_MS
 *  over the run (stage 4, task 2). This thread knows exactly when one is in flight, since the helpers
 *  run here. A busy loop in the worker still ends at `timeoutMs` of time outside launch waits, and Stop
 *  never waits for the clock. */
export async function runScriptInWorker(a: {
  script: string
  helpers: (ctx: RunContext, clock: ScriptClock) => Record<string, unknown>
  stop: AbortSignal
  onHelper(name: string | null): void
  guide: string
  timeoutMs?: number
  launchWaitMaxMs?: number
  memoryCapMb?: number
  heapLimitMb?: number
}): Promise<RunResult> {
  // A Stop already given: the answer is known, so no child is started for it.
  if (a.stop.aborted) return { log: [], error: { message: 'stopped', at: 'stopped' } }
  const timeoutMs = a.timeoutMs ?? SCRIPT_TIMEOUT_MS
  const capMb = a.memoryCapMb ?? SCRIPT_MEMORY_CAP_MB
  const heapMb = a.heapLimitMb ?? SCRIPT_HEAP_LIMIT_MB
  const ctx: RunContext = { at: 'script' }
  const inner = new AbortController()
  // Set below, once the run's promise exists. The gap is synchronous, so no expiry can fall in it.
  let expire = (): void => {}
  const clock = new ScriptDeadline({ timeoutMs, launchMaxMs: a.launchWaitMaxMs, onExpire: () => expire() })
  let gated: Record<string, unknown>
  try {
    gated = gateHelpers(a.helpers(ctx, clock), ctx, inner.signal, a.onHelper)
  } catch (err) {
    clock.dispose()
    throw err
  }
  const names = Object.keys(gated).filter((n) => typeof gated[n] === 'function' && n !== 'help' && n !== 'log')
  for (const n of names)
    if (WORKSPACE_SYNCHRONOUS_HELPERS.has(n)) {
      clock.dispose()
      throw new Error(`the script worker cannot proxy the synchronous helper ${n}`)
    }
  const lines: string[] = []
  const couldNotStart = (err: unknown): RunResult => ({ log: [], error: { message: `the script could not start: ${messageOf(err)}`, at: 'script' } })

  let child: ChildProcess
  try {
    // The Host's own runtime (node.exe, or Electron run as Node), with none of its arguments, an
    // environment built from nothing, and no console: detached is DETACHED_PROCESS on win32, and its
    // own process group elsewhere. The channel's `advanced` serialization is the structured clone the
    // worker's messages already passed, so what the worker could post, the channel can carry.
    child = spawn(process.execPath, ['-e', CHILD_BOOT], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
      env: scriptChildEnv(process.env),
      cwd: os.tmpdir(),
      windowsHide: true,
      detached: true
    })
  } catch (err) {
    clock.dispose()
    inner.abort()
    return couldNotStart(err)
  }

  return new Promise<RunResult>((resolve) => {
    let over = false
    let begun = false
    let started = false
    let heard = false
    let stderr = ''

    const finish = (error?: RunError): void => {
      if (over) return
      over = true
      clock.dispose()
      a.stop.removeEventListener('abort', onStop)
      // Every way out aborts the gate, so a helper the manager is still running stops asking for more.
      inner.abort()
      endChild(child)
      resolve(error ? { log: [...lines], error } : { log: [...lines] })
    }

    const reply = (msg: { id: number; ok: true; value: unknown } | { id: number; ok: false; error: { message: string; at?: string } }): void => {
      if (over || !child.connected) return
      child.send(msg)
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
      // Both branches handled, and neither can throw: a helper that settles after the child is gone
      // (a pending launch the deadline cut off, or a child that died) is dropped, never an unhandled
      // rejection (R3).
      p.then(
        (value) => {
          try {
            reply({ id: m.id, ok: true, value })
          } catch (err) {
            try {
              reply({ id: m.id, ok: false, error: { message: `${m.name}: its result could not be handed to the script (${messageOf(err)})`, at: m.name } })
            } catch {
              /* the child is gone */
            }
          }
        },
        (err: unknown) => {
          try {
            reply({ id: m.id, ok: false, error: errorOf(err, m.name) })
          } catch {
            /* the child is gone */
          }
        }
      )
    }

    const onStop = (): void => {
      ctx.at = 'stopped'
      finish({ message: 'stopped', at: 'stopped' })
    }

    expire = (): void => {
      // "Never awaited": the body was entered and its synchronous part has not returned yet.
      const never = begun && !started ? ' (it never awaited)' : ''
      finish({ message: `script did not finish within ${timeoutMs} ms${never}`, at: 'timeout' })
    }

    const outOfMemory = (message: string): void => {
      ctx.at = 'memory'
      finish({ message, at: 'memory' })
    }

    child.on('message', (m: FromChild) => {
      heard = true
      if (over) return
      if (m.type === 'log') lines.push(m.line)
      else if (m.type === 'begin') begun = true
      else if (m.type === 'started') started = true
      else if (m.type === 'call') serve(m)
      else if (m.type === 'done') finish(m.error ? { message: m.error.message, at: m.error.at ?? ctx.at } : undefined)
      else if (m.type === 'memory')
        outOfMemory(m.heap ? `the script ran out of memory (its heap is limited to ${heapMb} MB)` : `the script used more than ${capMb} MB of memory and was ended`)
      else if (m.type === 'failed') finish({ message: `the script worker failed: ${m.message}`, at: ctx.at })
      else if (m.type === 'exited') finish({ message: `the script worker exited early (code ${m.code})`, at: ctx.at })
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < STDERR_KEEP) stderr += d.toString('utf8').slice(0, STDERR_KEEP - stderr.length)
    })
    // Always listened to, also after the end: an 'error' event with no listener would throw in the Host.
    // Before the child has said anything it is a start that failed (the binary is missing); after, a
    // send to a child that is going, whose 'exit' says the rest.
    child.on('error', (err) => {
      if (!heard) finish(couldNotStart(err).error)
    })
    // A child that dies without a report is judged on 'close', which comes after 'exit' once its stderr
    // and its IPC channel have both closed, so every message it sent has been read by then. Its exit
    // code says the rest: SCRIPT_MEMORY_EXIT_CODE is the rss cap (the report sent just before it can
    // still lose the race with the exit), and V8 ending it for want of memory says so on stderr. A
    // process the script started can hold stderr open past the child's end, so 'close' is waited for
    // 2 s at most.
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null
    let closeCap: ReturnType<typeof setTimeout> | undefined
    const judge = (): void => {
      clearTimeout(closeCap)
      if (over || !exited) return
      if (exited.code === SCRIPT_MEMORY_EXIT_CODE) return outOfMemory(`the script used more than ${capMb} MB of memory and was ended`)
      if (FATAL_OOM.test(stderr)) return outOfMemory('the script ran out of memory and its process ended')
      const how = exited.signal ? `signal ${exited.signal}` : `code ${exited.code}`
      finish({ message: `the script's process ended unexpectedly (${how})`, at: 'crashed' })
    }
    child.on('exit', (code, signal) => {
      exited = { code, signal }
      if (!over) closeCap = setTimeout(judge, 2_000)
    })
    child.on('close', judge)

    try {
      child.send({ source: CHILD_SOURCE, init: { workerSource: WORKER_SOURCE, workerData: { script: a.script, names, help: helpTexts(a.guide) }, heapMb, capMb, watchMs: SCRIPT_MEMORY_WATCH_MS, memoryExitCode: SCRIPT_MEMORY_EXIT_CODE } })
    } catch (err) {
      finish(couldNotStart(err).error)
    }

    if (a.stop.aborted) onStop()
    else a.stop.addEventListener('abort', onStop, { once: true })
  })
}
