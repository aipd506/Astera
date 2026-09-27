import { describe, it, expect } from 'vitest'
import { asLaunched, asShot, asWindows, encodeDeskRequest, parseDeskLine } from './protocol'

describe('parseDeskLine', () => {
  it('reads ready, fatal, and both kinds of reply', () => {
    expect(parseDeskLine('{"ready":true,"interactive":true,"pid":42,"startedAt":1700000000000}')).toEqual({
      kind: 'ready',
      interactive: true,
      pid: 42,
      startedAt: 1700000000000
    })
    expect(parseDeskLine('{"fatal":"Add-Type failed: CS1002"}')).toEqual({ kind: 'fatal', error: 'Add-Type failed: CS1002' })
    expect(parseDeskLine('{"id":3,"ok":true,"value":{"pid":7}}')).toEqual({ kind: 'reply', id: 3, ok: true, value: { pid: 7 } })
    expect(parseDeskLine('{"id":4,"ok":false,"error":"no window"}')).toEqual({ kind: 'reply', id: 4, ok: false, error: 'no window' })
  })

  it('tolerates CRLF endings and a leading BOM', () => {
    const bom = String.fromCharCode(0xfeff)
    expect(parseDeskLine(`${bom}{"id":1,"ok":true,"value":null}\r`)).toEqual({ kind: 'reply', id: 1, ok: true, value: null })
  })

  it('answers null for anything that is not a message', () => {
    for (const line of ['', '   ', 'WARNING: something', '{"id":"x","ok":true}', '[1,2]', '{broken', '{"ready":true}'])
      expect(parseDeskLine(line), line).toBeNull()
  })

  it('gives a failed reply with no error a reason', () => {
    expect(parseDeskLine('{"id":9,"ok":false}')).toEqual({ kind: 'reply', id: 9, ok: false, error: 'the desktop helper gave no reason' })
  })
})

describe('encodeDeskRequest', () => {
  it('is one JSON line that round trips Hangul and spaces', () => {
    const line = encodeDeskRequest({ id: 1, op: 'launch', commandLine: 'cmd.exe /s /c "npm run dev"', cwd: 'C:\\Users\\홍 길동\\앱', env: { A: '가 나' } })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.indexOf('\n')).toBe(line.length - 1)
    expect(JSON.parse(line)).toMatchObject({ cwd: 'C:\\Users\\홍 길동\\앱', env: { A: '가 나' } })
  })
})

describe('the value readers', () => {
  it('asLaunched wants a pid and a start time', () => {
    expect(asLaunched({ pid: 10, startedAt: 5 })).toEqual({ pid: 10, startedAt: 5 })
    expect(() => asLaunched({ pid: 0, startedAt: 5 })).toThrow('no pid')
    expect(() => asLaunched(null)).toThrow('no pid')
  })

  it('a single window unwrapped to an object is still a list of one', () => {
    const w = { hwnd: 100, title: 'Fixture', className: 'Chrome_WidgetWin_1', pid: 7, width: 800, height: 600, visible: true }
    expect(asWindows(w)).toEqual([w])
    expect(asWindows([w, w])).toHaveLength(2)
    expect(asWindows(null)).toEqual([])
    expect(asWindows(undefined)).toEqual([])
    expect(asWindows([{ title: 'no hwnd' }, w])).toEqual([w])
  })

  it('asShot wants image data and a size', () => {
    expect(asShot({ data: 'iVBO', width: 2, height: 3, title: 'T' })).toEqual({ data: 'iVBO', width: 2, height: 3, title: 'T' })
    expect(() => asShot({ data: '', width: 2, height: 3 })).toThrow('no image')
  })
})
