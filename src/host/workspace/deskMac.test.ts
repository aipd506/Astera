import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DeskHandle } from '../../core/workspace/helpers'
import { MAC_BACKGROUND_FLAGS, bundleCommand, createMacDesks, macRefusal, newestBundleProcess, realMacDeskDeps, type MacDeskDeps } from './deskMac'

const at = (d: number, h: number, m: number, s: number): number => new Date(2026, 8, d, h, m, s).getTime()

const rig = () => {
  const procs: Array<{ file: string; args: string[]; env: Record<string, string>; cwd?: string; stderr?: boolean; pid: number; exit(why: string): void }> = []
  const execs: Array<[string, string[]]> = []
  const starts = new Map<number, number>()
  const groupsKilled: number[] = []
  const log: string[] = []
  const sleeps: Array<{ ms: number; signal?: AbortSignal }> = []
  let psText = ''
  let clock = at(27, 10, 11, 12)
  let nextPid = 800
  const deps: MacDeskDeps = {
    spawn: (file, args, o) => {
      const pid = nextPid++
      const cbs: Array<(why: string) => void> = []
      let ended: string | null = null
      const exit = (why: string): void => {
        if (ended !== null) return
        ended = why
        for (const cb of cbs) cb(why)
      }
      procs.push({ file, args, env: o.env, cwd: o.cwd, stderr: o.stderr, pid, exit })
      starts.set(pid, clock)
      return {
        pid,
        onExit: (cb) => {
          if (ended !== null) cb(ended)
          else cbs.push(cb)
        },
        stderrTail: () => (ended !== null && ended !== 'exited 0' ? 'LSOpenURLsWithRole() failed with error -10810' : ''),
        kill: () => {}
      }
    },
    exec: async (file, args) => {
      execs.push([file, args])
      return psText
    },
    startTime: async (pid) => starts.get(pid) ?? null,
    killGroup: async (pid) => {
      groupsKilled.push(pid)
      starts.delete(pid)
    },
    sleep: async (ms, signal) => {
      sleeps.push({ ms, signal })
      clock += ms
    },
    now: () => clock,
    log: (m) => log.push(m)
  }
  return {
    deps,
    desks: createMacDesks(deps),
    procs,
    execs,
    starts,
    groupsKilled,
    log,
    sleeps,
    setPs: (t: string) => {
      psText = t
    }
  }
}

describe('the macOS desk', () => {
  it('creates nothing: its name is mac-bg-<name> and it has no helper process (R7, R11)', async () => {
    const desk: DeskHandle = await rig().desks.start('astera-ws-1-1')
    expect(desk.name).toBe('mac-bg-astera-ws-1-1')
    expect(desk.pid).toBeNull()
    expect(desk.alive()).toBe(true)
  })

  it('launches a command through sh in its own group, with the background flags and the rest of its env untouched', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const got = await desk.launch({ command: 'npm run dev', cwd: '/Users/me/proj', env: { ELECTRON_ENABLE_LOGGING: '1', ASTERA_APP_CDP_PORT: '9333' } })
    expect(r.procs[0]).toMatchObject({
      file: 'sh',
      // `wait` keeps sh, the group's leader, alive while anything the command backgrounded still runs.
      args: ['-c', 'npm run dev\nwait'],
      cwd: '/Users/me/proj',
      env: { ELECTRON_ENABLE_LOGGING: '1', ASTERA_APP_CDP_PORT: '9333', ASTERA_APP_CHROMIUM_FLAGS: MAC_BACKGROUND_FLAGS }
    })
    expect(MAC_BACKGROUND_FLAGS).toBe('--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling')
    expect(got).toEqual({ pid: r.procs[0].pid, startedAt: at(27, 10, 11, 12) })
  })

  it('opens an app bundle with open -g -j -n and finds its process, not the person own instance or a helper (R6)', async () => {
    const r = rig()
    r.setPs(
      [
        '    1 Sat Sep 27 09:00:00 2026 /sbin/launchd',
        '  900 Sat Sep 27 09:00:00 2026 /Applications/My App.app/Contents/MacOS/My App',
        '  901 Sat Sep 27 10:11:13 2026 /Applications/My App.app/Contents/MacOS/My App --remote-debugging-port=9333',
        '  902 Sat Sep 27 10:11:13 2026 /Applications/My App.app/Contents/Frameworks/My App Helper.app/Contents/MacOS/My App Helper --type=renderer'
      ].join('\n')
    )
    const desk = await r.desks.start('a')
    const got = await desk.launch({ command: '"/Applications/My App.app" --remote-debugging-port=$ASTERA_APP_CDP_PORT', cwd: '/Users/me/proj', env: {} })
    expect(r.procs[0].args).toEqual([
      '-c',
      'exec open -g -j -n -a "$0" --args --remote-debugging-port=$ASTERA_APP_CDP_PORT $ASTERA_APP_CHROMIUM_FLAGS',
      '/Applications/My App.app'
    ])
    expect(r.execs[0]).toEqual(['env', ['LC_ALL=C', 'ps', '-Ao', 'pid=,lstart=,command=']])
    expect(got).toEqual({ pid: 901, startedAt: at(27, 10, 11, 13) })
  })

  it('fails the launch when no process of the bundle appears within the ready limit', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    await expect(desk.launch({ command: '/Applications/Gone.app', cwd: '/', env: {} })).rejects.toThrow(
      'launch: /Applications/Gone.app was opened, but no process of it appeared within 5 s'
    )
  })

  it('refuses windows, windowShot and keys with the reason', async () => {
    const desk = await rig().desks.start('a')
    await expect(desk.windows()).rejects.toThrow('windows: not available on macOS (the app runs in the background and only its page can be driven)')
    await expect(desk.shot({ format: 'png' })).rejects.toThrow(macRefusal('windowShot'))
    await expect(desk.keys({ title: 'x', text: 'y' })).rejects.toThrow(macRefusal('keys'))
  })

  it('kills a launched group only while its start time matches, and close ends every one still its own', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const one = await desk.launch({ command: 'a', cwd: '/', env: {} })
    const two = await desk.launch({ command: 'b', cwd: '/', env: {} })
    const three = await desk.launch({ command: 'c', cwd: '/', env: {} })
    // A mismatch means the pid is someone else's now: it is forgotten, and close leaves it alone too.
    await desk.kill(one.pid, one.startedAt + 60_000)
    expect(r.groupsKilled).toEqual([])
    expect(r.log.some((l) => l.includes(`start time mismatch: pid ${one.pid}`))).toBe(true)
    await desk.close()
    expect(r.groupsKilled).toEqual([two.pid, three.pid])
    expect(desk.alive()).toBe(false)
    await expect(desk.launch({ command: 'c', cwd: '/', env: {} })).rejects.toThrow('this workspace is closed')
  })
})

describe('the macOS desk: start times, failures and close', () => {
  it('never takes a start time from the clock: an app already gone is recorded with 0 and never killed for', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    r.deps.startTime = async () => null
    const got = await desk.launch({ command: 'true', cwd: '/', env: {} })
    expect(got).toEqual({ pid: r.procs[0].pid, startedAt: 0 })
    expect(r.log.some((l) => l.includes(`pid ${got.pid} exited before its start time could be read`))).toBe(true)
    await desk.close()
    expect(r.groupsKilled).toEqual([])
  })

  it('ends the fresh group and rethrows when the launched start time cannot be read', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    r.deps.startTime = async () => {
      throw Object.assign(new Error('spawn env ENOENT'), { code: 'ENOENT' })
    }
    await expect(desk.launch({ command: 'app', cwd: '/', env: {} })).rejects.toThrow('spawn env ENOENT')
    expect(r.groupsKilled).toEqual([r.procs[0].pid])
  })

  it('still rethrows the start time failure when ending that group fails too, and logs the second failure', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    r.deps.startTime = async () => {
      throw new Error('ps timed out')
    }
    r.deps.killGroup = async () => {
      throw new Error('EPERM')
    }
    await expect(desk.launch({ command: 'app', cwd: '/', env: {} })).rejects.toThrow('ps timed out')
    expect(r.log.some((l) => l.includes(`pid ${r.procs[0].pid} could not be ended: EPERM`))).toBe(true)
  })

  it('refuses a launch whose sh never got a pid, with the reason', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    r.deps.spawn = () => ({ pid: undefined, onExit: () => {}, stderrTail: () => 'spawn sh ENOENT', kill: () => {} })
    await expect(desk.launch({ command: 'app', cwd: '/', env: {} })).rejects.toThrow('launch: sh could not start (spawn sh ENOENT)')
    await expect(desk.launch({ command: '/Applications/A.app', cwd: '/', env: {} })).rejects.toThrow('launch: sh could not start (spawn sh ENOENT)')
  })

  it('fails a bundle launch at once, with the reason, when open itself fails', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    r.deps.sleep = async (ms) => {
      r.procs[0].exit('exited 1')
      void ms
    }
    await expect(desk.launch({ command: '/Applications/Broken.app', cwd: '/', env: {} })).rejects.toThrow(
      'launch: open could not start /Applications/Broken.app (exited 1: LSOpenURLsWithRole() failed with error -10810)'
    )
    expect(r.procs[0].stderr).toBe(true)
    expect(r.execs.length).toBe(1)
  })

  it('keeps looking after open exits 0, since the app may appear a moment later', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    let polls = 0
    r.deps.exec = async () => (++polls < 3 ? '' : '  950 Sat Sep 27 10:11:13 2026 /A.app/Contents/MacOS/A\n')
    r.deps.sleep = async (ms) => {
      r.procs[0].exit('exited 0')
      void ms
    }
    await expect(desk.launch({ command: '/A.app', cwd: '/', env: {} })).resolves.toEqual({ pid: 950, startedAt: at(27, 10, 11, 13) })
  })

  it('fails a bundle launch with the ps failure instead of polling out the ready limit', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    r.deps.exec = async () => {
      throw Object.assign(new Error('spawn env ENOENT'), { code: 'ENOENT' })
    }
    await expect(desk.launch({ command: '/A.app', cwd: '/', env: {} })).rejects.toThrow(
      'launch: /A.app was opened, but ps could not list its processes: spawn env ENOENT'
    )
  })

  it('resolves a relative bundle against the launch folder, with POSIX paths', async () => {
    const r = rig()
    r.setPs('  960 Sat Sep 27 10:11:12 2026 /Users/me/proj/dist/mac/Foo.app/Contents/MacOS/Foo\n')
    const desk = await r.desks.start('a')
    const got = await desk.launch({ command: "'./dist/mac/Foo.app/'", cwd: '/Users/me/proj', env: {} })
    expect(r.procs[0].args[2]).toBe('/Users/me/proj/dist/mac/Foo.app')
    expect(got.pid).toBe(960)
  })

  it('a bundle launch that close interrupts stops polling, leaves nothing recorded, and rejects', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    r.deps.sleep = (ms, signal) => {
      r.sleeps.push({ ms, signal })
      return new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    const going = desk.launch({ command: '/A.app', cwd: '/', env: {} })
    const settled = expect(going).rejects.toThrow('launch: this workspace is closed')
    await new Promise((res) => setImmediate(res))
    expect(r.sleeps.length).toBe(1)
    await desk.close()
    expect(r.sleeps[0].signal?.aborted).toBe(true)
    await settled
    expect(r.execs.length).toBe(1)
  })

  it('a bundle process found after close is ended at once, not left running', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    let release!: (t: string) => void
    r.deps.exec = () => new Promise<string>((res) => (release = res))
    const going = desk.launch({ command: '/A.app', cwd: '/', env: {} })
    const settled = expect(going).rejects.toThrow('launch: this workspace is closed')
    await new Promise((res) => setImmediate(res))
    await desk.close()
    release('  970 Sat Sep 27 10:11:13 2026 /A.app/Contents/MacOS/A\n')
    await settled
    expect(r.groupsKilled).toEqual([970])
  })

  it('a command whose start time arrives after close is ended at once, not left running', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    let release!: (ms: number) => void
    r.deps.startTime = () => new Promise<number>((res) => (release = res))
    const going = desk.launch({ command: 'app', cwd: '/', env: {} })
    const settled = expect(going).rejects.toThrow('launch: this workspace is closed')
    await new Promise((res) => setImmediate(res))
    await desk.close()
    release(at(27, 10, 11, 12))
    await settled
    expect(r.groupsKilled).toEqual([r.procs[0].pid])
  })

  it('close resolves and goes on to the next group when ending one fails, and logs it', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const one = await desk.launch({ command: 'a', cwd: '/', env: {} })
    const two = await desk.launch({ command: 'b', cwd: '/', env: {} })
    const real = r.deps.killGroup
    r.deps.killGroup = async (pid) => (pid === one.pid ? Promise.reject(new Error('EPERM')) : real(pid))
    await expect(desk.close()).resolves.toBeUndefined()
    expect(r.groupsKilled).toEqual([two.pid])
    expect(r.log.some((l) => l.includes(`pid ${one.pid} could not be ended: EPERM`))).toBe(true)
  })

  it('close resolves when reading a start time fails, and logs it', async () => {
    const r = rig()
    const desk = await r.desks.start('a')
    const one = await desk.launch({ command: 'a', cwd: '/', env: {} })
    r.deps.startTime = async () => {
      throw new Error('ps timed out')
    }
    await expect(desk.close()).resolves.toBeUndefined()
    expect(r.log.some((l) => l.includes(`pid ${one.pid} could not be ended: ps timed out`))).toBe(true)
  })
})

describe('the macOS desk: pure parts', () => {
  it('reads an app bundle as the first word, quoted or not', () => {
    expect(bundleCommand('/Applications/Foo.app')).toEqual({ bundle: '/Applications/Foo.app', rest: '' })
    expect(bundleCommand('"/Applications/My App.app" --x')).toEqual({ bundle: '/Applications/My App.app', rest: '--x' })
    expect(bundleCommand("'./dist/mac/Foo.app/' --remote-debugging-port=$ASTERA_APP_CDP_PORT")).toEqual({
      bundle: './dist/mac/Foo.app',
      rest: '--remote-debugging-port=$ASTERA_APP_CDP_PORT'
    })
    expect(bundleCommand('open Foo.app')).toBeNull()
    expect(bundleCommand('npm run dev')).toBeNull()
    expect(bundleCommand('./foo.apple')).toBeNull()
  })

  it('takes the newest process under the bundle executable folder that started at or after the launch', () => {
    const ps = '  5 Sat Sep 27 10:00:00 2026 /A.app/Contents/MacOS/A\n  6 Sat Sep 27 10:00:09 2026 /A.app/Contents/MacOS/A\n'
    expect(newestBundleProcess(ps, '/A.app', at(27, 10, 0, 10))).toEqual({ pid: 6, startedAt: at(27, 10, 0, 9) })
    expect(newestBundleProcess(ps, '/A.app/', at(27, 10, 0, 30))).toBeNull()
    expect(newestBundleProcess(ps, '/B.app', 0)).toBeNull()
  })
})

describe('the macOS desk: real deps', () => {
  it('ends a real sleep, and clears its timer, when its signal aborts', async () => {
    const d = realMacDeskDeps({ log: () => {} })
    const stop = new AbortController()
    const t0 = Date.now()
    const done = d.sleep(60_000, stop.signal)
    stop.abort()
    await done
    await d.sleep(60_000, stop.signal)
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  it.runIf(process.platform === 'darwin')(
    'launches a real command with its start time from ps, and kill ends what it put in the background too',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-deskmac-'))
      const pidFile = path.posix.join(dir, 'bg.pid')
      const desk = await createMacDesks(realMacDeskDeps({ log: () => {} })).start('real')
      try {
        const t0 = Date.now()
        const got = await desk.launch({ command: `sleep 30 &\necho $! > "${pidFile}"`, cwd: dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })
        // lstart has whole seconds, so the start time is at most a second before the clock read.
        expect(got.startedAt).toBeGreaterThan(t0 - 2_000)
        expect(got.startedAt).toBeLessThanOrEqual(Date.now())
        let bg = 0
        for (let i = 0; i < 50 && !bg; i++) {
          bg = Number((await fs.readFile(pidFile, 'utf8').catch(() => '')).trim()) || 0
          if (!bg) await new Promise((res) => setTimeout(res, 100))
        }
        expect(bg).toBeGreaterThan(1)
        await desk.kill(got.pid, got.startedAt)
        const gone = (pid: number): boolean => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        }
        for (let i = 0; i < 30 && !(gone(got.pid) && gone(bg)); i++) await new Promise((res) => setTimeout(res, 100))
        expect(gone(got.pid)).toBe(true)
        expect(gone(bg)).toBe(true)
      } finally {
        await desk.close()
        await fs.rm(dir, { recursive: true, force: true })
      }
    },
    20_000
  )
})
