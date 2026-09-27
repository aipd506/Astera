import { describe, it, expect, afterEach } from 'vitest'
import type { TestContext } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTree, copyTree, removeWithSnapshot } from './fsTree'
import { LocalHistoryStore } from '../localHistory/store'
import type { FileOpStage } from '../types'

const dirs: string[] = []
async function tmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function trySymlink(ctx: TestContext, target: string, linkPath: string, type: 'file' | 'dir'): Promise<void> {
  try {
    await fs.symlink(target, linkPath, type)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') ctx.skip(`symlink 생성 권한 없음(${code})`)
    throw err
  }
}

const exists = (p: string): Promise<boolean> => fs.lstat(p).then(() => true, () => false)

async function makeTree(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'a', 'b'), { recursive: true })
  await fs.writeFile(path.join(root, 'x.txt'), 'x')
  await fs.writeFile(path.join(root, 'a', 'y.txt'), 'y')
  await fs.writeFile(path.join(root, 'a', 'b', 'z.txt'), 'z')
}

// fs.rm(recursive) 는 끝날 때까지 아무것도 알리지 않는다 — 수만 개를 지우는 동안 탐색기가 멈춘 것처럼
// 보인다. removeTree 는 같은 결과를 내면서 항목마다 알린다.
describe('removeTree', () => {
  it('폴더를 통째로 지우고, 지운 항목마다 알린다', async () => {
    const root = await tmp('astera-rmtree-')
    const target = path.join(root, 't')
    await makeTree(target)
    let n = 0
    await removeTree(target, () => n++)
    expect(await exists(target)).toBe(false)
    expect(n).toBe(6) // x.txt, a, a/y.txt, a/b, a/b/z.txt, t
  })

  it('파일 하나도 지운다', async () => {
    const root = await tmp('astera-rmtree-file-')
    const f = path.join(root, 'f.txt')
    await fs.writeFile(f, 'f')
    await removeTree(f)
    expect(await exists(f)).toBe(false)
  })

  it('폴더를 가리키는 링크는 링크만 지우고 따라가 대상을 지우지 않는다', async (ctx) => {
    const root = await tmp('astera-rmtree-link-')
    const outside = await tmp('astera-rmtree-link-out-')
    await fs.writeFile(path.join(outside, 'keep.txt'), 'keep')
    const target = path.join(root, 't')
    await fs.mkdir(target)
    await trySymlink(ctx, outside, path.join(target, 'link'), 'dir')
    await removeTree(target)
    expect(await exists(target)).toBe(false)
    expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it.runIf(process.platform === 'win32')('Windows 정션도 따라가지 않는다', async () => {
    const root = await tmp('astera-rmtree-junction-')
    const outside = await tmp('astera-rmtree-junction-out-')
    await fs.writeFile(path.join(outside, 'keep.txt'), 'keep')
    const target = path.join(root, 't')
    await fs.mkdir(target)
    await fs.symlink(outside, path.join(target, 'j'), 'junction')
    await removeTree(target)
    expect(await exists(target)).toBe(false)
    expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })

  // fs.rm(recursive) 처럼 한 항목이 실패해도(잠긴 파일 등) 나머지 형제는 끝까지 지우고, 첫 오류를
  // 마지막에 던진다 — a/ 의 잠긴 파일 하나 때문에 b/·c/ 가 남지 않는다.
  it('한 항목이 실패해도 형제들은 지우고, 끝에 첫 오류를 던진다', async () => {
    const root = await tmp('astera-rmtree-partial-')
    const target = path.join(root, 't')
    for (const d of ['a', 'b', 'c']) {
      await fs.mkdir(path.join(target, d), { recursive: true })
      await fs.writeFile(path.join(target, d, 'f.txt'), d)
    }
    await fs.writeFile(path.join(target, 'top.txt'), 'top')
    const locked = path.join(target, 'a', 'f.txt')
    const rm: typeof fs.rm = async (p, o) => {
      if (String(p) === locked) throw Object.assign(new Error('EBUSY: locked'), { code: 'EBUSY' })
      return fs.rm(p, o)
    }
    await expect(removeTree(target, undefined, { rm })).rejects.toMatchObject({ code: 'EBUSY' })
    expect(await exists(locked)).toBe(true)
    expect(await exists(path.join(target, 'b'))).toBe(false)
    expect(await exists(path.join(target, 'c'))).toBe(false)
    expect(await exists(path.join(target, 'top.txt'))).toBe(false)
  })

  it('없는 대상은 거절한다(fs.rm 과 같은 ENOENT)', async () => {
    const root = await tmp('astera-rmtree-missing-')
    await expect(removeTree(path.join(root, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('copyTree', () => {
  it('fs.cp 와 같이 복사하고, 복사한 항목마다 알린다', async () => {
    const root = await tmp('astera-cptree-')
    const from = path.join(root, 'src')
    await makeTree(from)
    let n = 0
    await copyTree(from, path.join(root, 'dst'), () => n++)
    expect(await fs.readFile(path.join(root, 'dst', 'a', 'b', 'z.txt'), 'utf8')).toBe('z')
    expect(n).toBeGreaterThanOrEqual(6)
  })

  it('목적지가 있으면 덮어쓰지 않고 거절한다', async () => {
    const root = await tmp('astera-cptree-exist-')
    await fs.writeFile(path.join(root, 'a.txt'), 'new')
    await fs.writeFile(path.join(root, 'b.txt'), 'old')
    await expect(copyTree(path.join(root, 'a.txt'), path.join(root, 'b.txt'))).rejects.toThrow()
    expect(await fs.readFile(path.join(root, 'b.txt'), 'utf8')).toBe('old')
  })
})

// files.remove 의 본체. 파일 수 상한을 넘으면 스냅샷 없이 지우고 'too-large' 로 알린다 — 렌더러는
// 이 값으로 "Local History 에 남기지 않았다" 를 보인다.
describe('removeWithSnapshot', () => {
  it('파일 수 상한을 넘는 폴더는 스냅샷을 건너뛰고(too-large) 그래도 지운다', async () => {
    const root = await tmp('astera-rws-many-')
    const history = new LocalHistoryStore(path.join(root, 'lh'), process.platform, { maxEntries: 3 })
    await history.load()
    const proj = path.join(root, 'proj')
    const target = path.join(proj, 't')
    await makeTree(target) // 5 entries
    const stages: FileOpStage[] = []
    const r = await removeWithSnapshot({ projectRoot: proj, targetPath: target, history, onEntry: (s) => stages.push(s) })
    expect(r).toEqual({ snapshotSkipped: 'too-large', snapshotId: null })
    expect(await exists(target)).toBe(false)
    expect(history.list(proj)).toEqual([])
    expect(stages.every((s) => s === 'delete')).toBe(true)
  })

  it('상한 안이면 스냅샷을 남기고 지운다 — 복사가 먼저, 지우기가 나중에 알려진다', async () => {
    const root = await tmp('astera-rws-ok-')
    const history = new LocalHistoryStore(path.join(root, 'lh'))
    await history.load()
    const proj = path.join(root, 'proj')
    const target = path.join(proj, 't')
    await makeTree(target)
    const stages: FileOpStage[] = []
    const r = await removeWithSnapshot({ projectRoot: proj, targetPath: target, history, onEntry: (s) => stages.push(s) })
    expect(r.snapshotSkipped).toBeNull()
    expect(r.snapshotId).not.toBeNull()
    expect(await exists(target)).toBe(false)
    expect(stages[0]).toBe('snapshot')
    expect(stages.at(-1)).toBe('delete')
    expect(stages.indexOf('delete')).toBeGreaterThan(stages.lastIndexOf('snapshot'))
  })

  it('스냅샷이 실패해도 지우고 failed 로 알린다', async () => {
    const root = await tmp('astera-rws-fail-')
    const proj = path.join(root, 'proj')
    const target = path.join(proj, 'f.txt')
    await fs.mkdir(proj)
    await fs.writeFile(target, 'f')
    const history = {
      snapshot: async () => {
        throw new Error('EPERM')
      },
      discard: async () => {}
    }
    const r = await removeWithSnapshot({ projectRoot: proj, targetPath: target, history })
    expect(r).toEqual({ snapshotSkipped: 'failed', snapshotId: null })
    expect(await exists(target)).toBe(false)
  })
})
