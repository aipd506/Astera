import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FileExplorer, type ExplorerTreeState } from './FileExplorer'
import { OVERSCAN, DEFAULT_VIEWPORT_H, ROW_H } from './explorerRows'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

// 렌더 중에는 window.api 를 부르지 않는다(효과는 서버 렌더에서 돌지 않는다) — 그래도 모듈이 읽을 자리는 둔다
const g = globalThis as unknown as { window?: unknown }
let hadWindow = false
beforeAll(() => {
  hadWindow = 'window' in g
  if (!hadWindow) g.window = { api: {} }
})
afterAll(() => {
  if (!hadWindow) delete g.window
})

const ROOT = '/r'

function render(n: number): string {
  const big = Array.from({ length: n }, (_, i) => ({
    name: `f${String(i).padStart(5, '0')}.ts`,
    path: `${ROOT}/big/f${String(i).padStart(5, '0')}.ts`,
    isDir: false
  }))
  const state: ExplorerTreeState = {
    root: ROOT,
    expanded: new Set([`${ROOT}/big`]),
    dirs: {
      [ROOT]: { entries: [{ name: 'big', path: `${ROOT}/big`, isDir: true }] },
      [`${ROOT}/big`]: { entries: big }
    },
    clipboard: null
  }
  return renderToStaticMarkup(
    React.createElement(FileExplorer, {
      root: ROOT,
      onOpenFile: () => {},
      onClose: () => {},
      stateRef: { current: new Map([[ROOT, state]]) },
      clipboardRef: { current: null },
      undoRef: { current: [] },
      onPathRenamed: () => {},
      onPathDeleted: () => {},
      onRunFile: () => {}
    })
  )
}

describe('FileExplorer — 가상화된 트리', () => {
  it('10,000 항목 폴더를 펼쳐도 뷰포트와 overscan 만큼의 행만 그린다', () => {
    const html = render(10_000)
    const rows = html.match(/class="fx-row[ "]/g) ?? []
    const budget = Math.ceil(DEFAULT_VIEWPORT_H / ROW_H) + 2 * OVERSCAN + 1
    expect(rows.length).toBeGreaterThan(10)
    expect(rows.length).toBeLessThanOrEqual(budget)
    // 첫 행들은 그려지고, 한참 아래 행은 그려지지 않는다
    expect(html).toContain('f00000.ts')
    expect(html).not.toContain('f09000.ts')
    // 스크롤 높이는 전체 행 수만큼 잡힌다
    expect(html).toContain(`height:${10_001 * ROW_H}px`)
  })
})
