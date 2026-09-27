import { describe, it, expect, vi } from 'vitest'
import type { RunContext } from '../agentBrowser/scriptRunner'
import { clickScript, snapshotScript } from '../agentBrowser/guestScripts'
import type { DeskWindow } from './protocol'
import {
  NO_CDP,
  cdpKeyEvents,
  launchEnv,
  parseLaunchSpec,
  pngSize,
  workspaceHelpers,
  type AppState,
  type Cdp,
  type Desk,
  type HelperDeps
} from './helpers'

const png = (w: number, h: number): string => {
  const b = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b.toString('base64')
}

class FakeCdp implements Cdp {
  calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  answers = new Map<string, (p?: Record<string, unknown>) => Record<string, unknown>>()
  events = new Map<string, Record<string, unknown>>()
  errors: string[] = []
  closed = false
  async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ method, params })
    const a = this.answers.get(method)
    return a ? a(params) : {}
  }
  async waitEvent(method: string): Promise<Record<string, unknown>> {
    const e = this.events.get(method)
    if (!e) throw new Error(`${method} did not arrive`)
    return e
  }
  consoleErrors(): string[] {
    return [...this.errors]
  }
  close(): void {
    this.closed = true
  }
  /** Runtime.evaluate answers in the order given. */
  evaluates(...values: unknown[]): void {
    this.answers.set('Runtime.evaluate', () => ({ result: { value: values.shift() } }))
  }
}

const WINDOWS: DeskWindow[] = [
  { hwnd: 1, title: 'Fixture', className: 'Chrome_WidgetWin_1', pid: 501, width: 800, height: 600, visible: true },
  { hwnd: 2, title: '', className: 'Hidden', pid: 501, width: 0, height: 0, visible: false }
]

class FakeDesk implements Desk {
  name = 'astera-ws-test'
  launches: Array<{ command: string; cwd: string; env: Record<string, string> }> = []
  kills: number[] = []
  keyCalls: Array<{ title: string; text?: string; key?: string }> = []
  shotCalls: Array<{ title?: string; format: 'png' | 'jpeg'; maxWidth?: number }> = []
  async launch(a: { command: string; cwd: string; env: Record<string, string> }) {
    this.launches.push(a)
    return { pid: 500 + this.launches.length, startedAt: 1_000 }
  }
  async kill(pid: number) {
    this.kills.push(pid)
  }
  async windows() {
    return WINDOWS
  }
  async shot(a: { title?: string; format: 'png' | 'jpeg'; maxWidth?: number }) {
    this.shotCalls.push(a)
    return { data: png(800, 600), width: 800, height: 600, title: 'Fixture' }
  }
  async keys(a: { title: string; text?: string; key?: string }) {
    this.keyCalls.push(a)
  }
  async close() {}
}

const rig = (over: Partial<HelperDeps> = {}) => {
  const cdp = new FakeCdp()
  const desk = new FakeDesk()
  const state: AppState = { launched: null, cdp: null }
  let opened: Desk | null = null
  const deps: HelperDeps = {
    state,
    desk: async () => (opened = desk),
    deskIfOpen: () => opened,
    resolveLaunch: vi.fn(async () => ({ command: 'npm run dev', cwd: 'C:/proj', env: { PATH: 'x' } })),
    freePort: async () => 9333,
    connectCdp: vi.fn(async () => cdp),
    saveCapture: vi.fn(async () => 'C:/shots/app-1.png'),
    recordLaunch: vi.fn(),
    changed: vi.fn(),
    cleanup: vi.fn(async () => {}),
    deadline: () => 100_000,
    now: () => 0,
    guide: '# guide\n\n## launch(spec)\nStarts it.\n\n## windows()\nLists them.\n',
    ...over
  }
  const ctx: RunContext = { at: 'script' }
  const h = workspaceHelpers(deps, ctx) as Record<string, (...a: unknown[]) => Promise<unknown>>
  return { cdp, desk, state, deps, ctx, h }
}

describe('launch', () => {
  it('runs the configuration on the desktop with the port in its environment, then connects', async () => {
    const r = rig()
    expect(await r.h.launch({ config: 'Electron dev' })).toEqual({ pid: 501, port: 9333 })
    expect(r.deps.resolveLaunch).toHaveBeenCalledWith({ config: 'Electron dev' })
    expect(r.desk.launches[0]).toEqual({ command: 'npm run dev', cwd: 'C:/proj', env: { PATH: 'x', ASTERA_APP_CDP_PORT: '9333' } })
    expect(r.state.launched).toMatchObject({ pid: 501, port: 9333, spec: { config: 'Electron dev' } })
    expect(r.deps.recordLaunch).toHaveBeenCalledWith(r.state.launched)
    expect(r.deps.connectCdp).toHaveBeenCalledWith(9333, 60_000)
    expect(r.state.cdp).toBe(r.cdp)
    expect(r.deps.changed).toHaveBeenCalled()
  })

  it('is refused once launched, and says to relaunch', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    await expect(r.h.launch({ command: 'app.exe' })).rejects.toThrow('relaunch()')
  })

  it('refuses a spec that is neither a configuration nor a command', async () => {
    await expect(rig().h.launch({})).rejects.toThrow("pass { config:")
    expect(() => parseLaunchSpec({ config: 'a', command: 'b' })).toThrow()
    expect(parseLaunchSpec({ command: 'x', cwd: 'sub' })).toEqual({ command: 'x', cwd: 'sub' })
  })

  it('waits for the port no longer than the script has left, minus a margin (ruling P1)', async () => {
    const r = rig({ deadline: () => 10_000, now: () => 0 })
    await r.h.launch({ command: 'app.exe' }, { waitMs: 60_000 })
    expect(r.deps.connectCdp).toHaveBeenCalledWith(9333, 8_000)
  })

  it('a port that never opens fails launch with the hint, and the native helpers still work', async () => {
    const r = rig({ connectCdp: vi.fn(async () => null) })
    await expect(r.h.launch({ command: 'app.exe' })).rejects.toThrow('--remote-debugging-port=%ASTERA_APP_CDP_PORT%')
    expect(r.state.launched?.pid).toBe(501)
    expect(await r.h.windows()).toEqual([{ title: 'Fixture', className: 'Chrome_WidgetWin_1', pid: 501, width: 800, height: 600 }])
    await expect(r.h.snapshot()).rejects.toThrow(NO_CDP)
  })
})

describe('relaunch and close', () => {
  it('relaunch kills the tree, drops the old connection, and starts the same spec again', async () => {
    const r = rig()
    await r.h.launch({ config: 'dev' })
    const first = r.cdp
    await r.h.relaunch()
    expect(r.desk.kills).toEqual([501])
    expect(first.closed).toBe(true)
    expect(r.desk.launches).toHaveLength(2)
    expect(r.state.launched?.pid).toBe(502)
    expect(r.deps.recordLaunch).toHaveBeenCalledWith(null)
  })

  it('relaunch before launch is refused', async () => {
    await expect(rig().h.relaunch()).rejects.toThrow('call launch() first')
  })

  it('close hands the cleanup to the manager', async () => {
    const r = rig()
    await r.h.close()
    expect(r.deps.cleanup).toHaveBeenCalledTimes(1)
  })
})

describe('the page helpers', () => {
  it('say nothing is launched before launch', async () => {
    const r = rig()
    await expect(r.h.snapshot()).rejects.toThrow('nothing launched')
    await expect(r.h.windows()).rejects.toThrow('windows: nothing launched')
  })

  it('snapshot and url evaluate in the page', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    r.cdp.evaluates({ title: 'T', url: 'app://x', headings: [], interactive: [], landmarks: [], text: '' }, 'app://x/')
    const snap = (await r.h.snapshot()) as { title: string }
    expect(snap.title).toBe('T')
    expect(r.cdp.calls.find((c) => c.method === 'Runtime.evaluate')?.params).toMatchObject({ expression: snapshotScript(), awaitPromise: true, returnByValue: true })
    expect(await r.h.url()).toBe('app://x/')
  })

  it('a page that throws is reported as the page throwing', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    r.cdp.answers.set('Runtime.evaluate', () => ({ exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: x' } } }))
    await expect(r.h.url()).rejects.toThrow('url: the page threw (ReferenceError: x)')
  })

  it('click follows links, reports a miss and a disabled control, and marks the screen changed', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    r.cdp.evaluates({ found: true, clicked: true }, { found: false }, { found: true, disabled: true })
    await r.h.click('#go')
    expect(r.cdp.calls.filter((c) => c.method === 'Runtime.evaluate')[0].params?.expression).toBe(clickScript('#go', true))
    await expect(r.h.click('#nope')).rejects.toThrow('click: nothing matches #nope')
    await expect(r.h.click('#off')).rejects.toThrow('click: #off is disabled')
    expect(r.deps.changed).toHaveBeenCalledTimes(2)
  })

  it('consoleErrors returns what the connection collected', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    r.cdp.errors.push('TypeError: boom')
    expect(await r.h.consoleErrors()).toEqual(['TypeError: boom'])
  })
})

describe('keys through CDP', () => {
  it('press sends a trusted key down and up', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    await r.h.press('Enter')
    const keys = r.cdp.calls.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => c.params)
    expect(keys).toEqual([
      { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }
    ])
    await expect(r.h.press('Hyper')).rejects.toThrow('press: unknown key Hyper')
  })

  it('cdpKeyEvents maps a letter, a digit and a named key without text', () => {
    expect(cdpKeyEvents('a')[0]).toEqual({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' })
    expect(cdpKeyEvents('7')[0]).toMatchObject({ code: 'Digit7', windowsVirtualKeyCode: 55 })
    expect(cdpKeyEvents('ArrowDown')[0]).toEqual({ type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
  })

  it('paste is a real paste command with Ctrl held', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    await r.h.paste()
    const keys = r.cdp.calls.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => c.params)
    expect(keys[0]).toMatchObject({ type: 'rawKeyDown', key: 'v', modifiers: 2, commands: ['paste'] })
    expect(keys[1]).toMatchObject({ type: 'keyUp', key: 'v', modifiers: 2 })
  })
})

describe('drag and drop inside the page', () => {
  it('drag intercepts the drag the press starts and drops its data on the target', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    r.cdp.evaluates({ x: 10, y: 20 }, { x: 300, y: 400 })
    const data = { items: [{ mimeType: 'text/plain', data: 'card-1' }], dragOperationsMask: 1 }
    r.cdp.events.set('Input.dragIntercepted', { data })
    await r.h.drag('#card', '#column')
    const seq = r.cdp.calls.filter((c) => c.method !== 'Runtime.evaluate').map((c) => `${c.method}:${String(c.params?.type ?? c.params?.enabled)}`)
    expect(seq).toEqual([
      'Input.setInterceptDrags:true',
      'Input.dispatchMouseEvent:mousePressed',
      'Input.dispatchMouseEvent:mouseMoved',
      'Input.dispatchDragEvent:dragEnter',
      'Input.dispatchDragEvent:dragOver',
      'Input.dispatchDragEvent:drop',
      'Input.dispatchMouseEvent:mouseReleased',
      'Input.setInterceptDrags:false'
    ])
    expect(r.cdp.calls.find((c) => c.params?.type === 'drop')?.params).toMatchObject({ x: 300, y: 400, data })
  })

  it('a source that does not start a drag is named, and the mouse is still released', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    r.cdp.evaluates({ x: 1, y: 1 }, { x: 2, y: 2 })
    await expect(r.h.drag('#plain', '#column')).rejects.toThrow('drag: #plain did not start a drag')
    expect(r.cdp.calls.some((c) => c.params?.type === 'mouseReleased')).toBe(true)
  })

  it('a selector that matches nothing is named', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    r.cdp.evaluates(null)
    await expect(r.h.drag('#none', '#column')).rejects.toThrow('drag: nothing matches #none')
  })

  it('dropFiles drops absolute paths on the element', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    await expect(r.h.dropFiles('#drop', ['relative.txt'])).rejects.toThrow('absolute file paths')
    await expect(r.h.dropFiles('#drop', [])).rejects.toThrow('absolute file paths')
    r.cdp.evaluates({ x: 5, y: 6 })
    const file = process.platform === 'win32' ? 'C:\\data\\a b.txt' : '/data/a b.txt'
    await r.h.dropFiles('#drop', [file])
    const drops = r.cdp.calls.filter((c) => c.method === 'Input.dispatchDragEvent')
    expect(drops.map((c) => c.params?.type)).toEqual(['dragEnter', 'dragOver', 'drop'])
    expect(drops[2].params).toMatchObject({ x: 5, y: 6, data: { items: [], files: [file], dragOperationsMask: 1 } })
  })
})

describe('captures and native windows', () => {
  it('screenshot saves the page as PNG and reads its size off the header', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    r.cdp.answers.set('Page.captureScreenshot', () => ({ data: png(1280, 720) }))
    expect(await r.h.screenshot()).toEqual({ path: 'C:/shots/app-1.png', width: 1280, height: 720 })
    expect(r.deps.saveCapture).toHaveBeenCalledWith(png(1280, 720), 'png')
    expect(pngSize('bm90IGEgcG5n')).toEqual({ width: 0, height: 0 })
  })

  it('windowShot photographs a native window by title', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    expect(await r.h.windowShot('Save As')).toEqual({ path: 'C:/shots/app-1.png', width: 800, height: 600, title: 'Fixture' })
    expect(r.desk.shotCalls[0]).toEqual({ title: 'Save As', format: 'png' })
    await r.h.windowShot()
    expect(r.desk.shotCalls[1]).toEqual({ format: 'png' })
  })

  it('keys posts a named key or text to a window', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    await r.h.keys('Save As', 'Enter')
    await r.h.keys('Save As', 'report 1.txt')
    expect(r.desk.keyCalls).toEqual([
      { title: 'Save As', key: 'Enter' },
      { title: 'Save As', text: 'report 1.txt' }
    ])
    await expect(r.h.keys('', 'x')).rejects.toThrow('window title')
  })
})

describe('help', () => {
  it('prints the guide, or one section of it', async () => {
    const r = rig()
    const help = r.h.help as unknown as (n?: string) => string
    expect(help()).toContain('# guide')
    expect(help('windows')).toBe('## windows()\nLists them.')
    expect(help('nope')).toContain('no helper named nope')
  })
})

describe('launchEnv', () => {
  it('collapses names that differ only in case on Windows, and not elsewhere', () => {
    expect(launchEnv({ Path: 'C:\\a', HOME: 'h' }, { PATH: 'C:\\b' }, 'win32')).toEqual({ HOME: 'h', PATH: 'C:\\b' })
    expect(launchEnv({ Path: 'a' }, { PATH: 'b' }, 'linux')).toEqual({ Path: 'a', PATH: 'b' })
    expect(launchEnv({ A: undefined, B: '1' }, {}, 'win32')).toEqual({ B: '1' })
  })
})
