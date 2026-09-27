import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLaunchResolver } from './launch'

const withProject = async (fn: (a: { root: string; file: string }) => Promise<void>): Promise<void> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-launch-'))
  const root = path.join(dir, '내 프로젝트')
  await fs.mkdir(root)
  const file = path.join(dir, 'run-configs.json')
  await fs.writeFile(
    file,
    JSON.stringify({ [root]: [{ id: 'cfg1', name: 'Electron dev', type: 'shell', command: 'npm run dev -- --remote-debugging-port=%ASTERA_APP_CDP_PORT%', env: { MODE: 'agent' } }] }),
    'utf8'
  )
  try {
    await fn({ root, file })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('createLaunchResolver', () => {
  it('finds a Run configuration by name or id and builds its command, cwd and env', async () => {
    await withProject(async ({ root, file }) => {
      const resolve = createLaunchResolver({ runConfigsFile: file, platform: 'win32', baseEnv: () => ({ Path: 'C:\\bin' }), projectRoot: async () => root })
      for (const config of ['Electron dev', 'cfg1']) {
        const r = await resolve({ sessionId: 's1', cwd: path.join(root, 'sub'), spec: { config } })
        expect(r.command).toBe('npm run dev -- --remote-debugging-port=%ASTERA_APP_CDP_PORT%')
        expect(r.cwd).toBe(root)
        expect(r.env).toEqual({ Path: 'C:\\bin', MODE: 'agent' })
      }
    })
  })

  it('an unknown configuration names the ones there are', async () => {
    await withProject(async ({ root, file }) => {
      const resolve = createLaunchResolver({ runConfigsFile: file, platform: 'win32', baseEnv: () => ({}), projectRoot: async () => root })
      await expect(resolve({ sessionId: 's1', cwd: root, spec: { config: 'Nope' } })).rejects.toThrow('there are: Electron dev')
    })
  })

  it('a command runs in the session folder, or in a folder relative to it', async () => {
    const resolve = createLaunchResolver({ runConfigsFile: 'unused', platform: 'win32', baseEnv: () => ({ A: '1' }), projectRoot: async (c) => c })
    const cwd = path.join(os.tmpdir(), 'proj')
    expect(await resolve({ sessionId: 's1', cwd, spec: { command: 'app.exe' } })).toEqual({ command: 'app.exe', cwd, env: { A: '1' } })
    expect((await resolve({ sessionId: 's1', cwd, spec: { command: 'app.exe', cwd: 'out' } })).cwd).toBe(path.join(cwd, 'out'))
  })
})
