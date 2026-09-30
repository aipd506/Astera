// When a workspace ends by itself, and which leftovers a new Host may kill (agent workspace design,
// Lifecycle). Pure.

import type { LinuxTool, LinuxTools } from './platform'

/** A desktop with no script for this long is cleaned up (W5). */
export const WORKSPACE_IDLE_MS = 10 * 60_000

/** How far a live process's creation time may be from the recorded one and still be the same
 *  process. Both come from the kernel's own record of when it started: GetProcessTimes when
 *  recorded and the CIM CreationDate when checked on Windows; /proc/<pid>/stat's ticks since boot on
 *  Linux; `ps lstart` on macOS. Windows and Linux agree to the millisecond; `ps lstart` only has
 *  whole-second resolution, so the slack also covers that rounding. A pid the OS reuses belongs to a
 *  process created after the recorded one died, which is far outside. */
export const START_TIME_TOLERANCE_MS = 2_000

export function idleExpired(a: { lastActivityAt: number; now: number; running: boolean; idleMs?: number }): boolean {
  if (a.running) return false
  return a.now - a.lastActivityAt >= (a.idleMs ?? WORKSPACE_IDLE_MS)
}

export interface RecordedPid {
  pid: number
  startedAt: number
}

/** One line of `<profile>/orch/workspaces.json`: a desktop and the processes that keep it alive, the
 *  launched root first and the helper last, which is the order the sweep kills them in. */
export interface WorkspaceRecord {
  sessionId: string
  desktop: string
  pids: RecordedPid[]
}

/** The recorded pids whose live creation time still matches, each once, in record order. The same
 *  rule as the conhost reaper's creation window (src/host/conhostReaper.ts): a pid alone never
 *  decides, because Windows hands numbers out again. */
export function leftoverPidsToKill(
  records: readonly WorkspaceRecord[],
  startTimes: ReadonlyMap<number, number>,
  toleranceMs: number = START_TIME_TOLERANCE_MS
): number[] {
  const out: number[] = []
  for (const r of records)
    for (const p of r.pids) {
      const live = startTimes.get(p.pid)
      if (live === undefined || Math.abs(live - p.startedAt) > toleranceMs) continue
      if (!out.includes(p.pid)) out.push(p.pid)
    }
  return out
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isPid = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

/** Tolerant on purpose: a file this cannot read kills nothing, and the sweep then removes it. */
export function parseWorkspacesFile(text: string): WorkspaceRecord[] {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return []
  }
  if (!isRecord(v) || !Array.isArray(v.workspaces)) return []
  const out: WorkspaceRecord[] = []
  for (const w of v.workspaces) {
    if (!isRecord(w) || typeof w.sessionId !== 'string' || typeof w.desktop !== 'string' || !Array.isArray(w.pids)) continue
    const pids = w.pids.filter((p): p is RecordedPid => isRecord(p) && isPid(p.pid) && typeof p.startedAt === 'number' && Number.isFinite(p.startedAt))
    out.push({ sessionId: w.sessionId, desktop: w.desktop, pids: pids.map((p) => ({ pid: p.pid, startedAt: p.startedAt })) })
  }
  return out
}

export function serializeWorkspacesFile(records: readonly WorkspaceRecord[]): string {
  return `${JSON.stringify({ version: 1, workspaces: records }, null, 2)}\n`
}

const TOOL_LABEL: Record<LinuxTool, string> = { Xvfb: 'Xvfb', xdotool: 'xdotool', import: "ImageMagick's import" }

const joined = (names: string[]): string => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/** Why `app js` cannot run on this Host at all, or null (Linux and macOS design, Refusal). win32
 *  refuses over SSH, and its helper answers a window station that is not visible with NOT_INTERACTIVE;
 *  linux refuses only for a missing tool (L1, L2: Xvfb is the display, so SSH and servers are fine);
 *  darwin refuses over SSH (no GUI session to launch in); anything else is unsupported. */
export function workspaceRefusal(a: { platform: string; env: Record<string, string | undefined>; linuxTools?: LinuxTools | null }): string | null {
  const ssh = Boolean(a.env.SSH_CONNECTION || a.env.SSH_CLIENT || a.env.SSH_TTY)
  if (a.platform === 'win32')
    return ssh ? 'app js: no interactive desktop here (this Host runs in an SSH session), so there is no screen to protect and nothing to launch on' : null
  if (a.platform === 'darwin') return ssh ? 'app js: no GUI session here (this Host runs in an SSH session), so there is nothing to launch the app in' : null
  if (a.platform === 'linux') {
    const missing = a.linuxTools?.missing ?? []
    if (missing.length === 0) return null
    const one = missing.length === 1
    return (
      `app js: the agent app workspace on Linux needs ${joined(missing.map((t) => TOOL_LABEL[t]))}, and ${one ? 'it is' : 'they are'} not installed here. ` +
      `Install ${one ? 'it' : 'them'} with: ${a.linuxTools!.installLine}`
    )
  }
  return `app js: the agent app workspace does not run on ${a.platform} (it runs on Windows, Linux and macOS)`
}

export const NOT_INTERACTIVE =
  'app js: no interactive desktop here (a service session or a remote shell), so there is no screen to protect and nothing to launch on'
