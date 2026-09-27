import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { readConfiguredModel } from './configuredModel'

// Stage 4 T1: the chat pane asks for the configured model on mount. The files were read with
// readFileSync from the session's folder, which can sit on an offline share: that froze the Electron
// main thread for 20 to 60 s. Now each folder is asked once through the probe budget and read async.
describe('readConfiguredModel', () => {
  const cwd = path.join('proj')
  const configDir = path.join('cfg')
  const files = (m: Record<string, unknown>) =>
    vi.fn(async (p: string) => {
      if (!(p in m)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return JSON.stringify(m[p])
    })

  it('reads local, then project, then user, asynchronously', async () => {
    const readFile = files({
      [path.join(cwd, '.claude', 'settings.json')]: { model: 'project-model' },
      [path.join(configDir, 'settings.json')]: { model: 'user-model' }
    })
    const r = readConfiguredModel({ cwd, configDir }, { gate: async () => 'present', readFile })
    expect(r).toBeInstanceOf(Promise)
    expect(await r).toBe('project-model')
  })

  it('a folder that did not answer is not read, and is not a source', async () => {
    const readFile = files({
      [path.join(cwd, '.claude', 'settings.json')]: { model: 'project-model' },
      [path.join(configDir, 'settings.json')]: { model: 'user-model' }
    })
    const asked: string[] = []
    const model = await readConfiguredModel(
      { cwd, configDir },
      { gate: async (p) => { asked.push(p); return p === cwd ? 'timeout' : 'present' }, readFile }
    )
    expect(asked).toEqual([cwd, configDir])
    expect(readFile.mock.calls.map((c) => c[0]).some((p) => p.startsWith(cwd))).toBe(false)
    expect(model).toBe('user-model')
  })
})
