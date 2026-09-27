// The Host's side of one desktop helper (agent workspace design, Components 2): starts it, waits for
// `ready` (5 s, else a clear error), creates the desktop, serialises requests, and rejects every
// pending request if the process dies. `close` resolves once the process has exited (5 s cap). This is the Windows `Desk` (src/core/workspace/helpers.ts).
//
// The process is behind `DeskProcess` so the tests answer it by hand; `spawnPowerShell` is the real
// one, the clipboardFiles.ts route (powershell.exe, windowsHide, no shell).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { withTimeout } from '../../core/agentBrowser/script'
import { shellSpawn } from '../../core/run/shell'
import { NOT_INTERACTIVE } from '../../core/workspace/lifecycle'
import {
  DESK_READY_MS,
  asLaunched,
  asShot,
  asWindows,
  encodeDeskRequest,
  parseDeskLine,
  type DeskRequest,
  type DeskRequestBody
} from '../../core/workspace/protocol'
import type { Desk } from '../../core/workspace/helpers'
import { DESK_PS1 } from './desk'

export interface DeskProcess {
  readonly pid: number | undefined
  write(line: string): void
  /** Every stdout line, without its `\n`. */
  onLine(cb: (line: string) => void): void
  /** Once, however it ended: an exit, a failed start. */
  onExit(cb: (why: string) => void): void
  kill(): void
}

export type SpawnDesk = () => DeskProcess

export interface DesktopHelper extends Desk {
  readonly pid: number
  readonly startedAt: number
  alive(): boolean
  onExit(cb: (why: string) => void): void
}

const CLOSE_MS = 5_000
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Plan ruling P5: the embedded script, written under a content name so an older one is never run. */
export async function writeDeskScript(dir: string): Promise<string> {
  const hash = createHash('sha256').update(DESK_PS1).digest('hex').slice(0, 8)
  const file = path.join(dir, `desk-${hash}.ps1`)
  const current = await fs.readFile(file, 'utf8').catch(() => null)
  if (current !== DESK_PS1) {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, DESK_PS1, 'utf8')
  }
  return file
}

export function spawnPowerShell(scriptPath: string): DeskProcess {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const lineCbs: Array<(l: string) => void> = []
  const exitCbs: Array<(why: string) => void> = []
  let buf = ''
  let stderrTail = ''
  let ended = false
  const end = (why: string): void => {
    if (ended) return
    ended = true
    for (const cb of exitCbs) cb(why)
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buf += chunk
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      for (const cb of lineCbs) cb(line)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c: string) => {
    stderrTail = (stderrTail + c).slice(-2_000)
  })
  child.stdin.on('error', () => {
    /* a write after the exit; the exit reports it */
  })
  child.on('error', (err) => end(`powershell.exe could not start: ${err.message}`))
  child.on('exit', (code, signal) => {
    const tail = stderrTail.trim().replace(/\s+/g, ' ')
    end(`exited ${String(signal ?? code)}${tail ? `: ${tail}` : ''}`)
  })
  return {
    get pid() {
      return child.pid
    },
    write: (line) => {
      if (!ended && child.stdin.writable) child.stdin.write(line)
    },
    onLine: (cb) => {
      lineCbs.push(cb)
    },
    onExit: (cb) => {
      exitCbs.push(cb)
    },
    kill: () => {
      if (!ended) child.kill()
    }
  }
}

export async function startDesktopHelper(a: { name: string; spawn: SpawnDesk; readyMs?: number; log(m: string): void }): Promise<DesktopHelper> {
  const readyMs = a.readyMs ?? DESK_READY_MS
  const proc = a.spawn()
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  const exitCbs: Array<(why: string) => void> = []
  let nextId = 1
  let dead: string | null = null
  let tail: Promise<unknown> = Promise.resolve()
  let readyResolve!: (hello: { interactive: boolean; pid: number; startedAt: number }) => void
  let readyReject!: (e: Error) => void
  const ready = new Promise<{ interactive: boolean; pid: number; startedAt: number }>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })

  proc.onLine((line) => {
    const m = parseDeskLine(line)
    if (m === null) {
      // Review Focus 2: noise is logged and never fatal.
      if (line.trim() !== '') a.log(`desktop helper ${a.name} wrote a line that is not a message: ${line.trim().slice(0, 200)}`)
      return
    }
    if (m.kind === 'ready') return readyResolve(m)
    if (m.kind === 'fatal') return readyReject(new Error(`the desktop helper could not start: ${m.error}`))
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.ok) p.resolve(m.value)
    else p.reject(new Error(m.error))
  })
  let exitedResolve!: () => void
  const exited = new Promise<'exited'>((resolve) => {
    exitedResolve = () => resolve('exited')
  })
  proc.onExit((why) => {
    dead = why
    exitedResolve()
    readyReject(new Error(`the desktop helper ended before it was ready (${why})`))
    for (const [id, p] of pending) {
      pending.delete(id)
      p.reject(new Error(`the desktop helper ended (${why})`))
    }
    for (const cb of exitCbs) {
      try {
        cb(why)
      } catch (err) {
        a.log(`a desktop helper exit listener threw: ${String(err)}`)
      }
    }
  })

  const timer = setTimeout(() => readyReject(new Error(`the desktop helper did not say ready within ${readyMs / 1000} s`)), readyMs)
  let hello: { interactive: boolean; pid: number; startedAt: number }
  try {
    hello = await ready
  } catch (err) {
    proc.kill()
    throw err
  } finally {
    clearTimeout(timer)
  }
  if (!hello.interactive) {
    proc.kill()
    throw new Error(NOT_INTERACTIVE)
  }

  /** One request in flight at a time: the helper is one thread attached to one desktop. */
  const request = (body: DeskRequestBody): Promise<unknown> => {
    const run = (): Promise<unknown> =>
      new Promise((resolve, reject) => {
        if (dead !== null) return reject(new Error(`the desktop helper ended (${dead})`))
        const id = nextId++
        pending.set(id, { resolve, reject })
        proc.write(encodeDeskRequest({ ...body, id } as DeskRequest))
      })
    const p = tail.then(run, run)
    tail = p.catch(() => undefined)
    return p
  }

  try {
    await request({ op: 'create', name: a.name })
  } catch (err) {
    proc.kill()
    throw new Error(`the desktop could not be created: ${messageOf(err)}`)
  }

  return {
    name: a.name,
    pid: hello.pid,
    startedAt: hello.startedAt,
    alive: () => dead === null,
    onExit: (cb) => {
      exitCbs.push(cb)
    },
    launch: async ({ command, cwd, env }) => {
      // The Desk port takes a shell command (W7); this is where it becomes a Windows command line,
      // by the same rule a Run uses (shellSpawn's win32 string form).
      const s = shellSpawn(command, 'win32')
      return asLaunched(await request({ op: 'launch', commandLine: `${s.file} ${String(s.args)}`, cwd, env }))
    },
    kill: async (pid) => {
      await request({ op: 'kill', pid })
    },
    windows: async () => asWindows(await request({ op: 'windows' })),
    shot: async (o) => asShot(await request({ op: 'shot', title: o.title ?? null, format: o.format, maxWidth: o.maxWidth ?? null })),
    keys: async (o) => {
      await request({ op: 'keys', title: o.title, text: o.text ?? null, key: o.key ?? null })
    },
    close: async () => {
      if (dead === null)
        await withTimeout(request({ op: 'close' }), CLOSE_MS, 'close').catch((err: unknown) =>
          a.log(`desktop helper ${a.name} did not close cleanly: ${messageOf(err)}`)
        )
      proc.kill()
      // Preflight ruling F2: resolve only once the process is gone (capped), so a leftover check that
      // follows a close never sees this helper still running.
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), CLOSE_MS)
      })
      const how = await Promise.race([exited, late]).finally(() => clearTimeout(timer))
      if (how === 'late') a.log(`desktop helper ${a.name} did not exit within ${CLOSE_MS / 1000} s of close`)
    }
  }
}
