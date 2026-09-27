import { describe, it, expect } from 'vitest'
import { applyWorkspaceEvent, mirrorsFromList, newlyOpened, type Mirrors } from './workspaceMirror'

const frame = { jpeg: '/9j/', width: 4, height: 3, at: 1 }

describe('the mirror state', () => {
  it('opens on a state event, takes frames, and keeps the last frame when it closes', () => {
    let m: Mirrors = {}
    m = applyWorkspaceEvent(m, { kind: 'state', sessionId: 's1', open: true, running: true, helper: 'launch' })
    m = applyWorkspaceEvent(m, { kind: 'frame', sessionId: 's1', frame })
    expect(m.s1).toEqual({ sessionId: 's1', open: true, running: true, helper: 'launch', frame })
    m = applyWorkspaceEvent(m, { kind: 'state', sessionId: 's1', open: false, running: false, helper: null })
    expect(m.s1).toEqual({ sessionId: 's1', open: false, running: false, helper: null, frame })
  })

  it('a frame for a session it has not heard of opens it', () => {
    expect(applyWorkspaceEvent({}, { kind: 'frame', sessionId: 's9', frame }).s9).toMatchObject({ open: true, frame })
  })

  it('says which sessions just opened, so each gets its tab once', () => {
    const a: Mirrors = {}
    const b = applyWorkspaceEvent(a, { kind: 'state', sessionId: 's1', open: true, running: false, helper: null })
    const c = applyWorkspaceEvent(b, { kind: 'state', sessionId: 's1', open: true, running: true, helper: 'click' })
    const d = applyWorkspaceEvent(c, { kind: 'state', sessionId: 's1', open: false, running: false, helper: null })
    const e = applyWorkspaceEvent(d, { kind: 'state', sessionId: 's1', open: true, running: false, helper: null })
    expect(newlyOpened(a, b)).toEqual(['s1'])
    expect(newlyOpened(b, c)).toEqual([])
    expect(newlyOpened(d, e)).toEqual(['s1'])
  })

  it('builds from a list', () => {
    expect(mirrorsFromList([{ sessionId: 's2', running: false, helper: null, frame: null }])).toEqual({
      s2: { sessionId: 's2', open: true, running: false, helper: null, frame: null }
    })
  })
})
