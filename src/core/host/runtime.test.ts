import { describe, it, expect } from 'vitest'
import { hostRuntimeBase, hostRuntimePaths } from './runtime'

const BASE = 'C:\\Users\\x\\AppData\\Local\\astera\\host-runtime'
const paths = hostRuntimePaths({ base: BASE, nodeVersion: '24.15.0', appVersion: '1.3.21' })

describe('hostRuntimeBase', () => {
  it('is under LOCALAPPDATA on win32 — never the roaming profile', () => {
    const base = hostRuntimeBase({
      platform: 'win32',
      localAppData: 'C:\\Users\\x\\AppData\\Local',
      userData: 'C:\\Users\\x\\AppData\\Roaming\\astera',
      appName: 'astera'
    })
    expect(base).toBe('C:\\Users\\x\\AppData\\Local\\astera\\host-runtime')
  })

  it('falls back to userData when LOCALAPPDATA is unset', () => {
    const base = hostRuntimeBase({
      platform: 'win32',
      localAppData: undefined,
      userData: 'C:\\Users\\x\\AppData\\Roaming\\astera',
      appName: 'astera'
    })
    expect(base).toBe('C:\\Users\\x\\AppData\\Roaming\\astera\\host-runtime')
  })

  it('and treats an empty LOCALAPPDATA as unset rather than joining onto nothing', () => {
    const base = hostRuntimeBase({
      platform: 'win32',
      localAppData: '   ',
      userData: 'C:\\p',
      appName: 'astera'
    })
    expect(base).toBe('C:\\p\\host-runtime')
  })

  it('is null off win32 — those platforms replace a running binary and need none of this', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(hostRuntimeBase({ platform, localAppData: '/tmp', userData: '/home/x', appName: 'astera' })).toBeNull()
    }
  })
})

describe('hostRuntimePaths', () => {
  it('nests builds inside the Node directory, so `require("node-pty")` resolves by walking up', () => {
    expect(paths.nodeDir).toBe(BASE + '\\node-24.15.0-astera-host')
    expect(paths.buildDir).toBe(BASE + '\\node-24.15.0-astera-host\\builds\\1.3.21')
    expect(paths.entryPath).toBe(BASE + '\\node-24.15.0-astera-host\\builds\\1.3.21\\host.js')
  })

  // Task Manager's Details tab lists a process by its file name, and "node.exe" there said nothing
  // about whose it was. Only the name changes: the bytes are Node's, still carrying its signature.
  it('names the executable astera-host.exe', () => {
    expect(paths.exePath).toBe(BASE + '\\node-24.15.0-astera-host\\astera-host.exe')
  })

  // A directory of its own for the renamed file, so an update lays it down the way a new Node version
  // is laid down, while a Host from before the rename keeps running out of the old one, and the sweep
  // takes the old one once that Host is gone. That older Host is still this app's: ending an
  // unresponsive one has to recognise its executable too.
  it('says where a runtime from before the rename keeps its executable', () => {
    expect(paths.legacyExePath).toBe(BASE + '\\node-24.15.0\\node.exe')
  })
})
