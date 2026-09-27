import type { WorktreeCreateEvent, WorktreeCreateProgress } from '../types'
import { throttleProgress } from './progress'

/** The worktree creations a UI is watching, by the id the UI gave them. Kept out of main so it can be
 *  tested without electron; main hands it createWorktree and a `send` to the renderer.
 *
 *  A call with an opId gets a progress callback (throttled — see progress.ts — and tagged with the id)
 *  and an AbortSignal that cancel(opId) trips. On success a last `progress: null` says the worktree is
 *  made and cancelling is over; on failure nothing more is sent (the rejection says it). A call with
 *  no opId gets neither, exactly as before. */
export function createWorktreeOps<A extends object, R>(deps: {
  create: (args: A & { onProgress?: (p: WorktreeCreateProgress) => void; signal?: AbortSignal }) => Promise<R>
  send: (ev: WorktreeCreateEvent) => void
}): {
  create(args: A, opId: string | undefined): Promise<R>
  cancel(opId: string): boolean
} {
  const running = new Map<string, AbortController>()
  return {
    async create(args, opId) {
      if (typeof opId !== 'string' || opId === '' || running.has(opId)) return deps.create(args)
      const ac = new AbortController()
      running.set(opId, ac)
      const throttle = throttleProgress((progress) => deps.send({ opId, progress }))
      try {
        const r = await deps.create({ ...args, signal: ac.signal, onProgress: (p) => throttle.push(p) })
        throttle.dispose()
        try {
          deps.send({ opId, progress: null })
        } catch {
          // the window is gone; the result still goes back through the invoke
        }
        return r
      } finally {
        throttle.dispose()
        running.delete(opId)
      }
    },
    cancel(opId) {
      const ac = running.get(opId)
      if (!ac) return false
      ac.abort()
      return true
    }
  }
}
