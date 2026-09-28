import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { privateDirProblem, unsafeSocketDir } from './socketDir'

const dirOf = (o: { dir?: boolean; uid?: number; mode?: number }) => ({
  isDirectory: () => o.dir ?? true,
  uid: o.uid ?? 501,
  mode: o.mode ?? 0o40700
})

describe('privateDirProblem', () => {
  it('accepts a directory owned by this user that nobody else can enter', () => {
    expect(privateDirProblem(dirOf({}), 501)).toBeNull()
  })
  it('refuses another user’s directory', () => {
    expect(privateDirProblem(dirOf({ uid: 1000 }), 501)).toContain('uid 1000')
  })
  it('refuses a directory others can enter, naming the mode', () => {
    expect(privateDirProblem(dirOf({ mode: 0o40755 }), 501)).toContain('755')
    expect(privateDirProblem(dirOf({ mode: 0o40770 }), 501)).toContain('770')
  })
  it('refuses a link or a file where the directory should be', () => {
    expect(privateDirProblem(dirOf({ dir: false }), 501)).toContain('not a directory')
  })
  it('refuses when this process has no uid to compare with', () => {
    expect(privateDirProblem(dirOf({}), undefined)).not.toBeNull()
  })
})

describe('unsafeSocketDir', () => {
  it('a named pipe has no directory to ask about', async () => {
    expect(await unsafeSocketDir('\\\\.\\pipe\\astera-host-abc-v3')).toBeNull()
  })
  it('a directory that is not there is nobody’s: the ordinary no-Host path', async () => {
    expect(await unsafeSocketDir(path.join(os.tmpdir(), 'astera-not-there-' + Math.random(), 'sock'))).toBeNull()
  })
  it.skipIf(process.platform === 'win32')('names a directory open to everyone', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-socketdir-'))
    expect(await unsafeSocketDir(path.join(dir, 'sock'))).toBeNull()
    await fs.chmod(dir, 0o777)
    expect(await unsafeSocketDir(path.join(dir, 'sock'))).toContain('777')
  })
})
