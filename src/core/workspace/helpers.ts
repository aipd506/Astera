// The helper set an `app js` script sees (agent workspace design, Script API). Written against two
// ports so it is tested with fakes and assumes no OS (W7): `Cdp`, the app's page over the Chrome
// DevTools Protocol, and `Desk`, the desktop the app runs on (Windows today: src/host/workspace).
//
// Each helper sets ctx.at to its own name before its first await, so a failure names it (the agent
// browser's rule, src/main/agentBrowser/helpers.ts).
import path from 'node:path'
import { WAIT_TIMEOUT_MS, withTimeout } from '../agentBrowser/script'
import type { RunContext } from '../agentBrowser/scriptRunner'
import { clampSnapshot, type Snapshot } from '../agentBrowser/snapshot'
import { clickScript, embedJson, fillScript, snapshotScript, waitForScript } from '../agentBrowser/guestScripts'
import { section } from '../agentBrowser/section'
import type { DeskLaunched, DeskShot, DeskWindow } from './protocol'

export interface Cdp {
  /** One CDP command; resolves with its result, rejects with its error or when the socket closes. */
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  /** The next event of that method, or a rejection after `timeoutMs`. */
  waitEvent(method: string, timeoutMs: number): Promise<Record<string, unknown>>
  /** Console errors and uncaught exceptions since the connection opened, oldest first. */
  consoleErrors(): string[]
  close(): void
}

export interface Desk {
  readonly name: string
  /** Runs a shell command on this desktop. The implementation turns it into its OS's command line. */
  launch(a: { command: string; cwd: string; env: Record<string, string> }): Promise<DeskLaunched>
  /** Ends a process and everything it started, if it is still the one launched: `startedAt` is the
   *  launch's creation time, and a pid whose process started at another time (a reused number) is left
   *  alone (START_TIME_TOLERANCE_MS, lifecycle.ts). */
  kill(pid: number, startedAt: number): Promise<void>
  windows(): Promise<DeskWindow[]>
  shot(a: { title?: string; format: 'png' | 'jpeg'; maxWidth?: number }): Promise<DeskShot>
  keys(a: { title: string; text?: string; key?: string }): Promise<void>
  /** Closes the desktop and ends the helper. */
  close(): Promise<void>
}

export type LaunchSpec = { config: string } | { command: string; cwd?: string }

export interface Launched extends DeskLaunched {
  port: number
  spec: LaunchSpec
}

/** What one session's app is, held by the manager and changed by the helpers. */
export interface AppState {
  launched: Launched | null
  cdp: Cdp | null
}

export interface ResolvedLaunch {
  command: string
  cwd: string
  env: Record<string, string>
}

export interface HelperDeps {
  state: AppState
  /** The session's desktop, created on the first call (W5: at the first launch). */
  desk(): Promise<Desk>
  /** The desktop if it exists; never creates one. */
  deskIfOpen(): Desk | null
  /** A Run configuration or a command, as a shell command, a folder and a full environment. */
  resolveLaunch(spec: LaunchSpec): Promise<ResolvedLaunch>
  freePort(): Promise<number>
  /** Connects to the page target on this port, polling for up to `waitMs`; null when it never opens. */
  connectCdp(port: number, waitMs: number): Promise<Cdp | null>
  /** Writes a capture where the session may read it (plan ruling P4) and answers the path. */
  saveCapture(data: string, ext: 'png'): Promise<string>
  /** The launched process changed: the manager rewrites workspaces.json. */
  recordLaunch(l: Launched | null): void
  /** A helper that changes the screen finished: the mirror takes a frame. Fire and forget. */
  changed(): void
  /** `close()`: kill the tree, close the desktop, end the helper, without stopping this script. */
  cleanup(): Promise<void>
  /** When this script's deadline falls, epoch ms (plan ruling P1). */
  deadline(): number
  now(): number
  /** app-guide.md, which `help()` prints. */
  guide: string
}

export const CDP_WAIT_MS = 60_000
export const LAUNCH_MARGIN_MS = 2_000
export const NO_CDP = 'no CDP connection'
const NOTHING_LAUNCHED = 'nothing launched: call launch() first'
const CTRL = 2
const DRAG_START_MS = 5_000

/** Key names `press` and `keys` accept besides a single character. The Windows helper's `Vk` switch
 *  in desk.ts knows the same names. */
export const NAMED_KEYS = [
  'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'
] as const

const KEY_CODES: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', vk: 27 },
  Tab: { code: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  Space: { code: 'Space', vk: 32, text: ' ' },
  ' ': { code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function parseLaunchSpec(v: unknown): LaunchSpec {
  if (isRecord(v) && typeof v.config === 'string' && v.config.trim() !== '' && v.command === undefined) return { config: v.config.trim() }
  if (isRecord(v) && typeof v.command === 'string' && v.command.trim() !== '' && v.config === undefined) {
    if (v.cwd === undefined) return { command: v.command }
    if (typeof v.cwd !== 'string' || v.cwd === '') throw new Error('launch: cwd must be a folder path')
    return { command: v.command, cwd: v.cwd }
  }
  throw new Error("launch: pass { config: '<Run configuration name or id>' } or { command: '<shell command>', cwd?: '<folder>' }")
}

/** `base` with `extra` laid over it. On Windows an environment block is case insensitive, so a name
 *  that differs only in case replaces the earlier one instead of sitting beside it (Review Focus 3). */
export function launchEnv(base: Record<string, string | undefined>, extra: Record<string, string>, platform: string): Record<string, string> {
  const out: Record<string, string> = {}
  const keyOf = (k: string): string => (platform === 'win32' ? k.toUpperCase() : k)
  const names = new Map<string, string>()
  const put = (k: string, v: string): void => {
    const prior = names.get(keyOf(k))
    if (prior !== undefined && prior !== k) delete out[prior]
    names.set(keyOf(k), k)
    out[k] = v
  }
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string') put(k, v)
  for (const [k, v] of Object.entries(extra)) put(k, v)
  return out
}

/** The CDP key events for one key: a trusted down and up. */
export function cdpKeyEvents(key: string): Array<Record<string, unknown>> {
  const named = KEY_CODES[key]
  if (named) {
    const down: Record<string, unknown> = { type: named.text ? 'keyDown' : 'rawKeyDown', key, code: named.code, windowsVirtualKeyCode: named.vk }
    if (named.text) down.text = named.text
    return [down, { type: 'keyUp', key, code: named.code, windowsVirtualKeyCode: named.vk }]
  }
  if ([...key].length === 1) {
    const upper = key.toUpperCase()
    const letter = /^[A-Z]$/.test(upper)
    const digit = /^[0-9]$/.test(key)
    const code = letter ? `Key${upper}` : digit ? `Digit${key}` : ''
    const vk = letter || digit ? upper.charCodeAt(0) : 0
    return [
      { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text: key },
      { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }
    ]
  }
  throw new Error(`press: unknown key ${key} (a single character, or one of ${NAMED_KEYS.join(', ')})`)
}

/** Width and height off a base64 PNG's IHDR, or zeros for anything that is not a PNG. */
export function pngSize(data: string): { width: number; height: number } {
  const b = Buffer.from(data.slice(0, 44), 'base64')
  if (b.length < 24 || b[0] !== 0x89 || b.toString('ascii', 12, 16) !== 'IHDR') return { width: 0, height: 0 }
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

async function evaluate(cdp: Cdp, expression: string, at: string): Promise<unknown> {
  const r = await withTimeout(cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), WAIT_TIMEOUT_MS + 5_000, at)
  const ex = r.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
  if (ex) throw new Error(`${at}: the page threw (${ex.exception?.description ?? ex.text ?? 'no detail'})`)
  return (r.result as { value?: unknown } | undefined)?.value
}

const centerScript = (sel: string): string =>
  `(() => { const el = document.querySelector(${embedJson(sel)}); if (!el) return null; ` +
  `el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); ` +
  `return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`

async function centerOf(cdp: Cdp, sel: string, at: string): Promise<{ x: number; y: number }> {
  const r = await evaluate(cdp, centerScript(sel), at)
  if (!isRecord(r) || typeof r.x !== 'number' || typeof r.y !== 'number') throw new Error(`${at}: nothing matches ${sel}`)
  return { x: r.x, y: r.y }
}

const waitOf = (opts: unknown): number => {
  if (!isRecord(opts) || typeof opts.waitMs !== 'number' || !Number.isFinite(opts.waitMs)) return CDP_WAIT_MS
  return Math.max(0, Math.min(opts.waitMs, CDP_WAIT_MS))
}

export function workspaceHelpers(deps: HelperDeps, ctx: RunContext): Record<string, unknown> {
  const needCdp = (): Cdp => {
    if (!deps.state.launched) throw new Error(NOTHING_LAUNCHED)
    if (!deps.state.cdp) throw new Error(NO_CDP)
    return deps.state.cdp
  }
  const needDesk = (at: string): Desk => {
    const d = deps.deskIfOpen()
    if (!d || !deps.state.launched) throw new Error(`${at}: ${NOTHING_LAUNCHED}`)
    return d
  }

  const start = async (at: string, spec: LaunchSpec, waitMs: number): Promise<{ pid: number; port: number }> => {
    const resolved = await deps.resolveLaunch(spec)
    const port = await deps.freePort()
    const desk = await deps.desk()
    const started = await desk.launch({ command: resolved.command, cwd: resolved.cwd, env: { ...resolved.env, ASTERA_APP_CDP_PORT: String(port) } })
    const launched: Launched = { ...started, port, spec }
    deps.state.launched = launched
    deps.recordLaunch(launched)
    const budget = Math.max(0, Math.min(waitMs, deps.deadline() - deps.now() - LAUNCH_MARGIN_MS))
    const cdp = await deps.connectCdp(port, budget)
    deps.state.cdp = cdp
    deps.changed()
    if (!cdp)
      throw new Error(
        `${at}: the app started (pid ${started.pid}) but nothing answered on its debugging port ${port} within ${Math.round(budget / 1000)} s. ` +
          'Start Electron with --remote-debugging-port=%ASTERA_APP_CDP_PORT% (for example: electron . --remote-debugging-port=%ASTERA_APP_CDP_PORT%). ' +
          `The app is still running, so windows(), windowShot() and keys() work; the page helpers throw "${NO_CDP}".`
      )
    return { pid: started.pid, port }
  }

  const dragEvents = async (cdp: Cdp, x: number, y: number, data: unknown): Promise<void> => {
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await cdp.send('Input.dispatchDragEvent', { type, x, y, data })
  }

  return {
    async launch(spec?: unknown, opts?: unknown): Promise<{ pid: number; port: number }> {
      ctx.at = 'launch'
      if (deps.state.launched) throw new Error('launch: already launched, use relaunch() to start it again')
      return start('launch', parseLaunchSpec(spec), waitOf(opts))
    },
    async relaunch(opts?: unknown): Promise<{ pid: number; port: number }> {
      ctx.at = 'relaunch'
      const prev = deps.state.launched
      if (!prev) throw new Error(`relaunch: ${NOTHING_LAUNCHED}`)
      deps.state.cdp?.close()
      deps.state.cdp = null
      await (await deps.desk()).kill(prev.pid, prev.startedAt)
      deps.state.launched = null
      deps.recordLaunch(null)
      return start('relaunch', prev.spec, waitOf(opts))
    },
    async close(): Promise<void> {
      ctx.at = 'close'
      await deps.cleanup()
    },
    async snapshot(): Promise<Snapshot> {
      ctx.at = 'snapshot'
      const snap = clampSnapshot(await evaluate(needCdp(), snapshotScript(), 'snapshot'))
      if (!snap) throw new Error('snapshot: the page returned nothing readable')
      return snap
    },
    async url(): Promise<string> {
      ctx.at = 'url'
      return String(await evaluate(needCdp(), 'location.href', 'url'))
    },
    async consoleErrors(): Promise<string[]> {
      ctx.at = 'consoleErrors'
      return needCdp().consoleErrors()
    },
    async click(sel: unknown): Promise<void> {
      ctx.at = 'click'
      const s = String(sel)
      const r = await evaluate(needCdp(), clickScript(s, true), 'click')
      if (!isRecord(r) || r.found !== true) throw new Error(`click: nothing matches ${s}`)
      if (r.disabled === true) throw new Error(`click: ${s} is disabled`)
      deps.changed()
    },
    async fill(sel: unknown, text: unknown): Promise<void> {
      ctx.at = 'fill'
      const s = String(sel)
      const r = await evaluate(needCdp(), fillScript(s, String(text)), 'fill')
      if (!isRecord(r) || r.found !== true) throw new Error(`fill: nothing matches ${s}`)
      if (typeof r.error === 'string')
        throw new Error(r.error === 'no option has that value' ? `fill: ${s} has no option with that value` : `fill: ${s} is ${r.error}`)
      deps.changed()
    },
    async press(key: unknown): Promise<void> {
      ctx.at = 'press'
      const cdp = needCdp()
      if (typeof key !== 'string' || key === '') throw new Error('press: key must be a non-empty string')
      for (const e of cdpKeyEvents(key)) await cdp.send('Input.dispatchKeyEvent', e)
      deps.changed()
    },
    async waitFor(selOrMs: unknown): Promise<void> {
      ctx.at = 'waitFor'
      const cdp = needCdp()
      if (typeof selOrMs === 'number' && Number.isFinite(selOrMs)) {
        await new Promise((r) => setTimeout(r, Math.max(0, Math.min(selOrMs, WAIT_TIMEOUT_MS))))
        return
      }
      if (typeof selOrMs !== 'string' || selOrMs === '') throw new Error('waitFor: expects a selector or a number of milliseconds')
      const r = await evaluate(cdp, waitForScript(selOrMs, WAIT_TIMEOUT_MS), 'waitFor')
      if (!isRecord(r) || r.found !== true) throw new Error(`waitFor: nothing matched ${selOrMs} within ${WAIT_TIMEOUT_MS} ms`)
    },
    async paste(): Promise<void> {
      ctx.at = 'paste'
      const cdp = needCdp()
      const base = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: CTRL }
      // `commands: ['paste']` is what makes it a real paste: a trusted paste event carrying the
      // clipboard, measured on a desktop nobody switched to (docs/agent-workspace-isolation.md).
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, commands: ['paste'] })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      deps.changed()
    },
    async drag(fromSel: unknown, toSel: unknown): Promise<void> {
      ctx.at = 'drag'
      const cdp = needCdp()
      const from = await centerOf(cdp, String(fromSel), 'drag')
      const to = await centerOf(cdp, String(toSel), 'drag')
      await cdp.send('Input.setInterceptDrags', { enabled: true })
      try {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
        // Armed before the move and settled into a value at once, so its timeout can never be an
        // unhandled rejection (R3).
        const intercepted = cdp.waitEvent('Input.dragIntercepted', DRAG_START_MS).then(
          (e) => ({ ok: true as const, e }),
          () => ({ ok: false as const })
        )
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y, button: 'left', buttons: 1 })
        const got = await intercepted
        if (!got.ok) throw new Error(`drag: ${String(fromSel)} did not start a drag (is it draggable?)`)
        await dragEvents(cdp, to.x, to.y, got.e.data)
      } finally {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => undefined)
        await cdp.send('Input.setInterceptDrags', { enabled: false }).catch(() => undefined)
      }
      deps.changed()
    },
    async dropFiles(sel: unknown, paths: unknown): Promise<void> {
      ctx.at = 'dropFiles'
      const cdp = needCdp()
      if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string' && path.isAbsolute(p)))
        throw new Error('dropFiles: paths must be a non-empty array of absolute file paths')
      const at = await centerOf(cdp, String(sel), 'dropFiles')
      await dragEvents(cdp, at.x, at.y, { items: [], files: paths, dragOperationsMask: 1 })
      deps.changed()
    },
    async screenshot(): Promise<{ path: string; width: number; height: number }> {
      ctx.at = 'screenshot'
      const r = await withTimeout(needCdp().send('Page.captureScreenshot', { format: 'png' }), WAIT_TIMEOUT_MS, 'screenshot')
      if (typeof r.data !== 'string' || r.data === '') throw new Error('screenshot: the page returned no image')
      const saved = await deps.saveCapture(r.data, 'png').catch((err: unknown) => {
        throw new Error(`screenshot: the capture could not be saved (${messageOf(err)})`)
      })
      return { path: saved, ...pngSize(r.data) }
    },
    async windowShot(title?: unknown): Promise<{ path: string; width: number; height: number; title: string }> {
      ctx.at = 'windowShot'
      const desk = needDesk('windowShot')
      if (title !== undefined && typeof title !== 'string') throw new Error('windowShot: title must be a string')
      const shot = await desk.shot(typeof title === 'string' && title !== '' ? { title, format: 'png' } : { format: 'png' })
      const saved = await deps.saveCapture(shot.data, 'png').catch((err: unknown) => {
        throw new Error(`windowShot: the capture could not be saved (${messageOf(err)})`)
      })
      return { path: saved, width: shot.width, height: shot.height, title: shot.title }
    },
    async windows(): Promise<Array<{ title: string; className: string; pid: number; width: number; height: number }>> {
      ctx.at = 'windows'
      const list = await needDesk('windows').windows()
      return list.filter((w) => w.visible).map((w) => ({ title: w.title, className: w.className, pid: w.pid, width: w.width, height: w.height }))
    },
    async keys(title: unknown, textOrKey: unknown): Promise<void> {
      ctx.at = 'keys'
      const desk = needDesk('keys')
      if (typeof title !== 'string' || title === '') throw new Error('keys: the first argument is the window title (see windows())')
      if (typeof textOrKey !== 'string' || textOrKey === '') throw new Error('keys: the second argument is text to type or a key name')
      await desk.keys((NAMED_KEYS as readonly string[]).includes(textOrKey) ? { title, key: textOrKey } : { title, text: textOrKey })
      deps.changed()
    },
    help(name?: unknown): string {
      ctx.at = 'help'
      if (name === undefined) return deps.guide
      return section(deps.guide, String(name)) ?? `no helper named ${String(name)}: run help() for the list`
    }
  }
}
