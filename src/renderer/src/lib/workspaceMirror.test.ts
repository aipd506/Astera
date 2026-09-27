import { describe, it, expect } from 'vitest'
import { appTab, sessionTab } from '../../../core/panes/tabId'
import { createGroup, leaves, type PaneNode } from '../../../core/panes/tree'
import { applyWorkspaceEvent, mirrorsFromList, newlyOpened, openSessionIds, placeAppTabs, removeAppTab, type Mirrors } from './workspaceMirror'

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

const tabsOf = (root: PaneNode | null): string[] => (root ? leaves(root).flatMap((l) => l.tabIds) : [])

describe('placing the mirror tabs', () => {
  // Fix round 1 (Important): two workspaces that open before a render must both keep their tab.
  // Each placement builds on the previous one's tree, never on a tree the render has not caught up to.
  it('two sessions opened in one batch both get a tab, in the background', () => {
    const g = createGroup(sessionTab('s0'))
    const root = placeAppTabs(g, ['s1', 's2'], g.id)
    expect(tabsOf(root)).toEqual([sessionTab('s0'), appTab('s1'), appTab('s2')])
    expect(root && leaves(root)[0].activeTabId).toBe(sessionTab('s0'))
  })

  it('places onto an empty tree, and never places a tab twice', () => {
    const root = placeAppTabs(null, ['s1', 's1'], null)
    expect(tabsOf(root)).toEqual([appTab('s1')])
    expect(tabsOf(placeAppTabs(root, ['s1'], null))).toEqual([appTab('s1')])
    expect(placeAppTabs(null, [], null)).toBeNull()
  })

  it('names only the sessions whose workspace is open', () => {
    const m: Mirrors = {
      ...mirrorsFromList([{ sessionId: 's1', running: false, helper: null, frame: null }]),
      s2: { sessionId: 's2', open: false, running: false, helper: null, frame: null }
    }
    expect(openSessionIds(m)).toEqual(['s1'])
  })

  // Fix round 1 (minor): closing a session takes its mirror tab with it.
  it('removes a session mirror tab, and leaves a tree without one alone', () => {
    const root = placeAppTabs(createGroup(sessionTab('s1')), ['s1'], null)
    expect(tabsOf(removeAppTab(root, 's1'))).toEqual([sessionTab('s1')])
    const plain = createGroup(sessionTab('s1'))
    expect(removeAppTab(plain, 's1')).toBe(plain)
    expect(removeAppTab(null, 's1')).toBeNull()
  })
})
