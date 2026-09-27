import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RowLoading, RootReading, FileOpStatusLine } from './ExplorerLoading'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

describe('RowLoading — 폴더 행의 인라인 로딩 표시', () => {
  it('읽는 중이면 공유 스피너를 보인다', () => {
    const html = renderToStaticMarkup(React.createElement(RowLoading, { pending: true }))
    expect(html).toContain('loading-spinner')
    expect(html).toContain('explorer.dir.loading')
  })

  it('읽는 중이 아니면 아무것도 그리지 않는다', () => {
    expect(renderToStaticMarkup(React.createElement(RowLoading, { pending: false }))).toBe('')
  })
})

describe('RootReading — 루트 첫 읽기가 느릴 때', () => {
  it('느리다고 판정되면 "폴더를 읽는 중" 을 스피너와 함께 보인다', () => {
    const html = renderToStaticMarkup(React.createElement(RootReading, { slow: true }))
    expect(html).toContain('explorer.dir.reading')
    expect(html).toContain('loading-spinner')
  })

  // 빠른 폴더에서 한 프레임 깜빡이는 문구를 막는다 — 기다림이 ROOT_SLOW_MS 를 넘어야 보인다
  it('아직 느리지 않으면 아무것도 보이지 않는다', () => {
    expect(renderToStaticMarkup(React.createElement(RootReading, { slow: false }))).toBe('')
  })
})

describe('RowLoading — 삭제·복사 중인 행', () => {
  it('label 을 주면 그 문구로 알린다', () => {
    const html = renderToStaticMarkup(React.createElement(RowLoading, { pending: true, label: 'files.op.busy' }))
    expect(html).toContain('loading-spinner')
    expect(html).toContain('files.op.busy')
  })
})

// 1초를 넘긴 삭제·붙여넣기의 상태 줄 — 무엇을 하는지와 지금까지 센 수를 스피너와 함께 보인다
describe('FileOpStatusLine', () => {
  it('상태가 없으면 아무것도 그리지 않는다', () => {
    expect(renderToStaticMarkup(React.createElement(FileOpStatusLine, { status: null }))).toBe('')
  })

  it('삭제 중이면 "삭제하는 중… N개" 를 스피너와 함께 보인다', () => {
    const html = renderToStaticMarkup(
      React.createElement(FileOpStatusLine, { status: { kind: 'delete', stage: 'delete', count: 1234 } })
    )
    expect(html).toContain('files.op.deleting')
    expect(html).toContain('1234')
    expect(html).toContain('loading-spinner')
    expect(html).toContain('role="status"')
  })

  it('삭제 전 Local History 복사 단계는 그 단계를 말한다', () => {
    const html = renderToStaticMarkup(
      React.createElement(FileOpStatusLine, { status: { kind: 'delete', stage: 'snapshot', count: 7 } })
    )
    expect(html).toContain('files.op.snapshotting')
  })

  it('첫 알림 전에는 작업 종류로 말한다(복사 중… 0)', () => {
    const html = renderToStaticMarkup(
      React.createElement(FileOpStatusLine, { status: { kind: 'copy', stage: null, count: 0 } })
    )
    expect(html).toContain('files.op.copying')
  })
})
