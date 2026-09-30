import { describe, it, expect } from 'vitest'
import { NO_CDP } from '../../core/workspace/helpers'
import { connectCdp, consoleErrorOf, openCdpSession, pageTargetOf, type CdpDeps, type WebSocketLike } from './cdp'

class FakeSocket implements WebSocketLike {
  sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = []
  closed = false
  private listeners = new Map<string, Array<(ev: { data?: unknown }) => void>>()
  addEventListener(type: string, cb: (ev: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb])
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    this.closed = true
  }
  fire(type: string, data?: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb({ data: typeof data === 'string' || data === undefined ? data : JSON.stringify(data) })
  }
}

const opened = async (): Promise<{ ws: FakeSocket; cdp: Awaited<ReturnType<typeof openCdpSession>> }> => {
  const ws = new FakeSocket()
  const p = openCdpSession(ws)
  ws.fire('open')
  return { ws, cdp: await p }
}

describe('pageTargetOf', () => {
  it('picks the first page target and skips DevTools itself', () => {
    expect(
      pageTargetOf([
        { type: 'service_worker', webSocketDebuggerUrl: 'ws://x/sw' },
        { type: 'page', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: 'ws://x/dt' },
        { type: 'page', url: 'file:///C:/app/index.html', webSocketDebuggerUrl: 'ws://x/page' }
      ])
    ).toBe('ws://x/page')
    expect(pageTargetOf([])).toBeNull()
    expect(pageTargetOf({})).toBeNull()
  })
})

describe('openCdpSession', () => {
  it('enables Runtime, Log and Page on open', async () => {
    const { ws } = await opened()
    expect(ws.sent.map((m) => m.method)).toEqual(['Runtime.enable', 'Log.enable', 'Page.enable'])
  })

  it('answers each command by its id, and rejects a CDP error with its message', async () => {
    const { ws, cdp } = await opened()
    const a = cdp.send('Runtime.evaluate', { expression: '1+1' })
    const b = cdp.send('Page.navigate', { url: 'x' })
    const [ida, idb] = ws.sent.slice(-2).map((m) => m.id)
    ws.fire('message', { id: idb, error: { message: 'Cannot navigate' } })
    ws.fire('message', { id: ida, result: { result: { value: 2 } } })
    expect(await a).toEqual({ result: { value: 2 } })
    await expect(b).rejects.toThrow('Cannot navigate')
  })

  it('collects console errors and uncaught exceptions, and ignores the rest', async () => {
    const { ws, cdp } = await opened()
    ws.fire('message', { method: 'Runtime.consoleAPICalled', params: { type: 'error', args: [{ type: 'string', value: 'boom' }, { type: 'object', description: 'Error: x' }] } })
    ws.fire('message', { method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ value: 'fine' }] } })
    ws.fire('message', { method: 'Runtime.exceptionThrown', params: { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: y' } } } })
    ws.fire('message', { method: 'Log.entryAdded', params: { entry: { level: 'error', text: 'net::ERR_FAILED' } } })
    ws.fire('message', 'not json')
    expect(cdp.consoleErrors()).toEqual(['boom Error: x', 'TypeError: y', 'net::ERR_FAILED'])
  })

  it('waitEvent resolves on the next event of that method and times out otherwise', async () => {
    const { ws, cdp } = await opened()
    const got = cdp.waitEvent('Input.dragIntercepted', 1_000)
    ws.fire('message', { method: 'Input.dragIntercepted', params: { data: { items: [] } } })
    expect(await got).toEqual({ data: { items: [] } })
    await expect(cdp.waitEvent('Input.dragIntercepted', 10)).rejects.toThrow('did not arrive')
  })

  it('a socket that closes rejects what is pending and refuses what comes after', async () => {
    const { ws, cdp } = await opened()
    const pending = cdp.send('Runtime.evaluate', {})
    ws.fire('close')
    await expect(pending).rejects.toThrow(NO_CDP)
    await expect(cdp.send('Runtime.evaluate', {})).rejects.toThrow(NO_CDP)
  })

  it('a socket that closes rejects an in-flight waitEvent at once, with NO_CDP', async () => {
    const { ws, cdp } = await opened()
    const waiting = cdp.waitEvent('Input.dragIntercepted', 5_000)
    ws.fire('close')
    await expect(waiting).rejects.toThrow(NO_CDP)
  })

  it('a socket that never opens is a rejection', async () => {
    const ws = new FakeSocket()
    const p = openCdpSession(ws, 10)
    await expect(p).rejects.toThrow('did not open')
    expect(ws.closed).toBe(true)
  })
})

describe('connectCdp', () => {
  const fakeDeps = (answers: unknown[], sockets: FakeSocket[]): CdpDeps & { clock: number } => {
    const d = {
      clock: 0,
      fetchJson: async () => {
        const a = answers.shift()
        if (a instanceof Error) throw a
        return a
      },
      openSocket: () => {
        const ws = new FakeSocket()
        sockets.push(ws)
        queueMicrotask(() => ws.fire('open'))
        return ws
      },
      sleep: async (ms: number) => {
        d.clock += ms
      },
      now: () => d.clock
    }
    return d
  }

  it('polls the port until a page target appears, then opens it', async () => {
    const sockets: FakeSocket[] = []
    const deps = fakeDeps([new Error('ECONNREFUSED'), [], [{ type: 'page', url: 'x', webSocketDebuggerUrl: 'ws://127.0.0.1:9/p' }]], sockets)
    const cdp = await connectCdp(9, 60_000, deps)
    expect(cdp).not.toBeNull()
    expect(sockets).toHaveLength(1)
  })

  it('answers null once the wait is spent', async () => {
    const answers = Array.from({ length: 100 }, () => new Error('ECONNREFUSED'))
    expect(await connectCdp(9, 1_000, fakeDeps(answers, []))).toBeNull()
  })
})

describe('consoleErrorOf', () => {
  it('reads a Log entry that is not an error as nothing', () => {
    expect(consoleErrorOf('Log.entryAdded', { entry: { level: 'warning', text: 'w' } })).toBeNull()
    expect(consoleErrorOf('Page.loadEventFired', {})).toBeNull()
  })
})
