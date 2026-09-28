import { describe, it, expect } from 'vitest'
import { findOnWindowsPath, windowsSpawn } from './windowsExecutable'

const fsOf = (...present: string[]) => {
  const set = new Set(present.map((p) => p.toLowerCase()))
  return (p: string): boolean => set.has(p.toLowerCase())
}

describe('findOnWindowsPath', () => {
  const env = { Path: 'C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Program Files\\Git\\cmd', PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS' }

  it('finds an npm shim on PATH, with cmd.exe’s extension order', () => {
    const exists = fsOf('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd')
    expect(findOnWindowsPath('claude', env, exists)).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd')
  })

  it('prefers .exe over .cmd in the same folder, as cmd.exe does', () => {
    const exists = fsOf('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.exe')
    expect(findOnWindowsPath('claude', env, exists)).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.exe')
  })

  it('reads the PATH key however it is capitalised, and strips quotes around an entry', () => {
    const exists = fsOf('C:\\tools\\git.exe')
    expect(findOnWindowsPath('git', { PATH: '"C:\\tools"' }, exists)).toBe('C:\\tools\\git.exe')
  })

  // The whole point: a repository's folder never takes part. Neither the working directory nor a
  // relative PATH entry (`.`, `bin`) is looked at, so a `claude.cmd` shipped in a clone is never it.
  it('never looks in a relative PATH entry or the working directory', () => {
    const exists = fsOf('claude.cmd', '.\\claude.cmd', 'bin\\claude.cmd', 'C:\\repo\\claude.cmd')
    expect(findOnWindowsPath('claude', { Path: '.;bin;;' }, exists)).toBeNull()
  })

  it('answers null when PATH does not know the name', () => {
    expect(findOnWindowsPath('claude', env, fsOf())).toBeNull()
  })

  it('takes a name that already has an executable extension as it is', () => {
    const exists = fsOf('C:\\Program Files\\Git\\cmd\\git.exe')
    expect(findOnWindowsPath('git.exe', env, exists)).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
    expect(findOnWindowsPath('git.cmd', env, exists)).toBeNull()
  })

  it('does not look up a name that carries a path', () => {
    const exists = fsOf('C:\\x\\claude.exe')
    expect(findOnWindowsPath('C:\\x\\claude.exe', env, exists)).toBe('C:\\x\\claude.exe')
    expect(findOnWindowsPath('.\\claude.exe', env, exists)).toBeNull()
  })

  it('falls back to the default extensions when PATHEXT is unset or useless', () => {
    const exists = fsOf('C:\\tools\\codex.cmd')
    expect(findOnWindowsPath('codex', { PATH: 'C:\\tools' }, exists)).toBe('C:\\tools\\codex.cmd')
    expect(findOnWindowsPath('codex', { PATH: 'C:\\tools', PATHEXT: '.VBS;.JS' }, exists)).toBe('C:\\tools\\codex.cmd')
  })
})

describe('windowsSpawn', () => {
  it('spawns an .exe directly, with no shell in between', () => {
    expect(windowsSpawn('claude', ['--version'], () => 'C:\\Users\\me\\.local\\bin\\claude.exe')).toEqual({
      file: 'C:\\Users\\me\\.local\\bin\\claude.exe',
      args: ['--version']
    })
  })

  it('runs a .cmd shim through cmd.exe by its absolute path, with call and without AutoRun', () => {
    expect(windowsSpawn('claude', ['--', 'hi'], () => 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd')).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/c', 'call', 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd', '--', 'hi']
    })
  })

  // A name PATH does not know is not handed to cmd.exe, whose lookup would then reach the working
  // directory. Spawned bare it either resolves from the parent's own folders or fails outright.
  it('spawns a name PATH does not know bare, never through cmd.exe', () => {
    expect(windowsSpawn('claude', ['--version'], () => null)).toEqual({ file: 'claude', args: ['--version'] })
  })
})
