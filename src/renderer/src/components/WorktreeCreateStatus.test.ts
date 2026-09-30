import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorktreeCreateProgress } from '../../../core/types'
import { StartingOverlay, formatBytes } from './WorktreeCreateStatus'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

type Props = React.ComponentProps<typeof StartingOverlay>
const base: Props = { withWorktree: true, progress: null, created: false, cancelling: false, onCancel: () => {} }
const html = (p: Partial<Props>): string =>
  renderToStaticMarkup(React.createElement(StartingOverlay, { ...base, ...p })).replace(/&quot;/g, '"')

/** Walks an element tree the component function returned (no DOM here), calling function components. */
function findAll(node: React.ReactNode, match: (el: React.ReactElement) => boolean): React.ReactElement[] {
  const out: React.ReactElement[] = []
  const visit = (n: React.ReactNode): void => {
    if (Array.isArray(n)) return n.forEach(visit)
    if (!React.isValidElement(n)) return
    if (typeof n.type === 'function') return visit((n.type as (p: unknown) => React.ReactNode)(n.props))
    if (match(n)) out.push(n)
    visit((n.props as { children?: React.ReactNode }).children)
  }
  visit(node)
  return out
}

// 워크트리를 만드는 동안 한 줄 스피너만 보이던 자리. 어느 단계인지, 복사는 얼마나 됐는지 보이고,
// 만드는 동안에는 취소할 수 있다.
describe('StartingOverlay — 워크트리 만들기 진행', () => {
  it('진행이 오기 전에는 "워크트리를 만드는 중" 과 취소 버튼', () => {
    const h = html({})
    expect(h).toContain('session.new.startingWorktree')
    expect(h).toContain('common.cancel')
    expect(h).toContain('loading-spinner')
  })

  it.each<[WorktreeCreateProgress['stage'], string]>([
    ['fetch', 'session.new.stage.fetch'],
    ['checkout', 'session.new.stage.checkout'],
    ['copy-includes', 'session.new.stage.copyIncludes']
  ])('단계 %s 는 제 이름표를 보인다', (stage, key) => {
    expect(html({ progress: { stage } })).toContain(key)
  })

  it('복사 중에는 진행 막대와 바이트·파일 수를 보인다', () => {
    const h = html({
      progress: { stage: 'copy-includes', bytesCopied: 1024 * 1024, bytesTotal: 4 * 1024 * 1024, filesCopied: 3, filesTotal: 12 }
    })
    expect(h).toContain('worktree-progress-bar')
    expect(h).toContain('width:25%')
    expect(h).toContain('session.new.stage.copyCount')
    expect(h).toContain('"copied":"1.0MB"')
    expect(h).toContain('"total":"4.0MB"')
    expect(h).toContain('"files":3')
    expect(h).toContain('"filesTotal":12')
  })

  it('복사 단계라도 아직 재는 중이면(수가 없으면) 막대를 그리지 않는다', () => {
    expect(html({ progress: { stage: 'copy-includes' } })).not.toContain('worktree-progress-bar')
  })

  it('워크트리가 만들어진 뒤에는 "세션을 시작하는 중" 이고 취소 버튼이 없다', () => {
    const h = html({ created: true })
    expect(h).toContain('session.new.starting')
    expect(h).not.toContain('session.new.startingWorktree')
    expect(h).not.toContain('common.cancel')
  })

  it('워크트리 없이 시작하면 취소 버튼이 없다', () => {
    const h = html({ withWorktree: false })
    expect(h).toContain('session.new.starting')
    expect(h).not.toContain('common.cancel')
  })

  it('취소 버튼을 누르면 onCancel 을 부른다', () => {
    const onCancel = vi.fn()
    const tree = StartingOverlay({ ...base, progress: { stage: 'checkout' }, onCancel })
    const buttons = findAll(tree, (el) => el.type === 'button')
    expect(buttons).toHaveLength(1)
    ;(buttons[0].props as { onClick: () => void }).onClick()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('취소를 누른 뒤에는 버튼이 "취소하는 중" 으로 잠긴다', () => {
    const tree = StartingOverlay({ ...base, cancelling: true })
    const [button] = findAll(tree, (el) => el.type === 'button')
    expect((button.props as { disabled?: boolean }).disabled).toBe(true)
    expect(html({ cancelling: true })).toContain('session.new.cancelling')
  })
})

describe('formatBytes', () => {
  it('단위를 올려 가며 소수 한 자리로 적는다', () => {
    expect(formatBytes(0)).toBe('0B')
    expect(formatBytes(1536)).toBe('1.5KB')
    expect(formatBytes(200 * 1024 * 1024)).toBe('200.0MB')
  })
})
