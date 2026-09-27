// A minimal CDP client (agent workspace design, Components 2): the page target found through
// http://127.0.0.1:<port>/json, one WebSocket to it, commands by id, and the console errors the page
// raised since. Node's built in WebSocket and fetch (Node 22+), so no dependency (Global Constraint 4).
//
// The debugging port is a TCP socket, so none of this cares which desktop the app is on (measured,
// docs/agent-workspace-isolation.md).
import { NO_CDP, type Cdp } from '../../core/workspace/helpers'

export interface WebSocketLike {
  send(data: string): void
  close(): void
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev: { data?: unknown }) => void): void
}

export interface CdpDeps {
  fetchJson(url: string): Promise<unknown>
  openSocket(url: string): WebSocketLike
  sleep(ms: number): Promise<void>
  now(): number
}

const CONSOLE_KEEP = 200
const POLL_MS = 250
const OPEN_MS = 5_000

export function defaultCdpDeps(): CdpDeps {
  const WS = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket
  return {
    fetchJson: async (url) => {
      const r = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      return r.json()
    },
    openSocket: (url) => {
      if (!WS) throw new Error('this runtime has no WebSocket (Node 22 or newer is needed)')
      return new WS(url)
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now()
  }
}

/** The first `page` target's socket address. DevTools' own page is skipped. */
export function pageTargetOf(list: unknown): string | null {
  if (!Array.isArray(list)) return null
  for (const t of list) {
    if (typeof t !== 'object' || t === null) continue
    const r = t as Record<string, unknown>
    if (r.type !== 'page' || typeof r.webSocketDebuggerUrl !== 'string') continue
    if (typeof r.url === 'string' && r.url.startsWith('devtools://')) continue
    return r.webSocketDebuggerUrl
  }
  return null
}

/** The line an event is worth in `consoleErrors()`, or null. */
export function consoleErrorOf(method: string, params: Record<string, unknown>): string | null {
  if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
    const args = Array.isArray(params.args) ? params.args : []
    return args
      .map((a) => {
        const r = a as { value?: unknown; description?: string }
        return typeof r.value === 'string' ? r.value : (r.description ?? JSON.stringify(r.value))
      })
      .join(' ')
  }
  if (method === 'Runtime.exceptionThrown') {
    const d = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
    return d?.exception?.description ?? d?.text ?? 'uncaught exception'
  }
  if (method === 'Log.entryAdded') {
    const e = params.entry as { level?: string; text?: string } | undefined
    return e?.level === 'error' ? (e.text ?? 'error') : null
  }
  return null
}

export function openCdpSession(ws: WebSocketLike, openMs: number = OPEN_MS): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    let nextId = 1
    let closed = false
    const pending = new Map<number, { resolve(v: Record<string, unknown>): void; reject(e: Error): void }>()
    const waiters = new Map<string, Array<(p: Record<string, unknown>) => void>>()
    const errors: string[] = []
    const fail = (why: string): void => {
      if (closed) return
      closed = true
      for (const [id, p] of pending) {
        pending.delete(id)
        p.reject(new Error(why))
      }
    }
    const opened = setTimeout(() => {
      reject(new Error('the debugging socket did not open'))
      fail(NO_CDP)
      try {
        ws.close()
      } catch {
        /* already gone */
      }
    }, openMs)

    const cdp: Cdp = {
      send: (method, params = {}) =>
        new Promise((res, rej) => {
          if (closed) return rej(new Error(NO_CDP))
          const id = nextId++
          pending.set(id, { resolve: res, reject: rej })
          try {
            ws.send(JSON.stringify({ id, method, params }))
          } catch (err) {
            pending.delete(id)
            rej(new Error(`${NO_CDP} (${String(err)})`))
          }
        }),
      waitEvent: (method, timeoutMs) =>
        new Promise((res, rej) => {
          const got = (p: Record<string, unknown>): void => {
            clearTimeout(timer)
            res(p)
          }
          const timer = setTimeout(() => {
            waiters.set(method, (waiters.get(method) ?? []).filter((f) => f !== got))
            rej(new Error(`${method} did not arrive within ${timeoutMs} ms`))
          }, timeoutMs)
          waiters.set(method, [...(waiters.get(method) ?? []), got])
        }),
      consoleErrors: () => [...errors],
      close: () => {
        fail(NO_CDP)
        try {
          ws.close()
        } catch {
          /* already gone */
        }
      }
    }

    ws.addEventListener('open', () => {
      clearTimeout(opened)
      // Fire and forget: a page that refuses a domain can still be driven.
      for (const m of ['Runtime.enable', 'Log.enable', 'Page.enable']) void cdp.send(m).catch(() => undefined)
      resolve(cdp)
    })
    ws.addEventListener('message', (ev) => {
      let m: Record<string, unknown>
      try {
        m = JSON.parse(String(ev.data)) as Record<string, unknown>
      } catch {
        return
      }
      if (typeof m.id === 'number') {
        const p = pending.get(m.id)
        if (!p) return
        pending.delete(m.id)
        const err = m.error as { message?: string } | undefined
        if (err) p.reject(new Error(err.message ?? 'CDP error'))
        else p.resolve((m.result as Record<string, unknown> | undefined) ?? {})
        return
      }
      if (typeof m.method !== 'string') return
      const params = (m.params as Record<string, unknown> | undefined) ?? {}
      const list = waiters.get(m.method)
      if (list && list.length > 0) {
        waiters.delete(m.method)
        for (const f of list) f(params)
      }
      const text = consoleErrorOf(m.method, params)
      if (text !== null) {
        errors.push(text)
        if (errors.length > CONSOLE_KEEP) errors.shift()
      }
    })
    ws.addEventListener('close', () => {
      clearTimeout(opened)
      reject(new Error('the debugging socket closed before it opened'))
      fail(`${NO_CDP} (the app closed its debugging port)`)
    })
    ws.addEventListener('error', () => {
      /* a close follows */
    })
  })
}

/** Polls `/json` on the port until a page target answers or `waitMs` has passed. Null means the port
 *  never opened, which `launch` turns into the `--remote-debugging-port` hint. */
export async function connectCdp(port: number, waitMs: number, deps: CdpDeps = defaultCdpDeps()): Promise<Cdp | null> {
  const until = deps.now() + waitMs
  for (;;) {
    const url = await deps.fetchJson(`http://127.0.0.1:${port}/json`).then(pageTargetOf, () => null)
    if (url !== null) {
      const ws = deps.openSocket(url)
      try {
        return await openCdpSession(ws)
      } catch {
        /* the page went away between the list and the socket: ask again */
      }
    }
    if (deps.now() >= until) return null
    await deps.sleep(POLL_MS)
  }
}
