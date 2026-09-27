import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  asyncRuntimeFs,
  createRuntimeInstaller,
  installHostRuntime,
  spawnWhenInstalled,
  type AsyncFs
} from './runtimeInstall'
import { hostRuntimePaths } from '../../core/host/runtime'
import type { HostRuntimeInstallState } from '../../core/types'

const B = '\\'
const BASE = ['C:', 'Users', 'x', 'AppData', 'Local', 'astera', 'host-runtime'].join(B)
const SHIPPED_ROOT = ['C:', 'Program Files', 'Astera', 'resources', 'host-runtime'].join(B)
const NODE = '24.15.0'
const APP = '1.3.21'
const paths = hostRuntimePaths({ base: BASE, nodeVersion: NODE, appVersion: APP })
const SHIPPED = `${SHIPPED_ROOT}${B}node-${NODE}`

/** `fs.promises`, as far as this module uses it, over a set of paths — and nothing else. It also
 *  carries every `*Sync` twin, each of which records its own use and throws, so a sync call anywhere
 *  on the install path fails the test instead of passing unnoticed. Every property read is recorded
 *  as well, through the proxy `wrap` returns. */
class MemFs {
  files = new Map<string, string>()
  touched: string[] = []
  syncCalls: string[] = []
  under(p: string, dir: string): boolean {
    return p === dir || p.startsWith(dir + B)
  }
  has(p: string): boolean {
    return [...this.files.keys()].some((f) => this.under(f, p))
  }
  add(...ps: string[]): this {
    for (const p of ps) this.files.set(p, '')
    return this
  }
  wrap(): AsyncFs {
    const enoent = (p: string): Error => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    const impl: Record<string, unknown> = {
      access: async (p: string) => {
        if (!this.has(p)) throw enoent(p)
      },
      readdir: async (p: string) => {
        if (!this.has(p)) throw enoent(p)
        const names = new Set<string>()
        for (const f of this.files.keys()) if (f.startsWith(p + B)) names.add(f.slice(p.length + 1).split(B)[0])
        return [...names]
      },
      cp: async (from: string, to: string) => {
        const moved = [...this.files.entries()].filter(([f]) => this.under(f, from))
        if (moved.length === 0) throw enoent(from)
        for (const [f, v] of moved) this.files.set(to + f.slice(from.length), v)
      },
      rename: async (from: string, to: string) => {
        if (this.has(to)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        for (const [f, v] of [...this.files.entries()]) {
          if (!this.under(f, from)) continue
          this.files.delete(f)
          this.files.set(to + f.slice(from.length), v)
        }
      },
      rm: async (p: string) => {
        for (const f of [...this.files.keys()]) if (this.under(f, p)) this.files.delete(f)
      },
      readFile: async (p: string) => {
        const v = this.files.get(p)
        if (v === undefined) throw enoent(p)
        return v
      }
    }
    for (const name of ['cpSync', 'rmSync', 'renameSync', 'existsSync', 'readdirSync', 'readFileSync', 'statSync', 'accessSync', 'mkdirSync', 'copyFileSync']) {
      impl[name] = () => {
        this.syncCalls.push(name)
        throw new Error(`${name} called on the install path`)
      }
    }
    return new Proxy(impl, {
      get: (t, k) => {
        if (typeof k === 'string') this.touched.push(k)
        return t[k as string]
      }
    }) as unknown as AsyncFs
  }
}

function shipped(): MemFs {
  const m = new MemFs().add(
    `${SHIPPED}${B}node.exe`,
    `${SHIPPED}${B}node_modules${B}node-pty${B}lib${B}index.js`,
    `${SHIPPED}${B}builds${B}${APP}${B}host.js`
  )
  m.files.set(
    `${SHIPPED_ROOT}${B}runtime.json`,
    JSON.stringify({ node: NODE, files: { node: ['node.exe', `node_modules${B}node-pty${B}lib${B}index.js`], build: ['host.js'] } })
  )
  return m
}

function install(m: MemFs, onInstall?: () => void): ReturnType<typeof installHostRuntime> {
  return installHostRuntime({
    base: BASE,
    shippedRoot: SHIPPED_ROOT,
    appVersion: APP,
    stamp: '42',
    fs: m.wrap(),
    onInstall,
    log: () => {}
  })
}

describe('installHostRuntime — the whole install path, with no sync fs call on it', () => {
  it('installs from the shipped tree through fs.promises alone', async () => {
    const m = shipped()
    const r = await install(m)
    expect(r.failure).toBeNull()
    expect(r.runtime?.paths.exePath).toBe(paths.exePath)
    expect(m.has(paths.exePath)).toBe(true)
    expect(m.has(paths.entryPath)).toBe(true)
    expect(m.syncCalls).toEqual([])
    expect(m.touched.filter((k) => k.endsWith('Sync'))).toEqual([])
  })

  it('keeps the staging-and-rename landing: nothing is copied straight into the node directory', async () => {
    const m = shipped()
    const cp = vi.fn()
    const wrapped = m.wrap()
    const spy: AsyncFs = { ...pick(wrapped), cp: async (from, to, o) => (cp(from, to), wrapped.cp(from, to, o)) }
    await installHostRuntime({ base: BASE, shippedRoot: SHIPPED_ROOT, appVersion: APP, stamp: '42', fs: spy, log: () => {} })
    // One copy: the shipped node directory carries this build inside it, so the build is already
    // there once the node directory lands.
    expect(cp.mock.calls.map((c) => c[1])).toEqual([`${paths.nodeDir}.staging-42`])
    expect(m.has(`${paths.nodeDir}.staging-42`)).toBe(false)
  })

  it('reads the manifest asynchronously, and falls back with no failure when nothing was shipped', async () => {
    const m = new MemFs()
    const r = await install(m)
    expect(r).toEqual({ runtime: null, failure: null })
    expect(m.syncCalls).toEqual([])
  })

  it('reports a failed install and leaves nothing where the spawn looks', async () => {
    const m = shipped()
    const wrapped = m.wrap()
    const refusing: AsyncFs = {
      ...pick(wrapped),
      cp: async () => {
        throw new Error('EACCES: antivirus holds node.exe')
      }
    }
    const r = await installHostRuntime({ base: BASE, shippedRoot: SHIPPED_ROOT, appVersion: APP, stamp: '42', fs: refusing, log: () => {} })
    expect(r.runtime).toBeNull()
    expect(r.failure).toMatch(/antivirus holds node\.exe/)
    expect(m.has(paths.exePath)).toBe(false)
  })

  it('raises onInstall when it writes, and not when the runtime is already whole', async () => {
    const m = shipped()
    const first = vi.fn()
    await install(m, first)
    expect(first).toHaveBeenCalledTimes(1)
    const again = vi.fn()
    await install(m, again)
    expect(again).not.toHaveBeenCalled()
  })
})

/** The six members a test replaces one of, read off the proxy so the others keep recording. */
function pick(f: AsyncFs): AsyncFs {
  return { access: f.access, readdir: f.readdir, cp: f.cp, rename: f.rename, rm: f.rm, readFile: f.readFile }
}

describe('asyncRuntimeFs', () => {
  it('answers exists from access, and never calls a sync function', async () => {
    const m = new MemFs().add('C:\\a\\b')
    const fs = asyncRuntimeFs(m.wrap())
    expect(await fs.exists('C:\\a\\b')).toBe(true)
    expect(await fs.exists('C:\\nope')).toBe(false)
    expect(await fs.readdir('C:\\nope')).toEqual([])
    await fs.rm('C:\\nope')
    expect(m.syncCalls).toEqual([])
  })
})

/** A promise the test resolves by hand. */
function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createRuntimeInstaller — one install at a time, and what the window is told', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shares one in-flight install between concurrent callers', async () => {
    const d = deferred<{ value: string; failure: string | null }>()
    const run = vi.fn(() => d.promise)
    const inst = createRuntimeInstaller({ run, onState: () => {}, log: () => {} })
    const a = inst.ensure()
    const b = inst.ensure()
    const c = inst.ensure()
    expect(run).toHaveBeenCalledTimes(1)
    d.resolve({ value: 'rt', failure: null })
    expect(await Promise.all([a, b, c])).toEqual(['rt', 'rt', 'rt'])
  })

  it('runs again once the previous install has settled — the check before every spawn', async () => {
    const run = vi.fn(async () => ({ value: 1, failure: null }))
    const inst = createRuntimeInstaller({ run, onState: () => {}, log: () => {} })
    await inst.ensure()
    await inst.ensure()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('says preparing when the install writes, still-working after a second, and idle when done', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const d = deferred<{ value: number; failure: string | null }>()
    const states: HostRuntimeInstallState[] = []
    const inst = createRuntimeInstaller({
      run: (hooks) => {
        hooks.installing()
        return d.promise
      },
      onState: (s) => states.push(s),
      log: () => {}
    })
    const p = inst.ensure()
    expect(inst.state()).toEqual({ phase: 'preparing', slow: false, startedAt: 1_000 })
    vi.advanceTimersByTime(999)
    expect(inst.state()).toMatchObject({ slow: false })
    vi.advanceTimersByTime(1)
    expect(inst.state()).toEqual({ phase: 'preparing', slow: true, startedAt: 1_000 })
    d.resolve({ value: 1, failure: null })
    await p
    expect(inst.state()).toEqual({ phase: 'idle' })
    expect(states.map((s) => (s.phase === 'preparing' ? `preparing${s.slow ? '-slow' : ''}` : s.phase))).toEqual([
      'preparing',
      'preparing-slow',
      'idle'
    ])
  })

  it('tells the window nothing when the install had nothing to write', async () => {
    const onState = vi.fn()
    const inst = createRuntimeInstaller({ run: async () => ({ value: 1, failure: null }), onState, log: () => {} })
    await inst.ensure()
    expect(onState).not.toHaveBeenCalled()
    expect(inst.state()).toEqual({ phase: 'idle' })
  })

  it('reports a failed install, and clears it when a later one succeeds', async () => {
    let fail = true
    const inst = createRuntimeInstaller({
      run: async (hooks) => {
        hooks.installing()
        return fail ? { value: null, failure: 'the host runtime could not be installed: EBUSY' } : { value: 'rt', failure: null }
      },
      onState: () => {},
      log: () => {}
    })
    expect(await inst.ensure()).toBeNull()
    expect(inst.state()).toEqual({ phase: 'failed', detail: 'the host runtime could not be installed: EBUSY' })
    fail = false
    expect(await inst.ensure()).toBe('rt')
    expect(inst.state()).toEqual({ phase: 'idle' })
  })

  it('turns a thrown install into a reported failure and a null answer, never a rejection', async () => {
    const log = vi.fn()
    const inst = createRuntimeInstaller<string>({
      run: async () => {
        throw new Error('EIO')
      },
      onState: () => {},
      log
    })
    await expect(inst.ensure()).resolves.toBeNull()
    expect(inst.state()).toMatchObject({ phase: 'failed', detail: expect.stringContaining('EIO') })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('EIO'))
  })

  it('survives a window that throws when told', async () => {
    const inst = createRuntimeInstaller({
      run: async (hooks) => {
        hooks.installing()
        return { value: 1, failure: null }
      },
      onState: () => {
        throw new Error('window gone')
      },
      log: () => {}
    })
    await expect(inst.ensure()).resolves.toBe(1)
  })

  it('whenSettled waits for the install in flight, and answers at once when there is none', async () => {
    const d = deferred<{ value: number; failure: string | null }>()
    const inst = createRuntimeInstaller({ run: () => d.promise, onState: () => {}, log: () => {} })
    await inst.whenSettled()
    void inst.ensure()
    let settled = false
    const w = inst.whenSettled().then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    d.resolve({ value: 1, failure: null })
    await w
    expect(settled).toBe(true)
  })
})

describe('spawnWhenInstalled — no Host is spawned from a runtime still being written', () => {
  it('spawns only after the install has finished, with what it produced', async () => {
    const d = deferred<{ value: string; failure: string | null }>()
    const inst = createRuntimeInstaller({ run: () => d.promise, onState: () => {}, log: () => {} })
    const spawn = vi.fn()
    const p = spawnWhenInstalled(inst, spawn)()
    await Promise.resolve()
    await Promise.resolve()
    expect(spawn).not.toHaveBeenCalled()
    d.resolve({ value: 'rt', failure: null })
    await p
    expect(spawn).toHaveBeenCalledWith('rt')
  })

  it('still spawns — from the app executable — when the install failed', async () => {
    const inst = createRuntimeInstaller<string>({
      run: async () => ({ value: null, failure: 'no' }),
      onState: () => {},
      log: () => {}
    })
    const spawn = vi.fn()
    await spawnWhenInstalled(inst, spawn)()
    expect(spawn).toHaveBeenCalledWith(null)
  })
})
