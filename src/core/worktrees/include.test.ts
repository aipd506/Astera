import { describe, it, expect, vi, afterEach } from 'vitest'
import type { TestContext } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { parseWorktreeInclude, copyWorktreeInclude, collapseIncludeEntries, dirSize, measureTree, linkTargetFor, type MakeLink } from './include'
import { makeRepo, tempDir } from './testRepo'
import { createProbePool, createProber, ProbeBudget, rootOf } from '../sessions/pathProbe'

/** symlink 생성 실패가 권한 문제(EPERM/EACCES)면 실패가 아니라 스킵으로 처리한다(리뷰 Finding 5) —
 *  Windows는 보통 관리자 권한/Developer Mode가 있어야 symlink를 만들 수 있고, 그게 없는 CI나
 *  다른 개발자 머신에서는 "진짜 결함"이 아니라 "환경 제약"이라 실패로 취급하면 안 된다. */
async function trySymlink(
  ctx: TestContext,
  target: string,
  linkPath: string,
  type: 'file' | 'dir'
): Promise<void> {
  try {
    await fs.symlink(target, linkPath, type)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') {
      ctx.skip(`symlink 생성 권한 없음(${code}) — 이 환경은 관리자 권한/Developer Mode가 없습니다`)
    }
    throw err
  }
}

describe('parseWorktreeInclude', () => {
  it('주석·빈 줄 무시, 리터럴만 통과', () => {
    const r = parseWorktreeInclude('# c\n\n.env\nconfig/local.json\n')
    expect(r.entries).toEqual(['.env', 'config/local.json'])
    expect(r.warnings).toEqual([])
  })
  it('glob·부정·절대경로·..·.git은 경고 후 스킵', () => {
    const r = parseWorktreeInclude('*.env\n!x\n/abs\nC:\\abs\n../up\n.git/config\nok.txt\n')
    expect(r.entries).toEqual(['ok.txt'])
    // 5개 카테고리(glob·부정·절대경로·..·.git)지만 절대경로 예시가 2줄(/abs, C:\abs)이라 경고는 6개
    expect(r.warnings.length).toBe(6)
    expect(r.warnings[0]).toEqual({ key: 'worktree.include.globUnsupported', params: { line: '*.env' } })
    expect(r.warnings[2]).toEqual({ key: 'worktree.include.absolutePath', params: { line: '/abs' } })
  })
  it('1000줄 초과분은 경고 후 무시', () => {
    const content = Array.from({ length: 1001 }, (_, i) => `f${i}.txt`).join('\n')
    const r = parseWorktreeInclude(content)
    expect(r.entries.length).toBe(1000)
    expect(r.warnings).toEqual([{ key: 'worktree.include.tooManyEntries', params: { max: 1000 } }])
  })
  it('선행 . 세그먼트로 .git 가드를 우회할 수 없다 (리뷰 Finding 2)', () => {
    // segs[0]만 보면 './.git/config'는 세그먼트가 ['.', '.git', 'config']라 통과해버린다
    const r = parseWorktreeInclude('./.git/config\n')
    expect(r.entries).toEqual([])
    expect(r.warnings).toEqual([{ key: 'worktree.include.gitDir', params: { line: './.git/config' } }])
  })
})

describe('copyWorktreeInclude', () => {
  it('존재+gitignored 항목만 복사, tracked·미존재는 경고 스킵', async () => {
    const repo = await makeRepo('astera-wt-inc-')
    await fs.writeFile(path.join(repo, '.gitignore'), '.env\nsecrets/\n', 'utf8')
    await fs.writeFile(path.join(repo, '.env'), 'KEY=1', 'utf8')
    await fs.mkdir(path.join(repo, 'secrets'))
    await fs.writeFile(path.join(repo, 'secrets', 's.txt'), 's', 'utf8')
    // f.txt는 tracked(makeRepo가 커밋) — 복사 대상 아님
    await fs.writeFile(
      path.join(repo, '.worktreeinclude'),
      '.env\nsecrets\nf.txt\nno-such.txt\n',
      'utf8'
    )
    execFileSync('git', ['add', '.gitignore', '.worktreeinclude'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'inc'], { cwd: repo, windowsHide: true })
    const wt = await tempDir('astera-wt-dest-')
    const warnings = await copyWorktreeInclude(repo, wt)
    expect(await fs.readFile(path.join(wt, '.env'), 'utf8')).toBe('KEY=1')
    expect(await fs.readFile(path.join(wt, 'secrets', 's.txt'), 'utf8')).toBe('s')
    await expect(fs.stat(path.join(wt, 'f.txt'))).rejects.toThrow() // tracked → 미복사
    // f.txt(ignored 아님) + no-such.txt(미존재)
    expect(warnings).toEqual([
      { key: 'worktree.include.notIgnored', params: { entry: 'f.txt' } },
      { key: 'worktree.include.missing', params: { entry: 'no-such.txt' } }
    ])
  })

  it('.worktreeinclude 자체가 없으면 무동작·경고 없음', async () => {
    const repo = await makeRepo('astera-wt-inc2-')
    const wt = await tempDir('astera-wt-dest2-')
    expect(await copyWorktreeInclude(repo, wt)).toEqual([])
  })

  it('한 항목의 복사 실패는 throw하지 않고, 이후 항목은 계속 복사된다 (리뷰 Finding 1)', async () => {
    const repo = await makeRepo('astera-wt-inc3-')
    await fs.writeFile(path.join(repo, '.gitignore'), 'a/\nok2.txt\n', 'utf8')
    await fs.mkdir(path.join(repo, 'a', 'b'), { recursive: true })
    await fs.writeFile(path.join(repo, 'a', 'b', 'c.txt'), 'x', 'utf8')
    await fs.writeFile(path.join(repo, 'ok2.txt'), 'y', 'utf8')
    await fs.writeFile(
      path.join(repo, '.worktreeinclude'),
      'a/b/c.txt\nok2.txt\n', // a/b/c.txt가 먼저 — mkdir 충돌로 실패해도 ok2.txt는 계속 진행돼야 함
      'utf8'
    )
    execFileSync('git', ['add', '.gitignore', '.worktreeinclude'], { cwd: repo, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'inc3'], { cwd: repo, windowsHide: true })
    const wt = await tempDir('astera-wt-dest3-')
    // 목적지에 'a'를 파일로 미리 만들어 fs.mkdir(recursive)가 ENOTDIR로 충돌하게 강제
    await fs.writeFile(path.join(wt, 'a'), 'blocker', 'utf8')
    const warnings = await copyWorktreeInclude(repo, wt) // throw 없이 resolve되어야 함
    expect(warnings.some((w) => w.key === 'worktree.include.copyFailed')).toBe(true)
    expect(await fs.readFile(path.join(wt, 'ok2.txt'), 'utf8')).toBe('y') // 이후 항목은 정상 복사
  })
})


// 링크는 따라가지 않는다 — 링크로 다시 만든다(0 바이트). pnpm 의 node_modules 는 링크 나무이고,
// 따라가면 같은 패키지를 수없이 다시 셌다. 링크를 빼 버리면 .pnpm 만 복사되고 패키지 링크가 없는,
// 설치된 것처럼 보이는 부서진 node_modules 가 남는다.
describe('dirSize', () => {
  it('파일 링크는 따라가지 않고 0 바이트로 센다 — 복사에서도 링크로 다시 만든다', async (ctx) => {
    const dir = await tempDir('astera-wt-dirsize-')
    await fs.writeFile(path.join(dir, 'real.txt'), 'x'.repeat(1000), 'utf8')
    await trySymlink(ctx, path.join(dir, 'real.txt'), path.join(dir, 'link.txt'), 'file')
    expect(await dirSize(dir)).toBe(1000)
  })

  it(
    '디렉토리 symlink 순환은 무한 재귀 없이 settle하고 실파일 크기만 센다 (리뷰 Finding 4)',
    async (ctx) => {
      const dir = await tempDir('astera-wt-dirsize-cycle-')
      await fs.writeFile(path.join(dir, 'real.txt'), 'x'.repeat(500), 'utf8')
      await fs.mkdir(path.join(dir, 'sub'))
      await trySymlink(ctx, dir, path.join(dir, 'sub', 'back'), 'dir')
      expect(await dirSize(dir)).toBe(500)
    },
    2000
  )
})

describe('measureTree — 묶인 크기 재기', () => {
  it('링크된 폴더(정션)는 따라가지 않고, 링크로 적어 두며, 세지 않는다', async () => {
    const dir = await tempDir('astera-wt-walk-link-')
    const outside = await tempDir('astera-wt-walk-outside-')
    await fs.writeFile(path.join(outside, 'big.bin'), 'x'.repeat(5000), 'utf8')
    await fs.writeFile(path.join(dir, 'real.txt'), 'x'.repeat(100), 'utf8')
    // 정션은 Windows 에서 권한 없이 만들어지고, 다른 OS 에서는 'junction' 이 무시되어 폴더 링크가 된다
    await fs.symlink(outside, path.join(dir, 'linked'), 'junction')
    const plan = await measureTree(dir)
    expect(plan.bytes).toBe(100)
    expect(plan.files.map((f) => f.rel)).toEqual(['real.txt'])
    expect(plan.links.map((l) => ({ rel: l.rel, isDir: l.isDir }))).toEqual([{ rel: 'linked', isDir: true }])
    expect(plan.over).toBe(false)
  })

  it('상한을 넘으면 그 자리에서 세기를 멈춘다 — 나머지 파일은 보지 않는다', async () => {
    const dir = await tempDir('astera-wt-walk-cap-')
    for (let i = 0; i < 40; i++) await fs.writeFile(path.join(dir, `f${i}.txt`), 'x'.repeat(100), 'utf8')
    const plan = await measureTree(dir, { limit: 250 })
    expect(plan.over).toBe(true)
    expect(plan.files.length).toBe(3) // 100, 200, 300 에서 멈춘다
    expect(plan.bytes).toBe(300)
  })

  it('항목 수 상한을 넘어도 멈춘다 — 빈 파일 수십만 개도 끝없이 세지 않는다', async () => {
    const dir = await tempDir('astera-wt-walk-count-')
    for (let i = 0; i < 40; i++) await fs.writeFile(path.join(dir, `e${i}.txt`), '', 'utf8')
    const plan = await measureTree(dir, { maxEntries: 5 })
    expect(plan.over).toBe(true)
    expect(plan.overEntries).toBe(true)
    expect(plan.files.length).toBeLessThanOrEqual(5)
  })

  it('중단 신호가 오면 WORKTREE_CANCELLED 로 멈춘다', async () => {
    const dir = await tempDir('astera-wt-walk-abort-')
    await fs.writeFile(path.join(dir, 'a.txt'), 'a', 'utf8')
    const ac = new AbortController()
    ac.abort()
    await expect(measureTree(dir, { signal: ac.signal })).rejects.toThrow(/WORKTREE_CANCELLED/)
  })
})

/** 한 저장소에 .worktreeinclude 로 `entries` 를 싣고 gitignore 한다. */
async function includeRepo(prefix: string, ignore: string[], entries: string[]): Promise<string> {
  const repo = await makeRepo(prefix)
  await fs.writeFile(path.join(repo, '.gitignore'), ignore.join('\n') + '\n', 'utf8')
  await fs.writeFile(path.join(repo, '.worktreeinclude'), entries.join('\n') + '\n', 'utf8')
  execFileSync('git', ['add', '.gitignore', '.worktreeinclude'], { cwd: repo, windowsHide: true })
  execFileSync('git', ['commit', '-m', 'inc'], { cwd: repo, windowsHide: true })
  return repo
}

describe('copyWorktreeInclude — 링크를 링크로', () => {
  it('pnpm 모양의 node_modules: 위쪽 패키지 링크와 .pnpm 안쪽 링크가 모두 복사본 안에서 풀린다', async () => {
    const repo = await includeRepo('astera-wt-inc-pnpm-', ['node_modules/'], ['node_modules'])
    const nm = path.join(repo, 'node_modules')
    const fooPkg = path.join(nm, '.pnpm', 'foo@1.0.0', 'node_modules', 'foo')
    const barPkg = path.join(nm, '.pnpm', 'bar@1.0.0', 'node_modules', 'bar')
    await fs.mkdir(fooPkg, { recursive: true })
    await fs.mkdir(barPkg, { recursive: true })
    await fs.writeFile(path.join(fooPkg, 'index.js'), 'foo', 'utf8')
    await fs.writeFile(path.join(barPkg, 'index.js'), 'bar', 'utf8')
    // .pnpm/foo@1.0.0/node_modules/bar → 형제 패키지 (pnpm 은 상대 링크, Windows 에서는 정션)
    await fs.symlink(path.join('..', '..', 'bar@1.0.0', 'node_modules', 'bar'), path.join(nm, '.pnpm', 'foo@1.0.0', 'node_modules', 'bar'), 'junction')
    // node_modules/foo → .pnpm 안의 실제 패키지
    await fs.symlink(path.join('.pnpm', 'foo@1.0.0', 'node_modules', 'foo'), path.join(nm, 'foo'), 'junction')

    const wt = await tempDir('astera-wt-inc-pnpm-dest-')
    const warnings = await copyWorktreeInclude(repo, wt)
    expect(warnings).toEqual([])
    const wnm = path.join(wt, 'node_modules')
    expect(await fs.readFile(path.join(wnm, 'foo', 'index.js'), 'utf8')).toBe('foo')
    expect(await fs.readFile(path.join(wnm, '.pnpm', 'foo@1.0.0', 'node_modules', 'bar', 'index.js'), 'utf8')).toBe('bar')
    // 링크로 남고, 원본이 아니라 복사본 안을 가리킨다
    expect((await fs.lstat(path.join(wnm, 'foo'))).isSymbolicLink()).toBe(true)
    const real = await fs.realpath(path.join(wnm, 'foo'))
    expect(real.toLowerCase().startsWith((await fs.realpath(wt)).toLowerCase())).toBe(true)
    const realBar = await fs.realpath(path.join(wnm, '.pnpm', 'foo@1.0.0', 'node_modules', 'bar'))
    expect(realBar.toLowerCase().startsWith((await fs.realpath(wt)).toLowerCase())).toBe(true)
  })

  it('항목 밖을 가리키는 링크는 같은 대상을 가리킨다 — 항목 자체가 링크여도', async () => {
    const outside = await tempDir('astera-wt-inc-outside-')
    await fs.writeFile(path.join(outside, 'pkg.js'), 'p', 'utf8')
    const repo = await includeRepo('astera-wt-inc-out-', ['deps/', 'linkdir'], ['deps', 'linkdir'])
    await fs.mkdir(path.join(repo, 'deps'))
    await fs.writeFile(path.join(repo, 'deps', 'own.txt'), 'o', 'utf8')
    await fs.symlink(outside, path.join(repo, 'deps', 'pkg'), 'junction')
    await fs.symlink(outside, path.join(repo, 'linkdir'), 'junction')
    const wt = await tempDir('astera-wt-inc-out-dest-')
    expect(await copyWorktreeInclude(repo, wt)).toEqual([])
    expect(await fs.readFile(path.join(wt, 'deps', 'own.txt'), 'utf8')).toBe('o')
    expect(await fs.realpath(path.join(wt, 'deps', 'pkg'))).toBe(await fs.realpath(outside))
    expect(await fs.realpath(path.join(wt, 'linkdir'))).toBe(await fs.realpath(outside))
    expect((await fs.lstat(path.join(wt, 'linkdir'))).isSymbolicLink()).toBe(true)
  })

  it('링크를 다시 만들지 못하면 그 항목 전체를 건너뛰고 경고한다 — 반쪽 복사를 남기지 않는다', async () => {
    const repo = await includeRepo('astera-wt-inc-linkfail-', ['deps/', 'ok.txt'], ['deps', 'ok.txt'])
    await fs.mkdir(path.join(repo, 'deps', 'real'), { recursive: true })
    await fs.writeFile(path.join(repo, 'deps', 'real', 'a.txt'), 'a', 'utf8')
    await fs.symlink(path.join(repo, 'deps', 'real'), path.join(repo, 'deps', 'alias'), 'junction')
    await fs.writeFile(path.join(repo, 'ok.txt'), 'k', 'utf8')
    const wt = await tempDir('astera-wt-inc-linkfail-dest-')
    const warnings = await copyWorktreeInclude(repo, wt, {
      makeLink: async () => {
        throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' })
      }
    })
    expect(warnings).toEqual([
      { key: 'worktree.include.linkFailed', params: { entry: 'deps', detail: 'EACCES: denied' } }
    ])
    await expect(fs.lstat(path.join(wt, 'deps'))).rejects.toThrow() // 반쪽 복사가 남지 않는다
    expect(await fs.readFile(path.join(wt, 'ok.txt'), 'utf8')).toBe('k') // 다른 항목은 그대로
  })

  it('파일 링크를 만들 권한이 없으면(EPERM) 그 파일을 복사한다', async () => {
    const repo = await includeRepo('astera-wt-inc-eperm-', ['cfg/'], ['cfg'])
    await fs.mkdir(path.join(repo, 'cfg'))
    await fs.writeFile(path.join(repo, 'cfg', 'base.env'), 'B=1', 'utf8')
    // 링크의 모양만 있으면 된다: 실제로 만들 수 없는 환경이면 이 테스트의 전제를 흉내 낸다
    try {
      await fs.symlink('base.env', path.join(repo, 'cfg', 'local.env'), 'file')
    } catch {
      return // 이 머신에서 파일 링크를 만들 수 없으면 원본 픽스처도 못 만든다 — 뒤의 경로는 위 테스트들이 덮는다
    }
    const wt = await tempDir('astera-wt-inc-eperm-dest-')
    const asked: string[] = []
    const warnings = await copyWorktreeInclude(repo, wt, {
      makeLink: async (_t, _p, type) => {
        asked.push(type)
        if (type === 'file') throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      }
    })
    expect(warnings).toEqual([])
    expect(asked).toEqual(['file']) // 링크를 먼저 청했고, 권한이 없어 복사로 물러섰다
    const st = await fs.lstat(path.join(wt, 'cfg', 'local.env'))
    expect(st.isSymbolicLink()).toBe(false)
    expect(await fs.readFile(path.join(wt, 'cfg', 'local.env'), 'utf8')).toBe('B=1')
  })

  it('복사 진행을 바이트와 파일 수로 알린다 — 마지막 알림은 총량과 같다', async () => {
    const outside = await tempDir('astera-wt-inc-prog-out-')
    const repo = await includeRepo('astera-wt-inc-prog-', ['deps/'], ['deps'])
    await fs.mkdir(path.join(repo, 'deps'))
    await fs.writeFile(path.join(repo, 'deps', 'own.txt'), 'o', 'utf8')
    await fs.symlink(outside, path.join(repo, 'deps', 'pkg'), 'junction')
    const wt = await tempDir('astera-wt-inc-prog-dest-')
    const seen: Array<Record<string, number | undefined>> = []
    await copyWorktreeInclude(repo, wt, { onProgress: (p) => seen.push({ ...p }) })
    expect(seen[0]).toEqual({}) // 재는 중 — 아직 수가 없다
    expect(seen[seen.length - 1]).toEqual({ bytesCopied: 1, bytesTotal: 1, filesCopied: 1, filesTotal: 1 })
  })
})

// 재검토: 다시 만든 링크를 통해 쓰지 않는다. `a` 가 밖을 가리키는 링크로 다시 만들어진 뒤 `a/x/y`
// 항목이 worktree/a/x/y 에 쓰면, 그 쓰기는 링크를 타고 워크트리 밖 — 대개 원본 자체 — 에 닿는다.
describe('copyWorktreeInclude — 링크를 통해 쓰지 않는다', () => {
  /** 폴더 안 파일의 내용과 mtime — 건드려졌는지 비교한다 */
  const snapshot = async (dir: string): Promise<Record<string, string>> => {
    const out: Record<string, string> = {}
    const walk = async (d: string): Promise<void> => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) await walk(p)
        else if (e.isFile()) out[path.relative(dir, p)] = `${await fs.readFile(p, 'utf8')}@${(await fs.stat(p)).mtimeMs}`
      }
    }
    await walk(dir)
    return out
  }

  it('밖을 가리키는 링크 a 와 그 아래 항목 a/x/y 가 함께 있어도 워크트리 밖에 쓰지 않는다 — 원본이 그대로다', async () => {
    const outside = await tempDir('astera-wt-inc-nest-out-')
    await fs.mkdir(path.join(outside, 'x'))
    // 4MB 를 넘겨 스트림 복사('w' 로 연다)를 타게 한다 — 원본을 비워 버리는 경로다
    await fs.writeFile(path.join(outside, 'x', 'y'), 'S'.repeat(5 * 1024 * 1024), 'utf8')
    const repo = await includeRepo('astera-wt-inc-nest-', ['a'], ['a', 'a/x/y'])
    await fs.symlink(outside, path.join(repo, 'a'), 'junction')
    const before = await snapshot(outside)
    const wt = await tempDir('astera-wt-inc-nest-dest-')
    await copyWorktreeInclude(repo, wt)
    expect(await snapshot(outside)).toEqual(before)
    expect((await fs.lstat(path.join(wt, 'a'))).isSymbolicLink()).toBe(true)
  })

  it('항목의 목적지 경로에 이미 링크가 있으면(체크아웃이 만든 것 등) 그 항목을 건너뛰고 경고한다', async () => {
    const outside = await tempDir('astera-wt-inc-dlink-out-')
    const repo = await includeRepo('astera-wt-inc-dlink-', ['a/'], ['a/x.txt'])
    await fs.mkdir(path.join(repo, 'a'))
    await fs.writeFile(path.join(repo, 'a', 'x.txt'), 'x', 'utf8')
    const wt = await tempDir('astera-wt-inc-dlink-dest-')
    await fs.symlink(outside, path.join(wt, 'a'), 'junction')
    const warnings = await copyWorktreeInclude(repo, wt)
    expect(warnings).toEqual([{ key: 'worktree.include.unsafeDest', params: { entry: 'a/x.txt', path: 'a' } }])
    expect(await fs.readdir(outside)).toEqual([])
  })

  it('.. 를 가리키는 링크 하나는 링크로 남고, 그것을 통해서는 아무것도 쓰지 않는다', async () => {
    const repo = await includeRepo('astera-wt-inc-up-', ['deps/', 'big.bin'], ['deps', 'deps/up/big.bin'])
    await fs.mkdir(path.join(repo, 'deps'))
    await fs.writeFile(path.join(repo, 'deps', 'own.txt'), 'o', 'utf8')
    await fs.symlink('..', path.join(repo, 'deps', 'up'), 'junction')
    await fs.writeFile(path.join(repo, 'big.bin'), 'B'.repeat(5 * 1024 * 1024), 'utf8') // 스트림 복사 크기
    const before = await snapshot(repo).then((s) => Object.keys(s).filter((k) => !k.startsWith('.git')).sort())
    const beforeBig = (await fs.stat(path.join(repo, 'big.bin'))).mtimeMs
    const wt = await tempDir('astera-wt-inc-up-dest-')
    await copyWorktreeInclude(repo, wt)
    expect((await fs.lstat(path.join(wt, 'deps', 'up'))).isSymbolicLink()).toBe(true)
    // 저장소 안(여기서는 저장소 뿌리)을 가리키던 폴더 링크는 워크트리 안의 같은 자리로 옮겨진다(최종 리뷰 C1)
    expect(await fs.realpath(path.join(wt, 'deps', 'up'))).toBe(await fs.realpath(wt))
    const after = await snapshot(repo).then((s) => Object.keys(s).filter((k) => !k.startsWith('.git')).sort())
    expect(after).toEqual(before)
    expect((await fs.stat(path.join(repo, 'big.bin'))).mtimeMs).toBe(beforeBig)
    expect(await fs.readFile(path.join(repo, 'big.bin'), 'utf8')).toBe('B'.repeat(5 * 1024 * 1024))
  })
})

describe('collapseIncludeEntries', () => {
  it('상위 항목이 있으면 그 아래 항목은 뺀다 — 겹치는 항목이 같은 자리에 두 번 쓰지 않는다', () => {
    expect(collapseIncludeEntries(['a/x/y', 'a', 'b', 'ab', 'a/z', 'b'], 'linux')).toEqual(['a', 'b', 'ab'])
    expect(collapseIncludeEntries(['A/x', 'a'], 'win32')).toEqual(['a'])
    expect(collapseIncludeEntries(['A/x', 'a'], 'linux')).toEqual(['A/x', 'a'])
  })
})

// 재검토 2: 항목 뿌리만 보면 모자란다. 체크아웃이 gitignore 된 진짜 폴더 a 아래에 추적되는 링크
// a/lib 를 두었으면, a 를 복사하면서 a/lib 아래 폴더를 만들고 파일을 쓰는 일이 그 링크를 타고
// 밖으로 나간다. 모든 목적지 폴더와 파일의 부모를 뿌리부터 따라 내려가며 확인한다.
describe('copyWorktreeInclude — 깊은 자리의 링크', () => {
  it('항목 아래 깊은 자리에 링크가 있으면 그 아래만 건너뛰고, 밖의 내용·mtime 은 그대로다', async () => {
    const outside = await tempDir('astera-wt-inc-deep-out-')
    await fs.writeFile(path.join(outside, 'keep.txt'), 'K', 'utf8')
    const before = { list: await fs.readdir(outside), mtime: (await fs.stat(path.join(outside, 'keep.txt'))).mtimeMs }
    const repo = await includeRepo('astera-wt-inc-deep-', ['a/'], ['a'])
    await fs.mkdir(path.join(repo, 'a', 'lib', 'sub'), { recursive: true })
    await fs.writeFile(path.join(repo, 'a', 'top.txt'), 't', 'utf8')
    await fs.writeFile(path.join(repo, 'a', 'lib', 'big.bin'), 'B'.repeat(5 * 1024 * 1024), 'utf8')
    await fs.writeFile(path.join(repo, 'a', 'lib', 'sub', 's.txt'), 's', 'utf8')
    const wt = await tempDir('astera-wt-inc-deep-dest-')
    // 체크아웃이 둔 것처럼: 진짜 폴더 a 와, 그 안에서 밖을 가리키는 링크 a/lib
    await fs.mkdir(path.join(wt, 'a'))
    await fs.symlink(outside, path.join(wt, 'a', 'lib'), 'junction')
    const seen: Array<Record<string, number | undefined>> = []
    const warnings = await copyWorktreeInclude(repo, wt, { onProgress: (p) => seen.push({ ...p }) })
    expect(warnings).toEqual([
      { key: 'worktree.include.unsafeDest', params: { entry: 'a', path: 'a/lib' } }
    ])
    expect(await fs.readdir(outside)).toEqual(before.list)
    expect((await fs.stat(path.join(outside, 'keep.txt'))).mtimeMs).toBe(before.mtime)
    expect(await fs.readFile(path.join(wt, 'a', 'top.txt'), 'utf8')).toBe('t') // 나머지는 복사된다
    expect((await fs.lstat(path.join(wt, 'a', 'lib'))).isSymbolicLink()).toBe(true) // 체크아웃의 링크는 그대로
    expect(seen[seen.length - 1]).toEqual({ bytesCopied: 1, bytesTotal: 1, filesCopied: 1, filesTotal: 1 })
  })

  it('목적지 파일 자체가 링크면 그 파일만 건너뛴다 — 링크를 따라 쓰지 않는다', async () => {
    const outside = await tempDir('astera-wt-inc-flink-out-')
    await fs.writeFile(path.join(outside, 'target.txt'), 'ORIGINAL', 'utf8')
    const repo = await includeRepo('astera-wt-inc-flink-', ['a/'], ['a'])
    await fs.mkdir(path.join(repo, 'a'))
    await fs.writeFile(path.join(repo, 'a', 'cfg.txt'), 'NEW', 'utf8')
    await fs.writeFile(path.join(repo, 'a', 'other.txt'), 'o', 'utf8')
    const wt = await tempDir('astera-wt-inc-flink-dest-')
    await fs.mkdir(path.join(wt, 'a'))
    try {
      await fs.symlink(path.join(outside, 'target.txt'), path.join(wt, 'a', 'cfg.txt'), 'file')
    } catch {
      return // 파일 링크를 만들 수 없는 환경 — 전제를 세울 수 없다
    }
    const warnings = await copyWorktreeInclude(repo, wt)
    expect(warnings).toEqual([
      { key: 'worktree.include.unsafeDest', params: { entry: 'a', path: 'a/cfg.txt' } }
    ])
    expect(await fs.readFile(path.join(outside, 'target.txt'), 'utf8')).toBe('ORIGINAL')
    expect(await fs.readFile(path.join(wt, 'a', 'other.txt'), 'utf8')).toBe('o')
  })
})

// Stage 2 final review, C1. Git for Windows' `worktree remove` deletes through a junction into the folder
// it points at, so the copy never makes a junction whose target is outside the worktree. A folder link
// into the source repository points at the same place in the worktree; one outside both is a directory
// symlink, skipped with a warning when that cannot be made, never a junction.
describe('linkTargetFor — where a folder link may be a junction', () => {
  const base = {
    srcRoot: 'C:\\r\\nm', srcRootReal: 'C:\\r\\nm', destRoot: 'C:\\w\\nm',
    repoRoot: 'C:\\r', repoRootReal: 'C:\\r', worktreeRoot: 'C:\\w', platform: 'win32' as const
  }
  it.runIf(process.platform === 'win32')('a folder link outside both the repository and the worktree is a directory symlink, not a junction', () => {
    expect(linkTargetFor({ ...base, linkAbs: 'C:\\r\\nm\\pkg', raw: 'D:\\shared\\pkg', isDir: true })).toEqual({
      target: 'D:\\shared\\pkg', type: 'dir', place: 'outside'
    })
    // the entry itself being a link changes nothing
    expect(linkTargetFor({ ...base, linkAbs: 'C:\\r\\nm', raw: 'D:\\venv', isDir: true }).type).toBe('dir')
  })
  it.runIf(process.platform === 'win32')('a folder link into the repository points at the same place in the worktree', () => {
    expect(linkTargetFor({ ...base, linkAbs: 'C:\\r\\nm\\@x\\pkg', raw: 'C:\\r\\packages\\pkg', isDir: true })).toEqual({
      target: 'C:\\w\\packages\\pkg', type: 'junction', place: 'repo'
    })
  })
})

describe('copyWorktreeInclude — no junction to outside the worktree', () => {
  /** Makes the link for real, and records the type every call asked for. */
  const recording = (asked: Array<{ type: string; path: string }>, refuseDir = false): MakeLink =>
    async (t, p, type) => {
      asked.push({ type, path: p })
      if (refuseDir && type === 'dir') throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      await fs.symlink(t, p, type)
    }

  it('an outside-pointing folder link never becomes a junction, nested or the entry itself', async () => {
    const outside = await tempDir('astera-wt-inc-nojunc-out-')
    await fs.writeFile(path.join(outside, 'keep.txt'), 'k', 'utf8')
    const repo = await includeRepo('astera-wt-inc-nojunc-', ['deps/', 'venv'], ['deps', 'venv'])
    await fs.mkdir(path.join(repo, 'deps'))
    await fs.writeFile(path.join(repo, 'deps', 'own.txt'), 'o', 'utf8')
    await fs.symlink(outside, path.join(repo, 'deps', 'pkg'), 'junction')
    await fs.symlink(outside, path.join(repo, 'venv'), 'junction')
    const wt = await tempDir('astera-wt-inc-nojunc-dest-')
    const asked: Array<{ type: string; path: string }> = []
    const warnings = await copyWorktreeInclude(repo, wt, { makeLink: recording(asked) })
    expect(warnings).toEqual([])
    expect(asked.map((a) => a.type)).toEqual(['dir', 'dir'])
    expect(await fs.realpath(path.join(wt, 'deps', 'pkg'))).toBe(await fs.realpath(outside))
    expect(await fs.readFile(path.join(wt, 'deps', 'own.txt'), 'utf8')).toBe('o')
  })

  it('without the symlink privilege the outside link is skipped with a warning, never made as a junction', async () => {
    const outside = await tempDir('astera-wt-inc-noperm-out-')
    const repo = await includeRepo('astera-wt-inc-noperm-', ['deps/'], ['deps'])
    await fs.mkdir(path.join(repo, 'deps'))
    await fs.writeFile(path.join(repo, 'deps', 'own.txt'), 'o', 'utf8')
    await fs.symlink(outside, path.join(repo, 'deps', 'pkg'), 'junction')
    const wt = await tempDir('astera-wt-inc-noperm-dest-')
    const asked: Array<{ type: string; path: string }> = []
    const warnings = await copyWorktreeInclude(repo, wt, { makeLink: recording(asked, true) })
    expect(asked.map((a) => a.type)).toEqual(['dir'])
    expect(warnings).toEqual([
      {
        key: 'worktree.include.outsideLinkSkipped',
        params: { entry: 'deps', path: 'deps/pkg', detail: 'EPERM: operation not permitted' }
      }
    ])
    expect(existsSync(path.join(wt, 'deps', 'pkg'))).toBe(false)
    expect(await fs.readFile(path.join(wt, 'deps', 'own.txt'), 'utf8')).toBe('o') // the rest of the entry is copied
  })

  it('a folder link into the repository points at the worktree copy of that place', async () => {
    // A pnpm workspace: node_modules/@x/pkg leads to <repo>/packages/pkg. The worktree has its own
    // packages/pkg from the checkout, and the recreated link must lead there, not to the main repo's.
    const repo = await includeRepo('astera-wt-inc-ws-', ['node_modules/'], ['node_modules'])
    await fs.mkdir(path.join(repo, 'packages', 'pkg'), { recursive: true })
    await fs.writeFile(path.join(repo, 'packages', 'pkg', 'index.js'), 'main', 'utf8')
    await fs.mkdir(path.join(repo, 'node_modules', '@x'), { recursive: true })
    await fs.symlink(path.join(repo, 'packages', 'pkg'), path.join(repo, 'node_modules', '@x', 'pkg'), 'junction')
    const wt = await tempDir('astera-wt-inc-ws-dest-')
    await fs.mkdir(path.join(wt, 'packages', 'pkg'), { recursive: true })
    await fs.writeFile(path.join(wt, 'packages', 'pkg', 'index.js'), 'worktree', 'utf8')
    expect(await copyWorktreeInclude(repo, wt)).toEqual([])
    expect(await fs.realpath(path.join(wt, 'node_modules', '@x', 'pkg'))).toBe(
      await fs.realpath(path.join(wt, 'packages', 'pkg'))
    )
    expect(await fs.readFile(path.join(wt, 'node_modules', '@x', 'pkg', 'index.js'), 'utf8')).toBe('worktree')
  })

  it('a folder link into the repository whose place is not in the worktree is skipped with a warning', async () => {
    const repo = await includeRepo('astera-wt-inc-wsmiss-', ['node_modules/'], ['node_modules'])
    await fs.mkdir(path.join(repo, 'packages', 'pkg'), { recursive: true })
    await fs.mkdir(path.join(repo, 'node_modules', '@x'), { recursive: true })
    await fs.writeFile(path.join(repo, 'node_modules', 'a.txt'), 'a', 'utf8')
    await fs.symlink(path.join(repo, 'packages', 'pkg'), path.join(repo, 'node_modules', '@x', 'pkg'), 'junction')
    const wt = await tempDir('astera-wt-inc-wsmiss-dest-')
    expect(await copyWorktreeInclude(repo, wt)).toEqual([
      { key: 'worktree.include.linkTargetMissing', params: { entry: 'node_modules', path: 'node_modules/@x/pkg' } }
    ])
    expect(existsSync(path.join(wt, 'node_modules', '@x', 'pkg'))).toBe(false)
    expect(await fs.readFile(path.join(wt, 'node_modules', 'a.txt'), 'utf8')).toBe('a')
  })

  it.runIf(process.platform === 'win32')('a link into the repository whose worktree place leads outside through a link is not made a junction', async () => {
    const outside = await tempDir('astera-wt-inc-esc-out-')
    await fs.mkdir(path.join(outside, 'pkg'))
    const repo = await includeRepo('astera-wt-inc-esc-', ['node_modules/'], ['node_modules'])
    await fs.mkdir(path.join(repo, 'packages', 'pkg'), { recursive: true })
    await fs.mkdir(path.join(repo, 'node_modules'))
    await fs.symlink(path.join(repo, 'packages', 'pkg'), path.join(repo, 'node_modules', 'pkg'), 'junction')
    const wt = await tempDir('astera-wt-inc-esc-dest-')
    await fs.symlink(outside, path.join(wt, 'packages'), 'junction') // wt/packages leads outside
    const asked: Array<{ type: string; path: string }> = []
    await copyWorktreeInclude(repo, wt, { makeLink: recording(asked) })
    expect(asked.map((a) => a.type)).toEqual(['dir'])
  })
})

// Stage 4 T1: the walk's calls run outside the probe budget, and on a dead share each one can hold a
// libuv thread for as long as SMB takes. So the root is asked once through the budget first; one that
// does not answer, or that the budget already holds as stuck, is refused before any walk call.
describe('the include walk asks its root through the probe budget first', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('measureTree refuses a root that did not answer without reading it', async () => {
    const dir = await tempDir('astera-wt-walk-gate-')
    await fs.writeFile(path.join(dir, 'a.txt'), 'a', 'utf8')
    const readdir = vi.spyOn(fs, 'readdir')
    const asked: string[] = []
    await expect(measureTree(dir, { gate: async (p) => { asked.push(p); return 'timeout' } })).rejects.toThrow(/ROOT_UNREACHABLE/)
    expect(asked).toEqual([dir])
    expect(readdir).not.toHaveBeenCalled()
  })

  it('measureTree refuses a root the budget holds as stuck without any fs call', async () => {
    const dir = await tempDir('astera-wt-walk-stuck-')
    const budget = new ProbeBudget()
    const ticket = await budget.enter(rootOf(dir))
    if (typeof ticket === 'string') throw new Error(ticket)
    ticket.timedOut()
    const access = vi.fn(async () => {})
    const gate = createProber({ access, skipQueue: true, pool: createProbePool(2, 60_000, budget), log: () => {} })
    const readdir = vi.spyOn(fs, 'readdir')
    await expect(measureTree(dir, { gate })).rejects.toThrow(/ROOT_UNREACHABLE/)
    expect(access).not.toHaveBeenCalled()
    expect(readdir).not.toHaveBeenCalled()
  })

  it('copyWorktreeInclude says the repository is not reachable and copies nothing, reading nothing', async () => {
    const repo = await tempDir('astera-wt-inc-gate-')
    const wt = await tempDir('astera-wt-inc-gate-dest-')
    await fs.writeFile(path.join(repo, '.worktreeinclude'), '.env\n', 'utf8')
    const stat = vi.spyOn(fs, 'stat')
    const readFile = vi.spyOn(fs, 'readFile')
    const warnings = await copyWorktreeInclude(repo, wt, { gate: async () => 'timeout' })
    expect(warnings).toEqual([{ key: 'worktree.include.unreachable', params: { path: repo } }])
    expect(stat).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })
})
