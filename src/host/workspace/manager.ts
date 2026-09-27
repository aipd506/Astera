// One workspace per agent session (agent workspace design, Components 2 and Lifecycle): its desktop
// helper, the launched process tree, the CDP connection, the running script and the last frame. It
// answers `app-js` (src/host/orch.ts), the mirror's Stop and Close, and `workspace-list`, and it writes
// <profile>/orch/workspaces.json so a later Host can end what this one left.
//
// Every dependency that touches a real process arrives in `d`, so the tests drive fakes.
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { SCRIPT_TIMEOUT_MS } from '../../core/agentBrowser/script'
import { evictionPlan } from '../../core/preview/pick/shots'
import { ScriptSlots, runWorkspaceScript } from '../../core/workspace/script'
import { workspaceHelpers, type AppState, type Cdp, type Desk, type HelperDeps, type LaunchSpec, type ResolvedLaunch } from '../../core/workspace/helpers'
import {
  idleExpired,
  leftoverPidsToKill,
  parseWorkspacesFile,
  serializeWorkspacesFile,
  workspaceRefusal,
  type RecordedPid,
  type WorkspaceRecord
} from '../../core/workspace/lifecycle'
import type { DesktopHelper } from './desktopHelper'
import type { WorkspaceEvent, WorkspaceFrame, WorkspaceSummary } from '../../core/host/protocol'
export type { WorkspaceEvent, WorkspaceFrame, WorkspaceSummary }

export const FRAME_EVERY_MS = 1_000
export const FRAME_MAX_WIDTH = 960
export const IDLE_TICK_MS = 30_000
const FRAME_QUALITY = 55

export interface WorkspaceReply {
  status: number
  body: unknown
}

export interface WorkspaceManagerDeps {
  platform: string
  env: Record<string, string | undefined>
  recordFile: string
  shotsDir: string
  /** The setting (plan ruling P3). Rejects when app-settings.json cannot be read. */
  enabled(): Promise<boolean>
  guide(): string
  /** The session's folder, or null when this Host holds no such session. */
  sessionCwd(sessionId: string): Promise<string | null>
  resolveLaunch(a: { sessionId: string; cwd: string; spec: LaunchSpec }): Promise<ResolvedLaunch>
  startDesk(name: string): Promise<DesktopHelper>
  connectCdp(port: number, waitMs: number): Promise<Cdp | null>
  freePort(): Promise<number>
  killTree(pid: number): Promise<void>
  startTimes(pids: number[]): Promise<Map<number, number>>
  emit(e: WorkspaceEvent): void
  /** Whether an attached app yields `workspace`, the only reader of frames. */
  hasWatchers(): boolean
  log(m: string): void
  now?(): number
  every?(ms: number, fn: () => void): () => void
  scriptTimeoutMs?: number
  idleMs?: number
  deskPrefix?: string
}

export interface WorkspaceManager {
  run(sessionId: string, script: string): Promise<WorkspaceReply>
  stop(sessionId: string): boolean
  close(sessionId: string): Promise<boolean>
  list(): WorkspaceSummary[]
  sessionEnded(sessionId: string): void
  sweepLeftovers(): Promise<void>
  dispose(): Promise<void>
}

interface Entry {
  sessionId: string
  desk: DesktopHelper | null
  deskStarting: Promise<DesktopHelper> | null
  state: AppState
  lastActivityAt: number
  helper: string | null
  frame: WorkspaceFrame | null
  capturing: boolean
  dirty: boolean
  stopFrames: (() => void) | null
  /** The script that holds this session's slot now, or null (review minor 3: a stale continuation of
   *  a stopped script must not clean up a desktop a newer script is using). */
  script: AbortController | null
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createWorkspaceManager(d: WorkspaceManagerDeps): WorkspaceManager {
  const now = d.now ?? Date.now
  const every =
    d.every ??
    ((ms: number, fn: () => void): (() => void) => {
      const timer = setInterval(fn, ms)
      timer.unref?.()
      return () => clearInterval(timer)
    })
  const prefix = d.deskPrefix ?? `astera-ws-${process.pid}`
  const entries = new Map<string, Entry>()
  const slots = new ScriptSlots()
  let counter = 0
  let disposed = false
  let writing: Promise<void> = Promise.resolve()
  let sweeping: Promise<void> = Promise.resolve()

  const isOpen = (e: Entry): boolean => e.desk !== null || e.deskStarting !== null

  const safeEmit = (ev: WorkspaceEvent): void => {
    try {
      d.emit(ev)
    } catch (err) {
      d.log(`workspace: an event could not be sent: ${String(err)}`)
    }
  }
  const emitState = (e: Entry, open: boolean): void =>
    safeEmit({ kind: 'state', sessionId: e.sessionId, open, running: slots.isRunning(e.sessionId), helper: e.helper })

  /** Writes what is open now. Serialised, so the last call's picture is the one on disk (R3: logged). */
  const persist = (): void => {
    const records: WorkspaceRecord[] = [...entries.values()]
      .filter((e) => e.desk !== null)
      .map((e) => ({
        sessionId: e.sessionId,
        desktop: e.desk!.name,
        pids: [
          ...(e.state.launched ? [{ pid: e.state.launched.pid, startedAt: e.state.launched.startedAt }] : []),
          { pid: e.desk!.pid, startedAt: e.desk!.startedAt }
        ]
      }))
    writing = writing
      .then(async () => {
        if (records.length === 0) await fs.rm(d.recordFile, { force: true })
        else {
          await fs.mkdir(path.dirname(d.recordFile), { recursive: true })
          await fs.writeFile(d.recordFile, serializeWorkspacesFile(records), 'utf8')
        }
      })
      .catch((err) => d.log(`workspace: ${d.recordFile} could not be written: ${String(err)}`))
  }

  const entryOf = (sessionId: string): Entry => {
    let e = entries.get(sessionId)
    if (!e) {
      e = { sessionId, desk: null, deskStarting: null, state: { launched: null, cdp: null }, lastActivityAt: now(), helper: null, frame: null, capturing: false, dirty: false, stopFrames: null, script: null }
      entries.set(sessionId, e)
    }
    return e
  }

  /** Ends a recorded process tree only if the live process with that pid started when the record says
   *  (the leftover sweep's rule): a pid alone never decides, because Windows hands numbers out again. */
  const killRecorded = async (sessionId: string, p: RecordedPid): Promise<void> => {
    const [pid] = leftoverPidsToKill([{ sessionId, desktop: '', pids: [p] }], await d.startTimes([p.pid]))
    if (pid === undefined) {
      d.log(`workspace ${sessionId}: pid ${p.pid} is gone or is another process now; left alone`)
      return
    }
    await d.killTree(pid)
  }
  const killRecordedLogged = (sessionId: string, p: RecordedPid): Promise<void> =>
    killRecorded(sessionId, p).catch((err) => d.log(`workspace ${sessionId}: pid ${p.pid} could not be ended: ${String(err)}`))

  /** Emits the close and forgets the entry unless a script still runs in it. The frame timer is the
   *  running script's and ends with it (ruling F6): a script that calls close() and launches again
   *  keeps its frames. */
  const finish = (e: Entry): void => {
    e.helper = null
    e.frame = null
    emitState(e, false)
    if (!slots.isRunning(e.sessionId) && entries.get(e.sessionId) === e) entries.delete(e.sessionId)
  }

  const helperDied = (e: Entry, desk: DesktopHelper, why: string): void => {
    if (e.desk !== desk) return
    d.log(`workspace ${e.sessionId}: the desktop helper ended (${why}); cleaning up`)
    const launched = e.state.launched
    e.state.cdp?.close()
    e.state.cdp = null
    e.state.launched = null
    e.desk = null
    slots.stop(e.sessionId)
    if (launched) void killRecordedLogged(e.sessionId, launched)
    persist()
    finish(e)
  }

  const ensureDesk = (e: Entry): Promise<DesktopHelper> => {
    // Ruling F1's other half (review critical 1): an entry the manager has already forgotten (its
    // script ended and nothing was open) or a Host that is leaving never gets a desktop, which nothing
    // would record, list or close.
    if (disposed || entries.get(e.sessionId) !== e) return Promise.reject(new Error('launch: stopped (this workspace has ended)'))
    if (e.desk && e.desk.alive()) return Promise.resolve(e.desk)
    if (!e.deskStarting) {
      const name = `${prefix}-${++counter}`
      e.deskStarting = d
        .startDesk(name)
        .then((desk) => {
          e.desk = desk
          desk.onExit((why) => helperDied(e, desk, why))
          persist()
          emitState(e, true)
          return desk
        })
        .finally(() => {
          e.deskStarting = null
        })
    }
    return e.deskStarting
  }

  /** Spec, Lifecycle: kill the launched tree, close the desktop, end the helper. `stopScript` is false
   *  for `close()` called by the script itself, which must go on running. */
  const cleanup = async (e: Entry, why: string, stopScript: boolean): Promise<void> => {
    if (stopScript) slots.stop(e.sessionId)
    // A desktop still starting is waited for, and taken only if no other cleanup took it meanwhile (a
    // session that ends while a stopped launch closes its fresh desktop must not close it twice).
    const desk = e.desk ?? (e.deskStarting ? await e.deskStarting.then((k) => (e.desk === k ? k : null), () => null) : null)
    const launched = e.state.launched
    // Review minor 4: a cleanup that finds nothing left (another one took it) tells the app nothing.
    const took = desk !== null || launched !== null
    e.state.cdp?.close()
    e.state.cdp = null
    e.state.launched = null
    e.desk = null
    if (desk) {
      if (launched)
        await desk.kill(launched.pid, launched.startedAt).catch(async (err) => {
          d.log(`workspace ${e.sessionId}: the helper could not end pid ${launched.pid} (${messageOf(err)}); ending it directly`)
          await killRecordedLogged(e.sessionId, launched)
        })
      await desk.close().catch((err) => d.log(`workspace ${e.sessionId}: the desktop did not close: ${String(err)}`))
    } else if (launched) {
      await killRecordedLogged(e.sessionId, launched)
    }
    d.log(`workspace ${e.sessionId}: cleaned up (${why})`)
    persist()
    if (took) finish(e)
    else if (!slots.isRunning(e.sessionId) && !isOpen(e) && entries.get(e.sessionId) === e) entries.delete(e.sessionId)
  }

  const frameOf = async (e: Entry): Promise<WorkspaceFrame | null> => {
    const cdp = e.state.cdp
    if (cdp) {
      const m = await cdp.send('Page.getLayoutMetrics')
      const vp = (m.cssVisualViewport ?? m.cssLayoutViewport) as { clientWidth?: number; clientHeight?: number } | undefined
      const w = vp?.clientWidth ?? 0
      const h = vp?.clientHeight ?? 0
      const scale = w > FRAME_MAX_WIDTH ? FRAME_MAX_WIDTH / w : 1
      const clip = w > 0 && h > 0 ? { clip: { x: 0, y: 0, width: w, height: h, scale } } : {}
      const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: FRAME_QUALITY, ...clip })
      if (typeof r.data !== 'string' || r.data === '') return null
      return { jpeg: r.data, width: Math.round(w * scale), height: Math.round(h * scale), at: now() }
    }
    if (e.desk && e.state.launched) {
      const s = await e.desk.shot({ format: 'jpeg', maxWidth: FRAME_MAX_WIDTH })
      return { jpeg: s.data, width: s.width, height: s.height, at: now() }
    }
    return null
  }

  /** Never rejects (R3). One capture at a time per entry; a request that lands during one is folded
   *  into a single capture after it (plan ruling P12). */
  const captureFrame = async (e: Entry): Promise<void> => {
    if (disposed || !isOpen(e) || !d.hasWatchers()) return
    if (e.capturing) {
      e.dirty = true
      return
    }
    e.capturing = true
    try {
      const frame = await frameOf(e)
      if (frame && entries.get(e.sessionId) === e && isOpen(e)) {
        e.frame = frame
        safeEmit({ kind: 'frame', sessionId: e.sessionId, frame })
      }
    } catch {
      /* a frame that fails is skipped; the next tick tries again */
    } finally {
      e.capturing = false
      if (e.dirty) {
        e.dirty = false
        void captureFrame(e).catch(() => undefined)
      }
    }
  }

  const evict = async (): Promise<void> => {
    try {
      const names = await fs.readdir(d.shotsDir)
      const files = await Promise.all(
        names
          .filter((n) => n.endsWith('.png'))
          .map(async (n) => {
            const p = path.join(d.shotsDir, n)
            return { path: p, mtimeMs: (await fs.stat(p)).mtimeMs }
          })
      )
      await Promise.all(evictionPlan(files, now()).map((p) => fs.unlink(p).catch(() => undefined)))
    } catch {
      /* the next capture tries again */
    }
  }

  const saveCapture = async (data: string, ext: 'png'): Promise<string> => {
    await fs.mkdir(d.shotsDir, { recursive: true })
    const file = path.join(d.shotsDir, `app-${randomUUID()}.${ext}`)
    await fs.writeFile(file, Buffer.from(data, 'base64'))
    void evict()
    return file
  }

  /** The desktop as a script's helpers see it. A launch that resolves after its desktop was cleaned up
   *  (Close, the session ending, the Host leaving, while the app was starting) started an app nobody
   *  holds: it is ended at once, by pid and start time, and the launch fails as stopped (review
   *  important 2). */
  const guardedDesk = (e: Entry, desk: DesktopHelper): Desk => ({
    name: desk.name,
    launch: async (a) => {
      const started = await desk.launch(a)
      if (e.desk !== desk || entries.get(e.sessionId) !== e) {
        d.log(`workspace ${e.sessionId}: the desktop closed while pid ${started.pid} was starting; ending it`)
        await killRecordedLogged(e.sessionId, started)
        throw new Error('launch: stopped (the workspace closed while the app was starting; the app was ended)')
      }
      return started
    },
    kill: (pid, startedAt) => desk.kill(pid, startedAt),
    windows: () => desk.windows(),
    shot: (a) => desk.shot(a),
    keys: (a) => desk.keys(a),
    close: () => desk.close()
  })

  const helperDeps = (e: Entry, cwd: string, deadline: number, stop: AbortController): HelperDeps => ({
    state: e.state,
    // Ruling F1: a desktop that finishes starting after this script was stopped, with nothing launched
    // on it, is closed at once, unless a newer script holds the session and is using it (review minor
    // 3); `launch` then refuses to start the app (it asks `stopped()` again).
    desk: async () => {
      const desk = await ensureDesk(e)
      const newer = e.script !== null && e.script !== stop
      if ((stop.signal.aborted || disposed) && !newer && !e.state.launched && e.desk === desk) await cleanup(e, 'stopped before the launch', false)
      return guardedDesk(e, desk)
    },
    stopped: () => stop.signal.aborted || disposed,
    deskIfOpen: () => e.desk,
    resolveLaunch: (spec) => d.resolveLaunch({ sessionId: e.sessionId, cwd, spec }),
    freePort: () => d.freePort(),
    connectCdp: (port, waitMs) => d.connectCdp(port, waitMs),
    saveCapture,
    recordLaunch: () => persist(),
    changed: () => {
      void captureFrame(e).catch(() => undefined)
    },
    cleanup: () => cleanup(e, 'close()', false),
    deadline: () => deadline,
    now,
    guide: d.guide()
  })

  const stopIdle = every(IDLE_TICK_MS, () => {
    for (const e of [...entries.values()]) {
      if (!isOpen(e)) continue
      if (!idleExpired({ lastActivityAt: e.lastActivityAt, now: now(), running: slots.isRunning(e.sessionId), idleMs: d.idleMs })) continue
      void cleanup(e, 'no script for 10 minutes', true).catch((err) => d.log(`workspace ${e.sessionId}: the idle cleanup failed: ${String(err)}`))
    }
  })

  const doSweep = async (): Promise<void> => {
    try {
      const text = await fs.readFile(d.recordFile, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null
        throw err
      })
      if (text === null) return
      const records = parseWorkspacesFile(text)
      const pids = [...new Set(records.flatMap((r) => r.pids.map((p) => p.pid)))]
      const kill = pids.length > 0 ? leftoverPidsToKill(records, await d.startTimes(pids)) : []
      for (const pid of kill) await d.killTree(pid).catch((err) => d.log(`workspace leftovers: pid ${pid} could not be ended: ${String(err)}`))
      d.log(`workspace leftovers: ${records.length} recorded, ${kill.length} process(es) still running and ended`)
      await fs.rm(d.recordFile, { force: true })
    } catch (err) {
      d.log(`workspace leftovers: the sweep failed: ${String(err)}`)
    }
  }

  return {
    run: async (sessionId, script) => {
      if (disposed) return { status: 409, body: { error: 'the Host is leaving' } }
      const refusal = workspaceRefusal({ platform: d.platform, env: d.env })
      if (refusal) return { status: 409, body: { error: refusal } }
      let on: boolean
      try {
        on = await d.enabled()
      } catch (err) {
        return { status: 409, body: { error: messageOf(err), repair: 'app-settings.json' } }
      }
      if (!on) return { status: 409, body: { error: 'agent app workspace is off' } }
      const cwd = await d.sessionCwd(sessionId).catch(() => null)
      if (cwd === null) return { status: 404, body: { error: 'no such session' } }
      await sweeping
      const ac = slots.begin(sessionId)
      if (!ac) return { status: 409, body: { error: 'a script is already running' } }
      const e = entryOf(sessionId)
      e.script = ac
      const startedAt = now()
      const timeoutMs = d.scriptTimeoutMs ?? SCRIPT_TIMEOUT_MS
      e.lastActivityAt = startedAt
      if (isOpen(e)) emitState(e, true)
      e.stopFrames = every(FRAME_EVERY_MS, () => {
        void captureFrame(e).catch(() => undefined)
      })
      try {
        const result = await runWorkspaceScript({
          script,
          stop: ac.signal,
          timeoutMs,
          onHelper: (name) => {
            e.helper = name
            if (isOpen(e)) emitState(e, true)
          },
          helpers: (ctx) => workspaceHelpers(helperDeps(e, cwd, startedAt + timeoutMs, ac), ctx)
        })
        return { status: 200, body: result }
      } finally {
        // The runner aborts only its own controller; this one is what `stopped()` reads, so a launch
        // the script left behind (not awaited, or cut off by the timeout) stops too (review critical 1).
        ac.abort()
        slots.end(sessionId, ac)
        if (e.script === ac) e.script = null
        e.stopFrames?.()
        e.stopFrames = null
        e.helper = null
        e.lastActivityAt = now()
        if (isOpen(e)) {
          emitState(e, true)
          void captureFrame(e).catch(() => undefined)
        } else if (entries.get(sessionId) === e) entries.delete(sessionId)
      }
    },
    stop: (sessionId) => slots.stop(sessionId),
    close: async (sessionId) => {
      const e = entries.get(sessionId)
      if (!e || !isOpen(e)) return false
      await cleanup(e, 'Close in the app', true)
      return true
    },
    list: () =>
      [...entries.values()].filter(isOpen).map((e) => ({ sessionId: e.sessionId, running: slots.isRunning(e.sessionId), helper: e.helper, frame: e.frame })),
    sessionEnded: (sessionId) => {
      const e = entries.get(sessionId)
      if (!e) return
      slots.stop(sessionId)
      if (isOpen(e)) void cleanup(e, 'the session ended', true).catch((err) => d.log(`workspace ${sessionId}: the cleanup failed: ${String(err)}`))
    },
    sweepLeftovers: () => {
      sweeping = doSweep()
      return sweeping
    },
    dispose: async () => {
      disposed = true
      stopIdle()
      slots.stopAll()
      await Promise.all([...entries.values()].filter(isOpen).map((e) => cleanup(e, 'the Host is leaving', true).catch((err) => d.log(`workspace ${e.sessionId}: ${String(err)}`))))
      await writing
    }
  }
}
