// The agent workspace's script runner (agent workspace design, Components 1): the agent browser's
// runner (core/agentBrowser/scriptRunner.ts) with the workspace's own gate around the helpers.
//
// The gate itself is `gateHelpers` from `core/agentBrowser/scriptGate.ts`, shared with the agent
// browser's `withAtReset` (src/main/agentBrowser/runs.ts) rather than ported a second time (preflight
// ruling F4). This module's own export of the same name is the workspace's binding of it: the
// workspace's synchronous-helper set, and one addition the agent browser has no use for — it tells the
// manager which helper is running, which is what the mirror tab shows (W4). The gate's own reasoning
// is unchanged and is not repeated here: a helper entered after the run is over parks on a promise
// that never settles, so an abandoned body stops instead of spinning.
import { createLog, SCRIPT_TIMEOUT_MS, type RunResult } from '../agentBrowser/script'
import { runScript, type RunContext } from '../agentBrowser/scriptRunner'
import { gateHelpers as gate } from '../agentBrowser/scriptGate'

/** How long, in all over one script, its launch waits may hold its deadline (stage 4, task 2). A first
 *  dev build of an Electron or webpack app can take longer than a whole script may run, so the time
 *  `launch` and `relaunch` spend waiting for the app's port and page is not the script's: its deadline
 *  counts only the time outside those waits, up to this cap. A launch may ask for all of it
 *  (`{ waitMs }`). Past the cap, a wait counts against the script again, so no wait holds it forever. */
export const LAUNCH_WAIT_MAX_MS = 300_000

/** One launch wait in progress. `leftMs` is how long it may last: what is left of the launch cap plus
 *  the script's own time left, and 0 once the run is over. `end` resumes the deadline; a second call
 *  does nothing. */
export interface LaunchWait {
  readonly leftMs: number
  end(): void
}

/** What the runner hands the helpers: the script's deadline, which a launch wait holds. */
export interface ScriptClock {
  launchWait(): LaunchWait
}

/** A script's deadline that launch waits hold (LAUNCH_WAIT_MAX_MS). `onExpire` is called once, when
 *  `timeoutMs` of time outside launch waits has passed; time inside them past the cap counts too. Two
 *  waits at once hold it once. Only a timer: Stop, which never waits for it, is the runner's own. */
export class ScriptDeadline implements ScriptClock {
  private left: number
  private launchLeft: number
  private since: number
  private waits = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private over = false
  private constructing = true
  private readonly now: () => number

  constructor(private readonly o: { timeoutMs: number; launchMaxMs?: number; onExpire(): void; now?: () => number }) {
    this.now = o.now ?? Date.now
    this.left = o.timeoutMs
    this.launchLeft = o.launchMaxMs ?? LAUNCH_WAIT_MAX_MS
    this.since = this.now()
    this.arm()
    this.constructing = false
  }

  /** Charges the time since the last settle: to the launch cap while a wait holds the deadline, and
   *  whatever the cap cannot take, to the script. */
  private settle(): void {
    const t = this.now()
    let spent = Math.max(0, t - this.since)
    this.since = t
    if (this.waits > 0) {
      const held = Math.min(spent, this.launchLeft)
      this.launchLeft -= held
      spent -= held
    }
    this.left -= spent
  }

  private arm(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.over) return
    const held = this.waits > 0 && this.launchLeft > 0
    if (!held && this.left <= 0) {
      // Never inside the constructor: a timeoutMs of 0 or less expired there, before the caller had
      // wired what expiry does (scriptWorker.ts sets its `expire` after), so such a script never timed
      // out (stage 4 final review). From the constructor it is a timer of its own, a turn later.
      if (this.constructing) {
        this.timer = setTimeout(() => {
          this.timer = undefined
          this.arm()
        }, 0)
        return
      }
      this.over = true
      this.o.onExpire()
      return
    }
    this.timer = setTimeout(
      () => {
        this.settle()
        this.arm()
      },
      held ? this.launchLeft : this.left
    )
  }

  launchWait(): LaunchWait {
    // A launch the script left behind (Stop, the deadline) reaches its wait after the run is over: it
    // may wait for nothing, rather than for the rest of the launch cap.
    if (this.over) return { leftMs: 0, end: () => {} }
    this.settle()
    this.waits += 1
    this.arm()
    let ended = false
    return {
      leftMs: this.launchLeft + Math.max(0, this.left),
      end: () => {
        if (ended) return
        ended = true
        this.settle()
        this.waits -= 1
        this.arm()
      }
    }
  }

  /** The run is over: no expiry after this. */
  dispose(): void {
    this.over = true
    clearTimeout(this.timer)
    this.timer = undefined
  }
}

/** Helpers a script may call without `await`. They cannot park, so a stopped run throws instead. */
export const WORKSPACE_SYNCHRONOUS_HELPERS: ReadonlySet<string> = new Set(['help'])

export function gateHelpers(
  raw: Record<string, unknown>,
  ctx: RunContext,
  signal: AbortSignal,
  onHelper: (name: string | null) => void
): Record<string, unknown> {
  return gate(raw, ctx, signal, WORKSPACE_SYNCHRONOUS_HELPERS, onHelper)
}

/** One script per session at a time: a second `app js` while one runs is refused, not queued. */
export class ScriptSlots {
  private readonly running = new Map<string, AbortController>()

  begin(sessionId: string): AbortController | null {
    if (this.running.has(sessionId)) return null
    const ac = new AbortController()
    this.running.set(sessionId, ac)
    return ac
  }

  end(sessionId: string, ac: AbortController): void {
    if (this.running.get(sessionId) === ac) this.running.delete(sessionId)
  }

  stop(sessionId: string): boolean {
    const ac = this.running.get(sessionId)
    if (!ac) return false
    ac.abort()
    return true
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  stopAll(): void {
    for (const ac of this.running.values()) ac.abort()
  }
}

/** Runs one script on this thread. The Host no longer calls this: it runs each `app js` script in a
 *  worker it can terminate (src/host/workspace/scriptWorker.ts), which keeps this contract.
 *  `stop` is the mirror's Stop and the manager's cleanup: it ends the script with
 *  `at: "stopped"` (spec, Mirror tab). Every way out aborts the gate, so a body that outlived the race
 *  cannot keep driving the app. */
export async function runWorkspaceScript(a: {
  script: string
  helpers: (ctx: RunContext) => Record<string, unknown>
  stop: AbortSignal
  onHelper(name: string | null): void
  timeoutMs?: number
}): Promise<RunResult> {
  const ctx: RunContext = { at: 'script' }
  const inner = new AbortController()
  const onStop = (): void => {
    // Set before the abort: the runner builds its Interrupted from ctx.at inside the abort listener.
    ctx.at = 'stopped'
    inner.abort()
  }
  if (a.stop.aborted) onStop()
  else a.stop.addEventListener('abort', onStop, { once: true })
  try {
    const helpers = gateHelpers(a.helpers(ctx), ctx, inner.signal, a.onHelper)
    return await runScript(a.script, helpers, createLog(), ctx, { signal: inner.signal, timeoutMs: a.timeoutMs ?? SCRIPT_TIMEOUT_MS })
  } finally {
    a.stop.removeEventListener('abort', onStop)
    inner.abort()
  }
}
