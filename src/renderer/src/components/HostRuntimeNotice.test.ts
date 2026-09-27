import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { HostRuntimeNotice, HOST_RUNTIME_NOTICE_KEYS } from './HostRuntimeNotice'
import { CATALOGS, LANGS } from '../../../core/i18n'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

const render = (props: Parameters<typeof HostRuntimeNotice>[0]): string =>
  renderToStaticMarkup(React.createElement(HostRuntimeNotice, props))

// Stage 3 task 2: putting the Host's runtime in place after an update can take many seconds, and it
// used to do that with nothing on screen. The status bar now says so, and keeps saying it is working.
describe('HostRuntimeNotice — the status bar while the Host runtime is being prepared', () => {
  it('shows nothing while nothing is being prepared', () => {
    expect(render({ state: null, nowMs: 0 })).toBe('')
    expect(render({ state: { phase: 'idle' }, nowMs: 0 })).toBe('')
  })

  it('says "Preparing the Astera Host" with the spinner the moment an install starts', () => {
    const html = render({ state: { phase: 'preparing', slow: false, startedAt: 1_000 }, nowMs: 1_200 })
    expect(html).toContain('status.hostPreparing')
    expect(html).not.toContain('status.hostPreparingSlow')
    expect(html).toContain('loading-spinner')
    expect(html).toContain('role="status"')
  })

  it('says it is still working, and for how long, once the install runs past a second', () => {
    const html = render({ state: { phase: 'preparing', slow: true, startedAt: 1_000 }, nowMs: 8_400 })
    expect(html).toContain('status.hostPreparingSlow')
    expect(html).toContain('&quot;seconds&quot;:7')
    expect(html).toContain('loading-spinner')
  })

  it('reports a failed install, with the reason in the title', () => {
    const html = render({ state: { phase: 'failed', detail: 'EBUSY node.exe' }, nowMs: 0 })
    expect(html).toContain('status.hostPrepareFailed')
    expect(html).toContain('EBUSY node.exe')
    expect(html).not.toContain('loading-spinner')
  })

  it('has every one of its strings in all four languages', () => {
    for (const lang of LANGS) {
      for (const key of HOST_RUNTIME_NOTICE_KEYS) {
        expect(CATALOGS[lang].messages[key], `${lang}:${key}`).toBeTruthy()
      }
    }
    expect(LANGS).toEqual(expect.arrayContaining(['en', 'ko', 'ja', 'es']))
  })
})
