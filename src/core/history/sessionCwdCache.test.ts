import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionCwdCache } from './sessionCwdCache'

let tmp: string
const filePath = (): string => path.join(tmp, 'session-cwd.json')

/** A session file path that is absolute **on this platform**. Hardcoding `D:\a\x.jsonl` reads as an
 *  absolute path only on win32; on POSIX path.resolve prepends the cwd and leaves the backslashes as
 *  characters, so two spellings of the same intent stopped matching and the suite went red on
 *  ubuntu/macos while passing on windows. */
const sessionPath = (...segments: string[]): string =>
  path.join(process.platform === 'win32' ? 'D:\\' : '/', ...segments)

/** The on-disk key rule, duplicated on purpose — these tests assert the stored format, so deriving the
 *  key from the module under test would make them agree with it by construction. */
const keyOf = (p: string): string => path.resolve(p).toLowerCase()

// A cwd is only ever compared for equality, never resolved, so it stays a fixed win32-looking string
const CWD_A = 'D:\\proj\\alpha'
const CWD_B = 'D:\\proj\\beta'

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cwdcache-'))
})

describe('SessionCwdCache', () => {
  it('없는 파일을 load하면 빈 캐시로 시작한다 (전부 miss)', async () => {
    const c = new SessionCwdCache(filePath())
    expect(await c.load()).toEqual({ recovered: false })
    expect(c.get(sessionPath('a', 'x.jsonl'), 1, 2)).toBeUndefined()
  })

  it('set한 값을 같은 (mtime,size)로 되찾는다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    const p = sessionPath('a', 'x.jsonl')
    c.set(p, 100, 20, CWD_A)
    expect(c.get(p, 100, 20)).toBe(CWD_A)
  })

  it('cwd가 없는 파일(null)도 히트로 기억한다 — miss(undefined)와 구분된다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    c.set(sessionPath('a', 'noise.jsonl'), 100, 20, null)
    expect(c.get(sessionPath('a', 'noise.jsonl'), 100, 20)).toBeNull()
    expect(c.get(sessionPath('a', 'other.jsonl'), 100, 20)).toBeUndefined()
  })

  it('mtime이나 size가 달라지면 miss가 된다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    const p = sessionPath('a', 'x.jsonl')
    c.set(p, 100, 20, CWD_A)
    expect(c.get(p, 101, 20)).toBeUndefined()
    expect(c.get(p, 100, 21)).toBeUndefined()
  })

  it('win32 에서는 대소문자 표기가 달라도 같은 파일로 본다', async () => {
    const c = new SessionCwdCache(filePath(), 'win32')
    await c.load()
    const p = sessionPath('A', 'X.jsonl')
    c.set(p, 100, 20, CWD_A)
    expect(c.get(p.toLowerCase(), 100, 20)).toBe(CWD_A)
  })

  it('linux 에서는 대소문자만 다른 두 파일을 따로 기억한다', async () => {
    const c = new SessionCwdCache(filePath(), 'linux')
    await c.load()
    const p = sessionPath('A', 'X.jsonl')
    c.set(p, 100, 20, CWD_A)
    expect(c.get(sessionPath('A', 'x.jsonl'), 100, 20)).toBeUndefined()
  })

  // 반대 방향: 이 빌드가 적은 소문자 파일의 행은 옛 행과 구별되지 않아 대문자 형제의 조회도 그 행을
  // 본다. 그래도 적중은 (mtimeMs, size) 가 같아야 하므로, 다른 파일이면 빗나간다. 둘 다 같은 두
  // 파일 — 밀리초 이하까지 같은 mtime 과 같은 크기, 게다가 UUID 이름이 대소문자만 다른 것 — 만 남는다.
  it('linux: 이 빌드가 적은 소문자 파일의 행은 대문자 형제의 (mtime, size) 로는 빗나간다', async () => {
    const c = new SessionCwdCache(filePath(), 'linux')
    await c.load()
    const lower = path.join(path.resolve(sessionPath('a')).toLowerCase(), 'x.jsonl')
    const upper = path.join(path.dirname(lower), 'X.jsonl')
    c.set(lower, 100, 20, CWD_A)
    expect(c.get(upper, 101, 20)).toBeUndefined()
    expect(c.get(upper, 100, 21)).toBeUndefined()
    await c.flush()
    const again = new SessionCwdCache(filePath(), 'linux')
    await again.load()
    expect(again.get(upper, 101, 20)).toBeUndefined()
    expect(again.get(lower, 100, 20)).toBe(CWD_A)
  })

  it('linux: 예전 빌드가 소문자로 적은 키도 찾고, 새로 적는 키는 원래 철자다', async () => {
    const p = sessionPath('A', 'X.jsonl')
    await fs.writeFile(filePath(), JSON.stringify({ [keyOf(p)]: [100, 20, CWD_A] }), 'utf8')
    const c = new SessionCwdCache(filePath(), 'linux')
    await c.load()
    expect(c.get(p, 100, 20)).toBe(CWD_A)
    c.set(p, 200, 30, CWD_B)
    await c.flush()
    const stored = JSON.parse(await fs.readFile(filePath(), 'utf8')) as Record<string, unknown>
    expect(stored[path.resolve(p)]).toEqual([200, 30, CWD_B])
    expect(c.get(p, 200, 30)).toBe(CWD_B)
  })

  // 구분자를 무시하는 것은 path.resolve 가 win32 에서만 주는 성질이고, 두 표기가 실제로 섞여 들어오는
  // 곳도 win32 뿐이다 — POSIX 에서 백슬래시는 파일명에 쓸 수 있는 문자다. keyOf 주석의 "win32 first" 가
  // 뜻하는 범위가 여기다.
  it.skipIf(process.platform !== 'win32')('win32에선 구분자 표기가 달라도 같은 파일로 본다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    c.set('D:\\A\\X.jsonl', 100, 20, CWD_A)
    expect(c.get('d:/a/x.jsonl', 100, 20)).toBe(CWD_A)
  })

  it('flush한 내용을 다음 인스턴스가 load로 되찾는다', async () => {
    const p = sessionPath('a', 'x.jsonl')
    const first = new SessionCwdCache(filePath())
    await first.load()
    first.set(p, 100, 20, CWD_A)
    await first.flush()

    const second = new SessionCwdCache(filePath())
    expect(await second.load()).toEqual({ recovered: false })
    expect(second.get(p, 100, 20)).toBe(CWD_A)
  })

  it('바뀐 것이 없으면 파일을 쓰지 않는다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    await c.flush()
    await expect(fs.access(filePath())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('깨진 파일은 .bak을 남기고 빈 캐시로 복구한다', async () => {
    await fs.writeFile(filePath(), '{ this is not json', 'utf8')
    const c = new SessionCwdCache(filePath())
    expect(await c.load()).toEqual({ recovered: true })
    expect(c.get(sessionPath('a', 'x.jsonl'), 100, 20)).toBeUndefined()
    expect(await fs.readFile(filePath() + '.bak', 'utf8')).toBe('{ this is not json')
  })

  it('스키마가 깨진 행 하나는 버리고 나머지는 살린다', async () => {
    const good = sessionPath('a', 'good.jsonl')
    const bad = sessionPath('a', 'bad.jsonl')
    await fs.writeFile(
      filePath(),
      JSON.stringify({ [keyOf(good)]: [100, 20, CWD_A], [keyOf(bad)]: ['nope', 20, CWD_B] }),
      'utf8'
    )
    const c = new SessionCwdCache(filePath())
    expect(await c.load()).toEqual({ recovered: false })
    expect(c.get(good, 100, 20)).toBe(CWD_A)
    expect(c.get(bad, 100, 20)).toBeUndefined()
  })

  it('상한을 넘으면 mtime이 새로운 쪽을 남긴다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    // 10_000이 상한 — 넘겨서 오래된 쪽이 잘리는지 본다
    for (let i = 0; i < 10_050; i++) c.set(sessionPath('a', `f${i}.jsonl`), i, 1, `D:\\proj\\p${i}`)
    await c.flush()

    const reloaded = new SessionCwdCache(filePath())
    await reloaded.load()
    expect(reloaded.get(sessionPath('a', 'f10049.jsonl'), 10_049, 1)).toBe('D:\\proj\\p10049')
    expect(reloaded.get(sessionPath('a', 'f0.jsonl'), 0, 1)).toBeUndefined()
  })

  // Host 가 쓰는 모드다. 파일은 앱의 것이라 두 번째 프로세스가 쓰면 앱의 flush 와 엇갈린다.
  it('읽기 전용이면 읽어서 쓰되 파일은 건드리지 않는다', async () => {
    const known = sessionPath('a', 'known.jsonl')
    const text = JSON.stringify({ [keyOf(known)]: [100, 20, CWD_A] })
    await fs.writeFile(filePath(), text, 'utf8')
    const c = new SessionCwdCache(filePath(), process.platform, { readOnly: true })
    await c.load()
    expect(c.get(known, 100, 20)).toBe(CWD_A)
    c.set(sessionPath('a', 'fresh.jsonl'), 1, 2, CWD_B)
    await c.flush()
    expect(c.get(sessionPath('a', 'fresh.jsonl'), 1, 2)).toBe(CWD_B) // 메모리에는 남는다
    expect(await fs.readFile(filePath(), 'utf8')).toBe(text)
  })

  it('읽기 전용이면 깨진 파일에 .bak 도 만들지 않는다', async () => {
    await fs.writeFile(filePath(), '{ this is not json', 'utf8')
    const c = new SessionCwdCache(filePath(), process.platform, { readOnly: true })
    expect(await c.load()).toEqual({ recovered: true })
    c.set(sessionPath('a', 'x.jsonl'), 1, 2, CWD_A)
    await c.flush()
    expect(await fs.readdir(tmp)).toEqual(['session-cwd.json'])
    expect(await fs.readFile(filePath(), 'utf8')).toBe('{ this is not json')
  })
})

// Stage 4 T3 — the same file becomes the codex rollout index: besides the cwd it keeps the row a
// project expansion shows (sessionId, title, awaitingReply), and it drops files that are gone.
describe('SessionCwdCache — rollout index', () => {
  const ROW = { sessionId: 's-1', title: '첫 질문', awaitingReply: true }

  it('setRow 한 행을 같은 (mtime,size)로 되찾고, 그 cwd 도 get 으로 보인다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    const p = sessionPath('s', 'r1.jsonl')
    c.setRow(p, 100, 20, CWD_A, ROW)
    expect(c.getRow(p, 100, 20)).toEqual({ cwd: CWD_A, ...ROW })
    expect(c.get(p, 100, 20)).toBe(CWD_A)
    expect(c.getRow(p, 101, 20)).toBeUndefined()
  })

  it('cwd 만 아는 행은 getRow 에서 miss 다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    const p = sessionPath('s', 'r1.jsonl')
    c.set(p, 100, 20, CWD_A)
    expect(c.getRow(p, 100, 20)).toBeUndefined()
  })

  it('같은 키·같은 cwd 로 set 해도 이미 있는 행을 지우지 않는다 — 파일이 바뀌면 행도 버린다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    const p = sessionPath('s', 'r1.jsonl')
    c.setRow(p, 100, 20, CWD_A, ROW)
    c.set(p, 100, 20, CWD_A)
    expect(c.getRow(p, 100, 20)).toEqual({ cwd: CWD_A, ...ROW })
    c.set(p, 200, 30, CWD_A) // appended: a new key
    expect(c.getRow(p, 200, 30)).toBeUndefined()
    expect(c.get(p, 200, 30)).toBe(CWD_A)
  })

  it('행은 flush 와 load 를 지나도 남고, 옛 3칸 행과 한 파일에 섞여도 읽힌다', async () => {
    const old = sessionPath('s', 'old.jsonl')
    const neu = sessionPath('s', 'new.jsonl')
    await fs.writeFile(filePath(), JSON.stringify({ [keyOf(old)]: [1, 2, CWD_B] }), 'utf8')
    const first = new SessionCwdCache(filePath())
    await first.load()
    first.setRow(neu, 100, 20, CWD_A, ROW)
    await first.flush()
    const second = new SessionCwdCache(filePath())
    await second.load()
    expect(second.get(old, 1, 2)).toBe(CWD_B)
    expect(second.getRow(neu, 100, 20)).toEqual({ cwd: CWD_A, ...ROW })
  })

  it('다른 판(버전)의 행 모양은 cwd 는 살리고 행은 버린다', async () => {
    const p = sessionPath('s', 'r1.jsonl')
    await fs.writeFile(filePath(), JSON.stringify({ [keyOf(p)]: [100, 20, CWD_A, 999, 's-1', 't', 1] }), 'utf8')
    const c = new SessionCwdCache(filePath())
    await c.load()
    expect(c.get(p, 100, 20)).toBe(CWD_A)
    expect(c.getRow(p, 100, 20)).toBeUndefined()
  })

  it('prune 은 그 뿌리 아래에서 목록에 없는 파일만 지우고, 다른 뿌리는 건드리지 않는다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    const root = sessionPath('acc1', 'sessions')
    const kept = path.join(root, '2026', '09', '01', 'a.jsonl')
    const gone = path.join(root, '2026', '09', '01', 'b.jsonl')
    const other = sessionPath('acc2', 'sessions', '2026', '09', '01', 'c.jsonl')
    c.set(kept, 1, 1, CWD_A)
    c.setRow(gone, 1, 1, CWD_A, ROW)
    c.set(other, 1, 1, CWD_B)
    await c.flush()
    expect(c.prune(root, [kept])).toBe(1)
    expect(c.get(kept, 1, 1)).toBe(CWD_A)
    expect(c.get(gone, 1, 1)).toBeUndefined()
    expect(c.get(other, 1, 1)).toBe(CWD_B)
    // A prune is a change: it reaches the file
    await c.flush()
    const again = new SessionCwdCache(filePath())
    await again.load()
    expect(again.get(gone, 1, 1)).toBeUndefined()
    expect(again.get(kept, 1, 1)).toBe(CWD_A)
  })

  it('prune 은 이름이 뿌리로 시작할 뿐인 형제 폴더를 뿌리 아래로 보지 않는다', async () => {
    const c = new SessionCwdCache(filePath())
    await c.load()
    const root = sessionPath('acc1', 'sessions')
    const sibling = sessionPath('acc1', 'sessions-old', 'x.jsonl')
    c.set(sibling, 1, 1, CWD_A)
    expect(c.prune(root, [])).toBe(0)
    expect(c.get(sibling, 1, 1)).toBe(CWD_A)
  })
})

// Review follow-up: the file is rewritten whole while a codex session runs, the Host reads it from
// another process, and several listings can flush at once. A torn or interleaved write is invalid JSON,
// which load() answers by dropping the whole cache — a full rescan.
describe('SessionCwdCache — writing the file', () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('창 안에 몰린 flush 는 한 번만 쓰고, 그 한 번에 JSON.stringify 도 한 번이다', async () => {
    const c = new SessionCwdCache(filePath(), process.platform, { flushDelayMs: 40 })
    await c.load()
    const write = vi.spyOn(fs, 'writeFile')
    const stringify = vi.spyOn(JSON, 'stringify')
    c.set(sessionPath('a', '1.jsonl'), 1, 1, CWD_A)
    const first = c.flush()
    c.set(sessionPath('a', '2.jsonl'), 1, 1, CWD_B)
    const second = c.flush()
    await Promise.all([first, second])
    expect(write).toHaveBeenCalledTimes(1)
    expect(stringify).toHaveBeenCalledTimes(1)
    const again = new SessionCwdCache(filePath())
    await again.load()
    expect(again.get(sessionPath('a', '2.jsonl'), 1, 1)).toBe(CWD_B)
  })

  it('임시 파일에 쓰고 이름을 바꾼다 — 대상 파일에 직접 쓰지 않고, 임시 파일도 남기지 않는다', async () => {
    const c = new SessionCwdCache(filePath(), process.platform, { flushDelayMs: 0 })
    await c.load()
    const write = vi.spyOn(fs, 'writeFile')
    const rename = vi.spyOn(fs, 'rename')
    c.set(sessionPath('a', '1.jsonl'), 1, 1, CWD_A)
    await c.flush()
    expect(write).toHaveBeenCalledTimes(1)
    expect(String(write.mock.calls[0][0])).not.toBe(filePath())
    expect(rename).toHaveBeenCalledWith(write.mock.calls[0][0], filePath())
    expect(await fs.readdir(tmp)).toEqual(['session-cwd.json'])
  })

  it('쓰기는 한 번에 하나뿐이고, 나중 것이 이긴다', async () => {
    const c = new SessionCwdCache(filePath(), process.platform, { flushDelayMs: 0 })
    await c.load()
    const real = fs.writeFile.bind(fs)
    let active = 0
    let maxActive = 0
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      active++
      maxActive = Math.max(maxActive, active)
      await sleep(60)
      try {
        return await real(...args)
      } finally {
        active--
      }
    })
    c.set(sessionPath('a', '1.jsonl'), 1, 1, CWD_A)
    const first = c.flush()
    await sleep(20) // the first write is in flight
    c.set(sessionPath('a', '1.jsonl'), 2, 2, CWD_B)
    const second = c.flush()
    await Promise.all([first, second])
    expect(maxActive).toBe(1)
    const again = new SessionCwdCache(filePath())
    await again.load()
    expect(again.get(sessionPath('a', '1.jsonl'), 2, 2)).toBe(CWD_B)
  })

  it('쓰기가 실패하면 다음 flush 가 다시 쓴다', async () => {
    const c = new SessionCwdCache(filePath(), process.platform, { flushDelayMs: 0 })
    await c.load()
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EPERM' }))
    c.set(sessionPath('a', '1.jsonl'), 1, 1, CWD_A)
    await c.flush()
    await expect(fs.access(filePath())).rejects.toMatchObject({ code: 'ENOENT' })
    await c.flush()
    const again = new SessionCwdCache(filePath())
    await again.load()
    expect(again.get(sessionPath('a', '1.jsonl'), 1, 1)).toBe(CWD_A)
    expect(await fs.readdir(tmp)).toEqual(['session-cwd.json'])
  })

  it('상한을 넘은 오래된 항목은 파일에서만 빠지고 메모리에는 남는다 — 같은 실행 안에서 다시 읽지 않는다', async () => {
    const c = new SessionCwdCache(filePath(), process.platform, { flushDelayMs: 0 })
    await c.load()
    for (let i = 0; i < 10_050; i++) c.set(sessionPath('a', `f${i}.jsonl`), i, 1, `D:\\proj\\p${i}`)
    await c.flush()
    expect(c.get(sessionPath('a', 'f0.jsonl'), 0, 1)).toBe('D:\\proj\\p0')
    const reloaded = new SessionCwdCache(filePath())
    await reloaded.load()
    expect(reloaded.get(sessionPath('a', 'f0.jsonl'), 0, 1)).toBeUndefined()
    expect(reloaded.get(sessionPath('a', 'f10049.jsonl'), 10_049, 1)).toBe('D:\\proj\\p10049')
  })
})
