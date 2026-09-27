// The JSON lines the Host and a desktop helper exchange (agent workspace design, Components 1).
//
// Pure: no child process, no electron. The Windows helper (src/host/workspace/desk.ts) writes these
// shapes, and a Linux or macOS helper later writes the same ones (W7), so nothing here is Windows'.
//
// The helper writes one JSON object per line: first `{"ready":true,...}` (or `{"fatal":"..."}` when it
// cannot start), then one `{"id":n,"ok":...}` per request. Anything else on its stdout (a PowerShell
// warning, a BOM, an empty line) is not a message and reads as null here, never as a failure.

/** How long a helper has to say `ready` (spec, Errors). */
export const DESK_READY_MS = 5_000

export interface DeskWindow {
  hwnd: number
  title: string
  className: string
  pid: number
  width: number
  height: number
  visible: boolean
}

export interface DeskShot {
  /** Base64 image bytes, PNG or JPEG as asked. */
  data: string
  width: number
  height: number
  /** The title of the window that was photographed. */
  title: string
}

export interface DeskLaunched {
  pid: number
  /** The process's creation time in epoch ms, which the leftover rule compares (lifecycle.ts). */
  startedAt: number
}

export type DeskRequestBody =
  | { op: 'create'; name: string }
  | { op: 'launch'; commandLine: string; cwd: string | null; env: Record<string, string> }
  | { op: 'kill'; pid: number }
  | { op: 'windows' }
  | { op: 'shot'; title: string | null; format: 'png' | 'jpeg'; maxWidth: number | null }
  | { op: 'keys'; title: string; text: string | null; key: string | null }
  | { op: 'close' }

export type DeskRequest = DeskRequestBody & { id: number }

export type DeskLine =
  | { kind: 'ready'; interactive: boolean; pid: number; startedAt: number }
  | { kind: 'fatal'; error: string }
  | { kind: 'reply'; id: number; ok: true; value: unknown }
  | { kind: 'reply'; id: number; ok: false; error: string }

const BOM = String.fromCharCode(0xfeff)

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

export function encodeDeskRequest(r: DeskRequest): string {
  return `${JSON.stringify(r)}\n`
}

export function parseDeskLine(line: string): DeskLine | null {
  const text = (line.startsWith(BOM) ? line.slice(1) : line).trim()
  if (!text.startsWith('{')) return null
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(v)) return null
  if (v.ready === true) {
    if (typeof v.interactive !== 'boolean' || !isCount(v.pid) || !isCount(v.startedAt)) return null
    return { kind: 'ready', interactive: v.interactive, pid: v.pid, startedAt: v.startedAt }
  }
  if (typeof v.fatal === 'string') return { kind: 'fatal', error: v.fatal }
  if (!isCount(v.id) || typeof v.ok !== 'boolean') return null
  if (v.ok) return { kind: 'reply', id: v.id, ok: true, value: v.value }
  return { kind: 'reply', id: v.id, ok: false, error: typeof v.error === 'string' ? v.error : 'the desktop helper gave no reason' }
}

export function asLaunched(v: unknown): DeskLaunched {
  if (!isRecord(v) || !isCount(v.pid) || v.pid === 0 || !isCount(v.startedAt))
    throw new Error('the desktop helper answered launch with no pid')
  return { pid: v.pid, startedAt: v.startedAt }
}

/** `ConvertTo-Json` unwraps a one element array to the element itself, and an empty one can arrive
 *  as null, so both are read as lists here rather than trusted to be arrays. */
export function asWindows(v: unknown): DeskWindow[] {
  const list = v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]
  const out: DeskWindow[] = []
  for (const w of list) {
    if (!isRecord(w) || !isCount(w.hwnd) || !isCount(w.pid)) continue
    out.push({
      hwnd: w.hwnd,
      title: typeof w.title === 'string' ? w.title : '',
      className: typeof w.className === 'string' ? w.className : '',
      pid: w.pid,
      width: typeof w.width === 'number' ? w.width : 0,
      height: typeof w.height === 'number' ? w.height : 0,
      visible: w.visible === true
    })
  }
  return out
}

export function asShot(v: unknown): DeskShot {
  if (!isRecord(v) || typeof v.data !== 'string' || v.data === '' || !isCount(v.width) || !isCount(v.height))
    throw new Error('the desktop helper answered the capture with no image')
  return { data: v.data, width: v.width, height: v.height, title: typeof v.title === 'string' ? v.title : '' }
}
