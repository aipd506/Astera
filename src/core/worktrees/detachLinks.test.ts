import { describe, it, expect, vi, afterEach } from 'vitest'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { detachLinks, type DetachFs } from './detachLinks'
import { tempDir } from './testRepo'

type Node = { kind: 'dir' } | { kind: 'file' } | { kind: 'link' } | { kind: 'reparseDir' }

/** An in-memory tree, by absolute path. `readdir` names reparse-point folders as links, the way the
 *  Windows listing does; `lstat` tells them apart. Every call is recorded. */
function memFs(nodes: Record<string, Node>, over: Partial<DetachFs> = {}): { fs: DetachFs; calls: string[] } {
  const calls: string[] = []
  const enoent = (p: string): Error => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
  const stat = (n: Node) => ({
    isSymbolicLink: () => n.kind === 'link',
    isDirectory: () => n.kind === 'dir' || n.kind === 'reparseDir'
  })
  const base: DetachFs = {
    lstat: async (p) => {
      calls.push(`lstat ${p}`)
      const n = nodes[p]
      if (!n) throw enoent(p)
      return stat(n)
    },
    readdir: async (d) => {
      calls.push(`readdir ${d}`)
      if (!nodes[d]) throw enoent(d)
      return Object.keys(nodes)
        .filter((p) => path.dirname(p) === d && p !== d)
        .map((p) => {
          const n = nodes[p]
          return {
            name: path.basename(p),
            isSymbolicLink: () => n.kind === 'link' || n.kind === 'reparseDir',
            isDirectory: () => n.kind === 'dir'
          }
        })
    },
    unlink: async (p) => {
      calls.push(`unlink ${p}`)
      delete nodes[p]
    },
    rmdir: async (p) => {
      calls.push(`rmdir ${p}`)
      delete nodes[p]
    }
  }
  return { fs: { ...base, ...over }, calls }
}

const R = path.resolve('/wt')
const at = (...s: string[]): string => path.join(R, ...s)

afterEach(() => {
  vi.useRealTimers()
})

describe('detachLinks, with an injected fs', () => {
  it('unlinks every link found, at any depth, and never lists what is behind one', async () => {
    const nodes: Record<string, Node> = {
      [R]: { kind: 'dir' },
      [at('a')]: { kind: 'dir' },
      [at('a', 'b')]: { kind: 'dir' },
      [at('a', 'b', 'deep')]: { kind: 'link' },
      [at('top')]: { kind: 'link' },
      [at('f.txt')]: { kind: 'file' }
    }
    const { fs: mfs, calls } = memFs(nodes)
    expect(await detachLinks(R, { fs: mfs })).toEqual({ ok: true, unlinked: 2 })
    expect(calls).toContain(`unlink ${at('top')}`)
    expect(calls).toContain(`unlink ${at('a', 'b', 'deep')}`)
    expect(calls.filter((c) => c.startsWith('readdir')).sort()).toEqual(
      [`readdir ${R}`, `readdir ${at('a')}`, `readdir ${at('a', 'b')}`].sort()
    )
    expect(calls.some((c) => c.startsWith('unlink') && c.endsWith('f.txt'))).toBe(false)
  })

  it('falls back to rmdir on the link itself when unlink refuses', async () => {
    const nodes: Record<string, Node> = { [R]: { kind: 'dir' }, [at('j')]: { kind: 'link' } }
    const { fs: mfs, calls } = memFs(nodes, {
      unlink: async () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      }
    })
    expect(await detachLinks(R, { fs: mfs })).toEqual({ ok: true, unlinked: 1 })
    expect(calls).toContain(`rmdir ${at('j')}`)
  })

  it('walks a reparse-point folder that lstat says is not a link, and removes nothing there', async () => {
    const nodes: Record<string, Node> = {
      [R]: { kind: 'dir' },
      [at('cloud')]: { kind: 'reparseDir' },
      [at('cloud', 'l')]: { kind: 'link' }
    }
    const { fs: mfs, calls } = memFs(nodes)
    expect(await detachLinks(R, { fs: mfs })).toEqual({ ok: true, unlinked: 1 })
    expect(calls).not.toContain(`unlink ${at('cloud')}`)
    expect(calls).toContain(`unlink ${at('cloud', 'l')}`)
  })

  it('spares the links `keep` names', async () => {
    const nodes: Record<string, Node> = {
      [R]: { kind: 'dir' },
      [at('tracked')]: { kind: 'link' },
      [at('node_modules')]: { kind: 'dir' },
      [at('node_modules', 'pkg')]: { kind: 'link' }
    }
    const { fs: mfs, calls } = memFs(nodes)
    expect(await detachLinks(R, { fs: mfs, keep: (rel) => rel === 'tracked' })).toEqual({ ok: true, unlinked: 1 })
    expect(calls).not.toContain(`unlink ${at('tracked')}`)
    expect(calls).toContain(`unlink ${at('node_modules', 'pkg')}`)
  })

  it('answers ok for a folder that is not there, and not ok for one that is itself a link', async () => {
    expect(await detachLinks(R, { fs: memFs({}).fs })).toEqual({ ok: true, unlinked: 0 })
    const r = await detachLinks(R, { fs: memFs({ [R]: { kind: 'link' } }).fs })
    expect(r.ok).toBe(false)
  })

  it('is not ok when a folder cannot be listed or a link cannot be removed', async () => {
    const listFails = memFs({ [R]: { kind: 'dir' }, [at('a')]: { kind: 'dir' } }, {
      readdir: async (d) => {
        if (d === at('a')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return [{ name: 'a', isSymbolicLink: () => false, isDirectory: () => true }]
      }
    })
    expect((await detachLinks(R, { fs: listFails.fs })).ok).toBe(false)
    const cannotRemove = memFs({ [R]: { kind: 'dir' }, [at('j')]: { kind: 'link' } }, {
      unlink: async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) },
      rmdir: async () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }) }
    })
    expect((await detachLinks(R, { fs: cannotRemove.fs })).ok).toBe(false)
  })

  it('stops past its entry cap', async () => {
    const nodes: Record<string, Node> = { [R]: { kind: 'dir' } }
    for (let i = 0; i < 10; i++) nodes[at(`f${i}`)] = { kind: 'file' }
    const r = await detachLinks(R, { fs: memFs(nodes).fs, maxEntries: 5 })
    expect(r.ok).toBe(false)
  })

  it('answers not ok at its deadline, and removes nothing after it', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const nodes: Record<string, Node> = { [R]: { kind: 'dir' }, [at('j')]: { kind: 'link' } }
    const { fs: mfs, calls } = memFs(nodes, {
      readdir: async () => {
        await new Promise<void>((r) => (release = r))
        return [{ name: 'j', isSymbolicLink: () => true, isDirectory: () => false }]
      }
    })
    const answer = detachLinks(R, { fs: mfs, timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(1001)
    const r = await answer
    expect(r.ok).toBe(false)
    release()
    await vi.advanceTimersByTimeAsync(10)
    expect(calls.some((c) => c.startsWith('unlink'))).toBe(false)
  })
})

describe('detachLinks, on the real file system', () => {
  it('unlinks a folder link and leaves what it pointed at whole', async () => {
    const outside = await tempDir('astera-detach-out-')
    await fs.writeFile(path.join(outside, 'keep.txt'), 'k')
    const wt = await tempDir('astera-detach-wt-')
    await fs.mkdir(path.join(wt, 'node_modules'))
    await fs.symlink(outside, path.join(wt, 'node_modules', 'pkg'), 'junction')
    await fs.writeFile(path.join(wt, 'a.txt'), 'a')
    expect(await detachLinks(wt)).toEqual({ ok: true, unlinked: 1 })
    expect(existsSync(path.join(wt, 'node_modules', 'pkg'))).toBe(false)
    expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('k')
    expect(await fs.readFile(path.join(wt, 'a.txt'), 'utf8')).toBe('a')
  })
})
