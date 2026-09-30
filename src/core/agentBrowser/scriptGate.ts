// The run-abandonment gate every script runner wraps its helpers in: a helper entered after the run
// is over parks on a promise that never settles, so an abandoned body stops instead of spinning the
// main process flat (the agent browser's runs.ts carries the full reasoning in its own history; not
// repeated here). Shared by the agent browser (src/main/agentBrowser/runs.ts's `withAtReset`) and the
// agent workspace (src/core/workspace/script.ts's `gateHelpers`), so neither copies the other
// (preflight ruling F4).
import { Interrupted } from './script'
import type { RunContext } from './scriptRunner'

const safely = (fn: () => void): void => {
  try {
    fn()
  } catch {
    /* a reporting callback's trouble is not the script's */
  }
}

/** Wraps `raw`'s functions so a call made after `signal` aborts either throws (a helper named in
 *  `synchronous`, which cannot park because nothing would be suspended) or parks on a promise that
 *  never settles (every other helper). A helper that resolves or rejects resets `ctx.at` to `'script'`
 *  so a Stop landing afterward is not still attributed to a helper that already returned.
 *
 *  `onHelper`, when given, is told which helper is running and, when it finishes, `null` again — what
 *  the agent workspace's mirror tab shows (spec W4). It is called only around a helper that is still
 *  live (not one already parked by the gate), and its own failure never fails the helper: a mirror
 *  that throws must not become the script's error. The agent browser has no mirror to tell, so it
 *  omits `onHelper` and gets exactly its old behaviour. */
export function gateHelpers(
  raw: Record<string, unknown>,
  ctx: RunContext,
  signal: AbortSignal,
  synchronous: ReadonlySet<string>,
  onHelper?: (name: string | null) => void
): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'function') {
      wrapped[name] = value
      continue
    }
    const sync = synchronous.has(name)
    wrapped[name] = (...args: unknown[]) => {
      if (signal.aborted) {
        if (sync) throw new Interrupted(ctx.at, 'stopped')
        return new Promise<never>(() => {})
      }
      if (!sync && onHelper) safely(() => onHelper(name))
      const result = (value as (...a: unknown[]) => unknown)(...args)
      if (result instanceof Promise) {
        return result.then(
          (v) => {
            ctx.at = 'script'
            if (onHelper) safely(() => onHelper(null))
            return v
          },
          (err: unknown) => {
            if (onHelper) safely(() => onHelper(null))
            throw err
          }
        )
      }
      ctx.at = 'script'
      return result
    }
  }
  return wrapped
}
