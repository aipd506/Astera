import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OUTSIDE_ROOT, TMP_TAKEN, writeWithinRoot } from './atomicWrite'

const mk = async (): Promise<{ root: string; outside: string }> => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-atomicwrite-'))
  const root = path.join(base, 'root')
  const outside = path.join(base, 'outside')
  await fs.mkdir(root)
  await fs.mkdir(outside)
  return { root, outside }
}

describe('writeWithinRoot', () => {
  it('replaces the file with the content, and leaves no temporary file', async () => {
    const { root } = await mk()
    const file = path.join(root, 'a.txt')
    await fs.writeFile(file, 'old')
    await writeWithinRoot(root, file, 'new')
    expect(await fs.readFile(file, 'utf8')).toBe('new')
    expect(await fs.readdir(root)).toEqual(['a.txt'])
  })

  // Security review 2026-09-28: a repository ships `X` beside a symlink `X.cmtmp` that points outside
  // the project. The old write opened `X.cmtmp` with O_TRUNC and followed the link, so saving X in
  // the editor rewrote the file the link named — ~/.zshrc, ~/.ssh/authorized_keys — with the
  // repository's content.
  it('never writes through a link planted at the temporary name', async () => {
    const { root, outside } = await mk()
    const target = path.join(outside, 'zshrc')
    await fs.writeFile(target, 'mine')
    const file = path.join(root, 'notes.sh')
    await fs.writeFile(file, 'payload')
    await fs.symlink(target, `${file}.cmtmp`)
    await writeWithinRoot(root, file, 'payload edited')
    expect(await fs.readFile(target, 'utf8')).toBe('mine')
    expect(await fs.readFile(file, 'utf8')).toBe('payload edited')
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(false)
  })

  it('refuses a link at the temporary name rather than writing beside it silently', async () => {
    const { root, outside } = await mk()
    const file = path.join(root, 'notes.sh')
    await fs.writeFile(file, 'payload')
    await fs.symlink(path.join(outside, 'gone'), `${file}.cmtmp`)
    // Refused before open on every platform: Windows follows a dangling link even under O_EXCL
    await expect(writeWithinRoot(root, file, 'x', { tmpName: (p) => `${p}.cmtmp` })).rejects.toThrow(TMP_TAKEN)
    expect(await fs.readFile(file, 'utf8')).toBe('payload')
    await expect(fs.stat(path.join(outside, 'gone'))).rejects.toThrow()
  })

  // The other shape of the same escape: a directory link inside the root (`cfg -> ~/.ssh`), reached
  // through a relative link in a README. The temporary file and the rename would both land in the
  // linked directory, so the directory is checked for real, not just lexically.
  it('refuses a file whose directory is a link out of the root', async () => {
    const { root, outside } = await mk()
    await fs.symlink(outside, path.join(root, 'cfg'))
    const file = path.join(root, 'cfg', 'authorized_keys')
    await expect(writeWithinRoot(root, file, 'ssh-ed25519 AAAA')).rejects.toThrow(OUTSIDE_ROOT)
    expect(await fs.readdir(outside)).toEqual([])
  })

  it('keeps working under a root that is itself reached through a link (macOS /var, /tmp)', async () => {
    const { root } = await mk()
    // os.tmpdir() on macOS is /var/folders/…, and /var is a symlink to /private/var: the lexical root
    // and the real root differ, and a plain file under it must still be writable.
    const file = path.join(root, 'b.txt')
    await writeWithinRoot(root, file, 'ok')
    expect(await fs.readFile(file, 'utf8')).toBe('ok')
  })

  it('a link inside the root that resolves inside the root still works', async () => {
    const { root } = await mk()
    await fs.mkdir(path.join(root, 'real'))
    await fs.symlink(path.join(root, 'real'), path.join(root, 'alias'))
    const file = path.join(root, 'alias', 'c.txt')
    await writeWithinRoot(root, file, 'via link')
    expect(await fs.readFile(path.join(root, 'real', 'c.txt'), 'utf8')).toBe('via link')
  })
})
