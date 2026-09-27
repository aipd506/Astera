import { describe, it, expect } from 'vitest'
import { START_TIME_TOLERANCE_MS } from '../../core/workspace/lifecycle'
import { DESK_PS1 } from './desk'

// The script itself runs only on Windows (Task 3's live test below, and Task 10). These pin the two
// traps the spike paid for (docs/agent-workspace-isolation.md, Pointers) and the shape the client reads.
describe('DESK_PS1', () => {
  it('is ASCII, so Windows PowerShell 5.1 reads the BOM-less file the same in every code page', () => {
    expect([...DESK_PS1].every((c) => c.charCodeAt(0) < 128)).toBe(true)
  })

  it('passes null strings as [NullString]::Value, never $null (the ERROR_PATH_NOT_FOUND trap)', () => {
    expect(DESK_PS1).toContain('[NullString]::Value')
    expect(DESK_PS1).not.toMatch(/\$cwd\s*=\s*\$null/)
  })

  it('reports an Add-Type failure as a fatal line before ready, instead of failing silently', () => {
    const fatal = DESK_PS1.indexOf('fatal =')
    const ready = DESK_PS1.indexOf('ready = $true')
    expect(fatal).toBeGreaterThan(0)
    expect(ready).toBeGreaterThan(fatal)
    expect(DESK_PS1).toContain('Add-Type')
  })

  it('uses the calls the spike measured', () => {
    for (const call of ['CreateDesktop', 'SetThreadDesktop', 'EnumDesktopWindows', 'PrintWindow', 'PostMessage', 'CloseDesktop', 'GetProcessTimes', 'WSF_VISIBLE'])
      expect(DESK_PS1, call).toContain(call)
    expect(DESK_PS1).toContain('PW_RENDERFULLCONTENT = 2')
  })

  it('never launches on the person desktop: no desktop name is a refusal, not the default desktop', () => {
    expect(DESK_PS1).toContain('no desktop to launch on')
    expect(DESK_PS1).toContain('string.IsNullOrEmpty(desktop)')
  })

  it('writes every message with -InputObject, so a one element array is not unwrapped', () => {
    expect(DESK_PS1).toContain('ConvertTo-Json -InputObject')
  })

  it('answers a failed request with the innermost message, not PowerShell\'s localized "Exception calling" wrapper', () => {
    expect(DESK_PS1).toContain('while ($err.InnerException) { $err = $err.InnerException }')
    expect(DESK_PS1).toContain('error = ($err.Message')
  })

  it('attaches a fresh thread to the desktop, since PowerShell\'s own STA thread owns windows (ERROR_BUSY)', () => {
    expect(DESK_PS1).toContain('static T OnDesk<T>(IntPtr desk, Func<T> f)')
    expect(DESK_PS1).toContain('new Thread(')
  })

  it('kills only the process launched: a pid whose start time differs by more than the lifecycle tolerance is skipped', () => {
    expect(DESK_PS1).toContain(`$tolerance = ${String(START_TIME_TOLERANCE_MS)}`)
    expect(DESK_PS1).toContain('[AsteraDesk]::StartedAtOf([int]$req.pid)')
    expect(DESK_PS1).toContain('[Math]::Abs($live - [int64]$req.startedAt) -gt $tolerance')
    expect(DESK_PS1).toContain('start time mismatch')
    expect(DESK_PS1.indexOf('start time mismatch')).toBeLessThan(DESK_PS1.indexOf('taskkill /T /F /PID'))
  })

  it('keeps its escapes as text: no CR byte, and the regex still says \\r\\n', () => {
    expect(DESK_PS1.includes(String.fromCharCode(13))).toBe(false)
    expect(DESK_PS1).toContain('[\\r\\n]+')
  })
})
