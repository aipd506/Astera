import type { WorktreeCreateEvent, WorktreeCreateProgress } from '../../../core/types'

/** The slice of window.api one watched creation needs — injected so it can be tested without a window. */
export interface WorktreeCreateApi {
  on(channel: 'worktree:createProgress', cb: (ev: WorktreeCreateEvent) => void): () => void
  cancelCreate(opId: string): Promise<boolean>
}

/** Watches one worktrees.create call the dialog started with `opId`: passes on only that call's
 *  progress (`null` once the worktree is made), and cancel() asks main to abort it. A failed cancel
 *  request is swallowed — the creation then simply finishes or fails on its own, and the dialog hears
 *  that through the create call itself. */
export function trackWorktreeCreate(
  api: WorktreeCreateApi,
  opId: string,
  onProgress: (p: WorktreeCreateProgress | null) => void
): { opId: string; cancel(): void; stop(): void } {
  const off = api.on('worktree:createProgress', (ev) => {
    if (ev.opId === opId) onProgress(ev.progress)
  })
  return {
    opId,
    cancel() {
      void api.cancelCreate(opId).catch(() => false)
    },
    stop() {
      off()
    }
  }
}
