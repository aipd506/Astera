import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFileOpBusy, OP_STATUS_DELAY_MS, type FileOpBusyView } from './fileOpBusy'
import { ROW_SPINNER_DELAY_MS } from './dirReload'

// 탐색기의 삭제·붙여넣기 동안 보이는 것: 대상 행의 스피너(150ms 뒤 — 짧은 작업은 깜빡이지 않는다)와
// 1초를 넘기면 "삭제하는 중… N개 항목" 상태 줄.
describe('createFileOpBusy', () => {
  let views: FileOpBusyView[]
  const last = (): FileOpBusyView => views.at(-1) ?? { rows: new Set(), status: null }
  beforeEach(() => {
    vi.useFakeTimers()
    views = []
  })
  afterEach(() => vi.useRealTimers())

  it('행 스피너는 150ms 뒤에, 상태 줄은 1초 뒤에 보인다', () => {
    const b = createFileOpBusy((v) => views.push(v))
    b.begin('delete')
    b.rows(['D:\\p\\big'])
    vi.advanceTimersByTime(ROW_SPINNER_DELAY_MS - 1)
    expect(last().rows.size).toBe(0)
    vi.advanceTimersByTime(1)
    expect([...last().rows]).toEqual(['D:\\p\\big'])
    expect(last().status).toBeNull()
    vi.advanceTimersByTime(OP_STATUS_DELAY_MS - ROW_SPINNER_DELAY_MS - 1)
    expect(last().status).toBeNull()
    vi.advanceTimersByTime(1)
    expect(last().status).toEqual({ kind: 'delete', stage: null, count: null }) // "0개" 가 아니라 수 없이
    b.end()
  })

  it('진행 수는 상태 줄이 보이기 전에도 쌓아 두었다가, 보인 뒤에는 오는 대로 알린다', () => {
    const b = createFileOpBusy((v) => views.push(v))
    b.begin('copy')
    b.progress({ stage: 'copy', count: 40 })
    expect(views).toEqual([]) // 1초 전에는 아무것도 다시 그리지 않는다
    vi.advanceTimersByTime(OP_STATUS_DELAY_MS)
    expect(last().status).toEqual({ kind: 'copy', stage: 'copy', count: 40 })
    b.progress({ stage: 'copy', count: 900 })
    expect(last().status).toEqual({ kind: 'copy', stage: 'copy', count: 900 })
    b.end()
  })

  it('150ms 안에 끝나면 아무것도 보이지 않고 타이머도 남지 않는다', () => {
    const b = createFileOpBusy((v) => views.push(v))
    b.begin('delete')
    b.rows(['D:\\p\\small'])
    vi.advanceTimersByTime(100)
    b.end()
    vi.advanceTimersByTime(5000)
    expect(views.every((v) => v.rows.size === 0 && v.status === null)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('끝나면 스피너와 상태 줄을 곧바로 거둔다', () => {
    const b = createFileOpBusy((v) => views.push(v))
    b.begin('delete')
    b.rows(['D:\\p\\big'])
    vi.advanceTimersByTime(OP_STATUS_DELAY_MS)
    expect(last().status).not.toBeNull()
    b.end()
    expect(last()).toEqual({ rows: new Set(), status: null })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('묶음 안에서 다음 항목으로 넘어가면 스피너도 옮겨 간다', () => {
    const b = createFileOpBusy((v) => views.push(v))
    b.begin('delete')
    b.rows(['D:\\p\\a'])
    vi.advanceTimersByTime(ROW_SPINNER_DELAY_MS)
    b.rows(['D:\\p\\b'])
    expect(last().rows.has('D:\\p\\a')).toBe(false)
    vi.advanceTimersByTime(ROW_SPINNER_DELAY_MS)
    expect([...last().rows]).toEqual(['D:\\p\\b'])
    b.end()
  })

  // 묶음의 다음 항목은 새 호출이다 — 앞 항목의 수를 그대로 보이면 멈춘 것처럼 읽힌다. 첫 알림 전까지는 수 없이 보인다.
  it('다음 항목으로 넘어가면 앞 항목의 수를 지우고 수 없이 보인다', () => {
    const b = createFileOpBusy((v) => views.push(v))
    b.begin('delete')
    b.rows(['D:\p\a'])
    b.progress({ stage: 'delete', count: 800 })
    vi.advanceTimersByTime(OP_STATUS_DELAY_MS)
    expect(last().status).toEqual({ kind: 'delete', stage: 'delete', count: 800 })
    b.rows(['D:\p\b'])
    expect(last().status).toEqual({ kind: 'delete', stage: null, count: null })
    b.progress({ stage: 'snapshot', count: 3 })
    expect(last().status).toEqual({ kind: 'delete', stage: 'snapshot', count: 3 })
    b.end()
  })

  it('dispose 는 알리지 않고 타이머만 치운다(언마운트)', () => {
    const b = createFileOpBusy((v) => views.push(v))
    b.begin('copy')
    b.rows(['D:\\p\\x'])
    b.dispose()
    vi.advanceTimersByTime(5000)
    expect(views).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
