// Stage 4 T6: a bundle launch polls with two ps calls, and a ps that hangs held each of them for the
// 30 s every other tool gets. These calls take MAC_PS_TIMEOUT_MS instead. Its own file, since it
// replaces node:child_process for everything it imports.
import { describe, it, expect, vi } from 'vitest'

const calls: Array<{ file: string; args: string[]; timeout: unknown }> = []
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    execFile: (file: string, args: string[], opts: { timeout?: number }, cb: (err: Error | null, stdout: string) => void) => {
      calls.push({ file, args, timeout: opts.timeout })
      cb(null, '')
    }
  }
})

describe('the macOS desk: ps timeout (stage 4 T6)', () => {
  it('gives each ps of a bundle launch poll about 5 s, not 30 s', async () => {
    const { MAC_PS_TIMEOUT_MS, realMacDeskDeps, BUNDLE_LIST_PS } = await import('./deskMac')
    expect(MAC_PS_TIMEOUT_MS).toBe(5_000)
    await realMacDeskDeps({ log: () => {} }).exec('env', ['LC_ALL=C', 'ps', ...BUNDLE_LIST_PS])
    expect(calls).toEqual([{ file: 'env', args: ['LC_ALL=C', 'ps', ...BUNDLE_LIST_PS], timeout: MAC_PS_TIMEOUT_MS }])
  })

  it('leaves every other tool its 30 s', async () => {
    const { execText } = await import('./posixProc')
    calls.length = 0
    await execText('true', [])
    expect(calls[0]?.timeout).toBe(30_000)
  })
})
