import { describe, it, expect, vi } from 'vitest'
import {
  btimeOf,
  execText,
  killGroup,
  linuxStartTimes,
  macStartTimes,
  parseLstart,
  procStartMs,
  realLinuxProcFs,
  spawnDetached,
  type LinuxProcFs,
  type Signals
} from './posixProc'

/** A /proc/<pid>/stat line: fields 3 to 21 are filler, field 22 is the start time in ticks. */
const stat = (comm: string, starttime: number): string => {
  const after = ['S', ...Array.from({ length: 18 }, (_, i) => String(i + 4)), String(starttime), '999', '888']
  return `4242 (${comm}) ${after.join(' ')}\n`
}

describe('procStartMs', () => {
  it('reads field 22 as ticks after boot and adds btime', () => {
    expect(procStartMs(stat('Xvfb', 12_345), 1_700_000_000, 100)).toBe(1_700_000_000_000 + 123_450)
  })

  it('finds the fields after the last parenthesis, whatever the command name holds (Review Focus 2)', () => {
    expect(procStartMs(stat('Web Content', 500), 10, 100)).toBe(15_000)
    expect(procStartMs(stat('a) (b', 500), 10, 100)).toBe(15_000)
    expect(procStartMs(stat('électron 앱', 500), 10, 250)).toBe(12_000)
  })

  it('reads nothing from a line that is not a stat line', () => {
    expect(procStartMs('garbage', 10, 100)).toBeNull()
    expect(procStartMs('1 (x) S 2', 10, 100)).toBeNull()
  })
})

describe('btimeOf', () => {
  it('reads the boot time line of /proc/stat', () => {
    expect(btimeOf('cpu 1 2 3\nbtime 1700000000\nprocesses 5\n')).toBe(1_700_000_000)
    expect(btimeOf('cpu 1 2 3\n')).toBeNull()
  })
})

describe('linuxStartTimes', () => {
  const procFs = (files: Record<string, string>): LinuxProcFs & { reads: string[] } => {
    const reads: string[] = []
    return {
      reads,
      readFile: async (p) => {
        reads.push(p)
        if (!(p in files)) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' })
        return files[p]
      },
      ticksPerSec: async () => 100
    }
  }

  it('reads each live pid and leaves a gone one out', async () => {
    const f = procFs({ '/proc/stat': 'btime 1000\n', '/proc/7/stat': stat('sh', 250) })
    expect([...(await linuxStartTimes([7, 8], f)).entries()]).toEqual([[7, 1_002_500]])
  })

  it('reads nothing for no pids, and refuses a /proc/stat with no boot time', async () => {
    const f = procFs({ '/proc/stat': 'cpu 1\n' })
    expect((await linuxStartTimes([], f)).size).toBe(0)
    expect(f.reads).toEqual([])
    await expect(linuxStartTimes([7], f)).rejects.toThrow('no btime')
  })
})

describe('parseLstart', () => {
  it('reads ps lstart under LC_ALL=C, a one digit day padded with a space, as local time (Review Focus 5)', () => {
    expect(parseLstart('Sat Sep 27 10:11:12 2026')).toBe(new Date(2026, 8, 27, 10, 11, 12).getTime())
    expect(parseLstart('Mon Sep  7 01:02:03 2026\n')).toBe(new Date(2026, 8, 7, 1, 2, 3).getTime())
    expect(parseLstart('sam 27 sep 10:11:12 2026')).toBeNull()
    expect(parseLstart('')).toBeNull()
  })
})

describe('macStartTimes', () => {
  it('asks ps once, under LC_ALL=C, for every pid', async () => {
    const exec = vi.fn(async () => '  100 Sat Sep 27 10:11:12 2026\n  200 Mon Sep  7 01:02:03 2026\n')
    const r = await macStartTimes([100, 200], exec)
    expect([...r.entries()]).toEqual([
      [100, new Date(2026, 8, 27, 10, 11, 12).getTime()],
      [200, new Date(2026, 8, 7, 1, 2, 3).getTime()]
    ])
    expect(exec).toHaveBeenCalledWith('env', ['LC_ALL=C', 'ps', '-o', 'pid=,lstart=', '-p', '100,200'])
  })

  it('still reads the pids ps listed when it exits 1 for a gone one', async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error('Command failed'), { code: 1, stdout: '  100 Sat Sep 27 10:11:12 2026\n' })
    })
    expect([...(await macStartTimes([100, 300], exec)).keys()]).toEqual([100])
  })
})

describe('killGroup', () => {
  const fakeSignals = (o: { leader?: boolean; diesOnTerm?: boolean; gone?: boolean; eperm?: boolean } = {}) => {
    const sent: Array<[number, NodeJS.Signals | 0]> = []
    let alive = o.gone !== true
    const fail = (code: string): never => {
      throw Object.assign(new Error(`kill ${code}`), { code })
    }
    const s: Signals = {
      kill: (pid, sig) => {
        sent.push([pid, sig])
        if (o.eperm) fail('EPERM')
        if (!alive) fail('ESRCH')
        if (pid < 0 && o.leader === false) fail('ESRCH')
        if (sig === 'SIGTERM' && o.diesOnTerm !== false) alive = false
        if (sig === 'SIGKILL') alive = false
      },
      sleep: async () => {}
    }
    return { s, sent }
  }

  it('sends SIGTERM to the group and stops once it is gone', async () => {
    const f = fakeSignals()
    await killGroup(4242, f.s)
    expect(f.sent).toEqual([[-4242, 'SIGTERM'], [-4242, 0]])
  })

  it('sends SIGKILL once the grace has passed and the group is still there', async () => {
    const f = fakeSignals({ diesOnTerm: false })
    await killGroup(4242, f.s, 300)
    expect(f.sent).toEqual([[-4242, 'SIGTERM'], [-4242, 0], [-4242, 0], [-4242, 0], [-4242, 'SIGKILL']])
  })

  it('signals the pid alone when it leads no group', async () => {
    const f = fakeSignals({ leader: false })
    await killGroup(4242, f.s)
    expect(f.sent).toEqual([[-4242, 'SIGTERM'], [4242, 'SIGTERM'], [4242, 0]])
  })

  it('a group already gone is not a failure', async () => {
    const f = fakeSignals({ gone: true })
    await expect(killGroup(4242, f.s)).resolves.toBeUndefined()
    expect(f.sent).toEqual([[-4242, 'SIGTERM'], [4242, 'SIGTERM']])
  })

  it('passes on a failure that is not ESRCH', async () => {
    await expect(killGroup(4242, fakeSignals({ eperm: true }).s)).rejects.toThrow('EPERM')
  })

  it("never signals pid 0, 1 or a negative number, which would reach the Host's own group or every process (Review Focus 3)", async () => {
    const f = fakeSignals()
    for (const pid of [0, 1, -1, -4242, 1.5, Number.NaN]) await expect(killGroup(pid, f.s)).rejects.toThrow('not a pid')
    expect(f.sent).toEqual([])
  })
})

describe.runIf(process.platform !== 'win32')('spawnDetached, killGroup and the start times on this machine', () => {
  it('starts a group leader and ends its whole group, the background child included', async () => {
    const p = spawnDetached('sh', ['-c', 'sleep 30 & sleep 30'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })
    expect(p.pid).toBeGreaterThan(1)
    const exited = new Promise<string>((r) => p.onExit(r))
    await killGroup(p.pid!)
    expect(await exited).toMatch(/SIGTERM|exited/)
    expect(() => process.kill(-p.pid!, 0)).toThrow()
  })

  it('reports a spawn that cannot start as an exit, never as an unhandled error', async () => {
    const p = spawnDetached('astera-no-such-program', [], { env: {} })
    expect(await new Promise<string>((r) => p.onExit(r))).toContain('could not start')
  })

  it("reads this process's own start time within a few seconds of what Node says", async () => {
    const t =
      process.platform === 'linux'
        ? (await linuxStartTimes([process.pid], realLinuxProcFs(execText))).get(process.pid)
        : (await macStartTimes([process.pid], execText)).get(process.pid)
    expect(Math.abs(t! - (Date.now() - process.uptime() * 1000))).toBeLessThan(3_000)
  })
})
