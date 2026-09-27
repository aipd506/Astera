import { describe, it, expect, vi } from 'vitest'
import { freePort, killTree, processStartTimes } from './native'

describe('processStartTimes', () => {
  it('asks once for every pid and reads pid|ms lines', async () => {
    const exec = vi.fn(async () => '100|1700000000000\r\n200|1700000000500\r\nnoise\r\n')
    const r = await processStartTimes([100, 200, 300], exec)
    expect([...r.entries()]).toEqual([
      [100, 1700000000000],
      [200, 1700000000500]
    ])
    const [file, args] = exec.mock.calls[0] as unknown as [string, string[]]
    expect(file).toBe('powershell.exe')
    expect(args.at(-1)).toContain('ProcessId=100 OR ProcessId=200 OR ProcessId=300')
  })

  it('asks nothing for no pids, and refuses a pid that is not a positive integer', async () => {
    const exec = vi.fn(async () => '')
    expect((await processStartTimes([], exec)).size).toBe(0)
    expect(exec).not.toHaveBeenCalled()
    await expect(processStartTimes([1.5], exec)).rejects.toThrow('not a pid')
  })
})

describe('killTree', () => {
  it('ends the tree with taskkill', async () => {
    const exec = vi.fn(async () => '')
    await killTree(321, exec)
    expect(exec).toHaveBeenCalledWith('taskkill', ['/pid', '321', '/T', '/F'])
  })

  it('a process that is already gone is not a failure', async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error('Command failed'), { code: 128 })
    })
    await expect(killTree(321, exec)).resolves.toBeUndefined()
  })
})

describe('freePort', () => {
  it('answers a loopback port nobody holds', async () => {
    const p = await freePort()
    expect(Number.isSafeInteger(p) && p > 0 && p < 65536).toBe(true)
  })
})
