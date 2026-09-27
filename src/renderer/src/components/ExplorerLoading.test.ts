import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RowLoading, RootReading } from './ExplorerLoading'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'ko', t: (key: string) => key, tm: (m: unknown) => String(m) })
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
