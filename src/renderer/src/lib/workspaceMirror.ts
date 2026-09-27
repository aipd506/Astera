// The mirror tabs' state: one entry per session the Host has shown a workspace for. Pure, so it is
// tested without a window. A closed workspace keeps its entry (and last frame) until its tab closes:
// the person sees "closed" rather than a tab that vanished (agent workspace plan ruling P7).
import type { WorkspaceEvent, WorkspaceFrame, WorkspaceSummary } from '../../../core/host/protocol'

export interface MirrorEntry {
  sessionId: string
  open: boolean
  running: boolean
  helper: string | null
  frame: WorkspaceFrame | null
}

export type Mirrors = Record<string, MirrorEntry>

export function applyWorkspaceEvent(prev: Mirrors, e: WorkspaceEvent): Mirrors {
  const was = prev[e.sessionId]
  if (e.kind === 'frame')
    return { ...prev, [e.sessionId]: { sessionId: e.sessionId, open: true, running: was?.running ?? false, helper: was?.helper ?? null, frame: e.frame } }
  return {
    ...prev,
    [e.sessionId]: { sessionId: e.sessionId, open: e.open, running: e.open && e.running, helper: e.open ? e.helper : null, frame: was?.frame ?? null }
  }
}

export function mirrorsFromList(list: WorkspaceSummary[]): Mirrors {
  const out: Mirrors = {}
  for (const w of list) out[w.sessionId] = { sessionId: w.sessionId, open: true, running: w.running, helper: w.helper, frame: w.frame }
  return out
}

/** Sessions that are open in `next` and were not open in `prev`: each gets its tab placed once. */
export function newlyOpened(prev: Mirrors, next: Mirrors): string[] {
  return Object.values(next)
    .filter((m) => m.open && prev[m.sessionId]?.open !== true)
    .map((m) => m.sessionId)
}
