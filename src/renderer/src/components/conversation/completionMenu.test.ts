import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CompletionMenu } from './CompletionMenu'

const noop = (): void => {}

// `@` 가 첫 색인을 기다리는 동안 메뉴가 비어 있기만 하면 멈춘 것처럼 보인다 — 색인 중이라고 말한다
describe('CompletionMenu — indexing line', () => {
  it('shows the status line with a spinner even with no rows yet', () => {
    const html = renderToStaticMarkup(
      React.createElement(CompletionMenu, {
        rows: [],
        active: 0,
        onPick: noop,
        onHover: noop,
        status: 'Indexing files…'
      })
    )
    expect(html).toContain('Indexing files…')
    expect(html).toContain('loading-spinner')
  })

  it('keeps the partial rows above the status line', () => {
    const html = renderToStaticMarkup(
      React.createElement(CompletionMenu, {
        rows: [{ key: 'a.ts', label: 'a.ts' }],
        active: 0,
        onPick: noop,
        onHover: noop,
        status: 'Indexing files…'
      })
    )
    expect(html.indexOf('a.ts')).toBeLessThan(html.indexOf('Indexing files…'))
  })

  it('draws no status line without one', () => {
    const html = renderToStaticMarkup(
      React.createElement(CompletionMenu, { rows: [{ key: 'a.ts', label: 'a.ts' }], active: 0, onPick: noop, onHover: noop })
    )
    expect(html).not.toContain('loading-spinner')
  })
})
