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
