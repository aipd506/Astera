import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JournalOlder, JournalBusy } from './RunDetailJournal'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'en',
    t: (key: string) => key,
    tm: (m: unknown) => String(m)
  })
}))

// Stage 3 T1: the run-detail window reads only the newest page of journal rows, and a journal the Host
// holds locked shows the rows last read instead of freezing the window.
describe('RunDetail journal notes', () => {
  it('offers "show older" only while older journal rows are left', () => {
    const html = renderToStaticMarkup(React.createElement(JournalOlder, { journal: { busy: false, older: true }, onShowOlder: () => {} }))
    expect(html).toContain('<button')
    expect(html).toContain('jobs.detail.journalOlder')
    expect(renderToStaticMarkup(React.createElement(JournalOlder, { journal: { busy: false, older: false }, onShowOlder: () => {} }))).toBe('')
    expect(renderToStaticMarkup(React.createElement(JournalOlder, { journal: undefined, onShowOlder: () => {} }))).toBe('')
  })

  it('says the journal is busy only while it is', () => {
    expect(renderToStaticMarkup(React.createElement(JournalBusy, { journal: { busy: true, older: false } }))).toContain(
      'jobs.detail.journalBusy'
    )
    expect(renderToStaticMarkup(React.createElement(JournalBusy, { journal: { busy: false, older: true } }))).toBe('')
    expect(renderToStaticMarkup(React.createElement(JournalBusy, { journal: undefined }))).toBe('')
  })
})
