import { describe, it, expect } from 'vitest'
import { flattenVisible } from '../../../core/files/selection'
import {
  buildTreeRows,
  rowOffsets,
  visibleRange,
  revealScrollTop,
  moveCursor,
  indexOfPath,
  entryPaths,
  drawnRows,
  ROW_H,
  EDIT_H,
  EDIT_REASON_H,
  OVERSCAN
} from './explorerRows'
import type { DirState } from '../hooks/useFileTree'

const ROOT = '/r'
const file = (dir: string, name: string): { name: string; path: string; isDir: boolean } => ({
  name,
  path: `${dir}/${name}`,
  isDir: false
})
const folder = (dir: string, name: string): { name: string; path: string; isDir: boolean } => ({
  name,
  path: `${dir}/${name}`,
  isDir: true
})

/** A root holding one folder `big` with n files, then `z.txt`. */
function bigTree(n: number): { dirs: Record<string, DirState>; expanded: Set<string> } {
  const big = Array.from({ length: n }, (_, i) => file(`${ROOT}/big`, `f${String(i).padStart(5, '0')}.ts`))
  return {
    dirs: {
      [ROOT]: { entries: [folder(ROOT, 'big'), file(ROOT, 'z.txt')] },
      [`${ROOT}/big`]: { entries: big }
    },
    expanded: new Set([`${ROOT}/big`])
  }
}

describe('buildTreeRows — 펼친 트리를 행 목록으로 편다', () => {
  it('항목 행의 순서는 flattenVisible(Shift 범위 선택이 쓰는 순서) 과 같다', () => {
    const dirs: Record<string, DirState> = {
      [ROOT]: { entries: [folder(ROOT, 'a'), folder(ROOT, 'b'), file(ROOT, 'c.ts')] },
      [`${ROOT}/a`]: { entries: [file(`${ROOT}/a`, 'x.ts'), folder(`${ROOT}/a`, 'deep')] },
      [`${ROOT}/a/deep`]: { entries: [file(`${ROOT}/a/deep`, 'y.ts')] },
      [`${ROOT}/b`]: { entries: [file(`${ROOT}/b`, 'hidden.ts')] }
    }
    const expanded = new Set([`${ROOT}/a`, `${ROOT}/a/deep`])
    const rows = buildTreeRows(ROOT, dirs, expanded, null)
    expect(entryPaths(rows)).toEqual(flattenVisible(ROOT, dirs, expanded))
    const deep = rows.find((r) => r.kind === 'entry' && r.entry.path === `${ROOT}/a/deep/y.ts`)
    expect(deep && deep.depth).toBe(2)
    const a = rows.find((r) => r.kind === 'entry' && r.entry.path === `${ROOT}/a`)
    expect(a && a.kind === 'entry' && a.open).toBe(true)
  })

  it('읽는 중·읽기 실패·빈 폴더는 그 자리에 안내 행을 둔다', () => {
    const dirs: Record<string, DirState> = {
      [ROOT]: { entries: [folder(ROOT, 'a'), folder(ROOT, 'b'), folder(ROOT, 'c')] },
      [`${ROOT}/b`]: { error: 'EACCES' },
      [`${ROOT}/c`]: { entries: [] }
    }
    const rows = buildTreeRows(ROOT, dirs, new Set([`${ROOT}/a`, `${ROOT}/b`, `${ROOT}/c`]), null)
    const notes = rows.filter((r) => r.kind === 'note')
    expect(notes.map((n) => n.kind === 'note' && n.note)).toEqual(['loading', 'readFailed', 'empty'])
    expect(notes.every((n) => n.depth === 1)).toBe(true)
    expect(rows.map((r) => r.kind)).toEqual(['entry', 'note', 'entry', 'note', 'entry', 'note'])
  })

  it('루트를 아직 못 읽었으면 루트 읽는 중 행 하나다', () => {
    expect(buildTreeRows(ROOT, {}, new Set(), null).map((r) => r.kind)).toEqual(['rootReading'])
  })

  it('만들기 편집 행은 그 폴더의 자식 맨 위에, 이름 바꾸기 편집 행은 그 항목 자리에 선다', () => {
    const dirs: Record<string, DirState> = {
      [ROOT]: { entries: [folder(ROOT, 'a'), file(ROOT, 'c.ts')] },
      [`${ROOT}/a`]: { entries: [file(`${ROOT}/a`, 'x.ts')] }
    }
    const expanded = new Set([`${ROOT}/a`])
    const create = buildTreeRows(ROOT, dirs, expanded, { kind: 'create', parentDir: `${ROOT}/a`, isDir: false })
    expect(create.map((r) => r.kind)).toEqual(['entry', 'edit', 'entry', 'entry'])
    expect(create[1].depth).toBe(1)
    const rename = buildTreeRows(ROOT, dirs, expanded, {
      kind: 'rename',
      path: `${ROOT}/a`,
      initial: 'a',
      isDir: true
    })
    // 이름을 바꾸는 폴더의 자식은 그대로 아래에 남는다
    expect(rename.map((r) => r.kind)).toEqual(['edit', 'entry', 'entry'])
    // 아직 읽지 않은 폴더에서 만들기를 시작해도 편집 행은 보인다
    const pending = buildTreeRows(ROOT, { [ROOT]: dirs[ROOT] }, expanded, {
      kind: 'create',
      parentDir: `${ROOT}/a`,
      isDir: true
    })
    expect(pending.map((r) => r.kind)).toEqual(['entry', 'edit', 'note', 'entry'])
  })

  // 한 폴더만 다시 읽힌 뒤에도 다른 폴더의 행은 같은 entry 객체를 들고 있어야 메모된 행이 다시 그려지지 않는다
  it('한 폴더를 다시 읽어도 다른 폴더 행의 entry 는 같은 객체다', () => {
    const { dirs, expanded } = bigTree(50)
    const before = buildTreeRows(ROOT, dirs, expanded, null)
    const reloaded = { ...dirs, [ROOT]: { entries: [...dirs[ROOT].entries!.map((e) => ({ ...e }))] } }
    const after = buildTreeRows(ROOT, reloaded, expanded, null)
    const pick = (rows: typeof before, p: string): unknown =>
      rows.find((r) => r.kind === 'entry' && r.entry.path === p)
    const inBig = `${ROOT}/big/f00007.ts`
    expect(pick(after, inBig)).toEqual(pick(before, inBig))
    const b = pick(before, inBig) as { entry: unknown }
    const a = pick(after, inBig) as { entry: unknown }
    expect(a.entry).toBe(b.entry)
  })
})

describe('창 계산 — 보이는 행과 overscan 만 그린다', () => {
  it('10,000 항목 폴더에서도 뷰포트와 overscan 만큼의 행만 고른다', () => {
    const { dirs, expanded } = bigTree(10_000)
    const rows = buildTreeRows(ROOT, dirs, expanded, null)
    expect(rows.length).toBe(10_002)
    const offsets = rowOffsets(rows, false)
    expect(offsets[rows.length]).toBe(10_002 * ROW_H)
    const viewport = 400
    const inView = Math.ceil(viewport / ROW_H)
    const top = visibleRange(offsets, 0, viewport, OVERSCAN)
    expect(top.start).toBe(0)
    expect(top.end - top.start).toBeLessThanOrEqual(inView + OVERSCAN + 1)
    const mid = visibleRange(offsets, 5000 * ROW_H, viewport, OVERSCAN)
    expect(mid.start).toBe(5000 - OVERSCAN)
    expect(mid.end - mid.start).toBeLessThanOrEqual(inView + 2 * OVERSCAN + 1)
    const bottom = visibleRange(offsets, offsets[rows.length] - viewport, viewport, OVERSCAN)
    expect(bottom.end).toBe(rows.length)
  })

  it('편집 행은 이유 줄이 보일 때 더 높다', () => {
    const dirs: Record<string, DirState> = { [ROOT]: { entries: [file(ROOT, 'a'), file(ROOT, 'b')] } }
    const rows = buildTreeRows(ROOT, dirs, new Set(), { kind: 'rename', path: `${ROOT}/a`, initial: 'a', isDir: false })
    expect(rowOffsets(rows, false)).toEqual([0, EDIT_H, EDIT_H + ROW_H])
    expect(rowOffsets(rows, true)).toEqual([0, EDIT_H + EDIT_REASON_H, EDIT_H + EDIT_REASON_H + ROW_H])
    // 높이가 다른 행이 있어도 창은 그 경계를 정확히 찾는다
    expect(visibleRange(rowOffsets(rows, true), EDIT_H + EDIT_REASON_H, 1, 0)).toEqual({ start: 1, end: 2 })
  })

  it('빈 목록은 빈 창이다', () => {
    expect(visibleRange([0], 0, 500, OVERSCAN)).toEqual({ start: 0, end: 0 })
  })
})

describe('revealScrollTop — 드러낼 행이 보이도록 하는 가장 가까운 스크롤', () => {
  const { dirs, expanded } = bigTree(10_000)
  const rows = buildTreeRows(ROOT, dirs, expanded, null)
  const offsets = rowOffsets(rows, false)
  const viewport = 400

  it('멀리 아래에 있는 파일을 드러내면 그 행이 창 안에 들어온다', () => {
    const target = `${ROOT}/big/f09000.ts`
    const i = indexOfPath(rows, target)
    expect(i).toBe(9001)
    const top = revealScrollTop(offsets, i, 0, viewport)
    // 아래로 내려갈 때는 행의 아랫변을 뷰포트 아랫변에 맞춘다
    expect(top).toBe(offsets[i + 1] - viewport)
    const range = visibleRange(offsets, top, viewport, OVERSCAN)
    expect(range.start).toBeLessThanOrEqual(i)
    expect(range.end).toBeGreaterThan(i)
  })

  it('위에 있는 행은 윗변을 맞추고, 이미 보이는 행은 스크롤을 건드리지 않는다', () => {
    expect(revealScrollTop(offsets, 10, 5000, viewport)).toBe(10 * ROW_H)
    expect(revealScrollTop(offsets, 230, 5000, viewport)).toBe(5000)
  })

  it('목록에 없는 경로는 -1 이다', () => {
    expect(indexOfPath(rows, `${ROOT}/nope`)).toBe(-1)
  })
})

describe('moveCursor — 키보드로 행을 옮긴다', () => {
  const paths = Array.from({ length: 100 }, (_, i) => `/p${i}`)

  it('위·아래는 한 칸, 끝에서는 멈춘다', () => {
    expect(moveCursor(paths, '/p5', 'down', 10)).toBe('/p6')
    expect(moveCursor(paths, '/p5', 'up', 10)).toBe('/p4')
    expect(moveCursor(paths, '/p99', 'down', 10)).toBe('/p99')
    expect(moveCursor(paths, '/p0', 'up', 10)).toBe('/p0')
  })

  it('Home·End·PageUp·PageDown', () => {
    expect(moveCursor(paths, '/p5', 'home', 10)).toBe('/p0')
    expect(moveCursor(paths, '/p5', 'end', 10)).toBe('/p99')
    expect(moveCursor(paths, '/p5', 'pageDown', 10)).toBe('/p15')
    expect(moveCursor(paths, '/p95', 'pageDown', 10)).toBe('/p99')
    expect(moveCursor(paths, '/p5', 'pageUp', 10)).toBe('/p0')
  })

  it('현재 행이 없거나 사라졌으면 처음(끝 키는 끝)에서 시작한다', () => {
    expect(moveCursor(paths, null, 'down', 10)).toBe('/p0')
    expect(moveCursor(paths, '/gone', 'up', 10)).toBe('/p0')
    expect(moveCursor(paths, null, 'end', 10)).toBe('/p99')
    expect(moveCursor([], null, 'down', 10)).toBe(null)
  })

  // 가상화 경계를 넘는 키보드 이동: 그려진 창의 마지막 행에서 아래로 가면 창 밖의 행이 선택되고,
  // 그 행을 드러내는 스크롤을 하면 창이 그 행을 포함하도록 움직인다
  it('창의 경계를 넘어 아래로 이동하면 다음 행이 드러난다', () => {
    const { dirs, expanded } = bigTree(10_000)
    const rows = buildTreeRows(ROOT, dirs, expanded, null)
    const offsets = rowOffsets(rows, false)
    const viewport = 400
    const range = visibleRange(offsets, 0, viewport, OVERSCAN)
    const lastRendered = rows[range.end - 1]
    const from = lastRendered.kind === 'entry' ? lastRendered.entry.path : null
    const next = moveCursor(entryPaths(rows), from, 'down', 10)!
    const ni = indexOfPath(rows, next)
    expect(ni).toBe(range.end) // 창 바로 밖
    const top = revealScrollTop(offsets, ni, 0, viewport)
    const after = visibleRange(offsets, top, viewport, OVERSCAN)
    expect(after.start).toBeLessThanOrEqual(ni)
    expect(after.end).toBeGreaterThan(ni)
    // End 로 맨 끝까지 가도 마찬가지다
    const last = moveCursor(entryPaths(rows), next, 'end', 10)!
    const li = indexOfPath(rows, last)
    const endTop = revealScrollTop(offsets, li, top, viewport)
    expect(visibleRange(offsets, endTop, viewport, OVERSCAN).end).toBe(rows.length)
  })
})

describe('drawnRows — 창 밖이어도 그려 둘 행', () => {
  it('창 밖의 고정 행(편집 행·끌기 시작 행)을 행 순서대로 끼워 넣는다', () => {
    expect(drawnRows({ start: 10, end: 13 }, [500, 2])).toEqual([2, 10, 11, 12, 500])
  })

  it('창 안의 고정 행과 중복은 한 번만', () => {
    expect(drawnRows({ start: 10, end: 13 }, [11, 500, 500])).toEqual([10, 11, 12, 500])
    expect(drawnRows({ start: 0, end: 0 }, [])).toEqual([])
  })
})
