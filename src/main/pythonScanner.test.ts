import { describe, it, expect, vi } from 'vitest'
import { createPythonScanner, type PythonScannerDeps } from './pythonScanner'

const STUB = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe'
const SYSTEM = 'C:\\Python311\\python.exe'

/** A machine in memory: `exists` is what fs.access finds, `onPath` what `where` prints per name. */
function machine(opts: { exists: Set<string>; onPath: string }) {
  const findOnPath = vi.fn(async (_name: string) => opts.onPath)
  const version = vi.fn(async (_exe: string) => 'Python 3.11.4')
  const access = vi.fn(async (p: string) => {
    if (!opts.exists.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
  const deps: PythonScannerDeps = { platform: 'win32', access, findOnPath, version }
  return { deps, findOnPath, version, access }
}

describe('createPythonScanner', () => {
  // The Store alias can stall `--version` until the 5 s deadline — it is not an interpreter.
  it('never runs the WindowsApps stub that `where` returns', async () => {
    const m = machine({ exists: new Set([STUB, SYSTEM]), onPath: `${STUB}\r\n${SYSTEM}\r\n` })
    const list = await createPythonScanner(m.deps).list('D:\\proj')
    expect(list).toEqual([{ path: SYSTEM, version: '3.11.4' }])
    expect(m.version.mock.calls.map((c) => c[0])).not.toContain(STUB)
    expect(m.access.mock.calls.map((c) => c[0])).not.toContain(STUB)
  })

  // Opening the run configuration dialog re-ran `where` and every `--version` probe each time.
  it('caches per project: a second open runs no probes', async () => {
    const m = machine({ exists: new Set([SYSTEM]), onPath: SYSTEM })
    const scanner = createPythonScanner(m.deps)
    const first = await scanner.list('D:\\proj')
    const probes = m.findOnPath.mock.calls.length + m.version.mock.calls.length
    const second = await scanner.list('D:\\proj')
    expect(second).toEqual(first)
    expect(m.findOnPath.mock.calls.length + m.version.mock.calls.length).toBe(probes)
  })

  it('two opens at once share one scan', async () => {
    const m = machine({ exists: new Set([SYSTEM]), onPath: SYSTEM })
    const scanner = createPythonScanner(m.deps)
    await Promise.all([scanner.list('D:\\proj'), scanner.list('D:\\proj')])
    expect(m.version).toHaveBeenCalledTimes(1)
  })

  it('another project is scanned on its own (its venv is its own)', async () => {
    const venvA = 'D:\\a\\.venv\\Scripts\\python.exe'
    const m = machine({ exists: new Set([SYSTEM, venvA]), onPath: SYSTEM })
    const scanner = createPythonScanner(m.deps)
    expect((await scanner.list('D:\\a')).map((p) => p.path)).toContain(venvA)
    expect((await scanner.list('D:\\b')).map((p) => p.path)).toEqual([SYSTEM])
  })

  // The reason this was once left uncached: `python -m venv .venv` in the project terminal, with the
  // app open. A venv appearing (or going) since the scan is noticed without a restart.
  it('a venv created after the scan is picked up on the next open', async () => {
    const venv = 'D:\\proj\\.venv\\Scripts\\python.exe'
    const exists = new Set([SYSTEM])
    const m = machine({ exists, onPath: SYSTEM })
    const scanner = createPythonScanner(m.deps)
    expect((await scanner.list('D:\\proj')).map((p) => p.path)).toEqual([SYSTEM])
    exists.add(venv)
    expect((await scanner.list('D:\\proj')).map((p) => p.path)).toEqual([venv, SYSTEM])
  })

  it('a probe that throws leaves the interpreter out, never a rejection', async () => {
    const m = machine({ exists: new Set([SYSTEM]), onPath: SYSTEM })
    m.findOnPath.mockRejectedValue(new Error('spawn failed'))
    await expect(createPythonScanner(m.deps).list('D:\\proj')).resolves.toEqual([])
  })
})
