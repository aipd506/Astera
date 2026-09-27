import { describe, it, expect } from 'vitest'
import { createGitBashResolver, findGitBash, findGitBashAsync } from './gitBash'
import { PROBE_DEGRADED_TTL_MS, PathKeyedCache, type ProbeResult } from './pathProbe'

/** A probe that says yes only for the listed absolute paths. */
const only = (...paths: string[]) => (p: string): boolean => paths.includes(p)

describe('findGitBash', () => {
  it('keeps a value the user already set, without probing', () => {
    let probed = 0
    const found = findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: 'E:/git/bin/bash.exe' }, () => {
      probed++
      return true
    })
    expect(found).toBeNull() // null means "nothing to add"
    expect(probed).toBe(0)
  })

  it('finds bash next to the git on PATH', () => {
    const env = { PATH: 'C:\\Windows\\System32;E:\\programs\\Git\\cmd' }
    expect(findGitBash(env, only('E:\\programs\\Git\\cmd\\git.exe', 'E:\\programs\\Git\\bin\\bash.exe'))).toBe(
      'E:\\programs\\Git\\bin\\bash.exe'
    )
  })

  it('accepts a PATH entry that is already the bin directory', () => {
    const env = { PATH: 'E:\\programs\\Git\\bin' }
    expect(findGitBash(env, only('E:\\programs\\Git\\bin\\bash.exe'))).toBe('E:\\programs\\Git\\bin\\bash.exe')
  })

  it('falls back to the usual install roots', () => {
    expect(findGitBash({ PATH: 'C:\\Windows\\System32' }, only('C:\\Program Files\\Git\\bin\\bash.exe'))).toBe(
      'C:\\Program Files\\Git\\bin\\bash.exe'
    )
  })

  // P1 carry-over 4: a Cygwin or MSYS2 bash earlier on PATH is not Git Bash, and handing it over breaks
  // the hooks in a different way. Git for Windows is looked for first; a plain bash on PATH comes after.
  it('prefers the Git whose cmd\\git.exe is on PATH over a Cygwin bash earlier on PATH', () => {
    const env = { PATH: 'C:\\cygwin64\\bin;E:\\programs\\Git\\cmd' }
    const fs = only('C:\\cygwin64\\bin\\bash.exe', 'E:\\programs\\Git\\cmd\\git.exe', 'E:\\programs\\Git\\bin\\bash.exe')
    expect(findGitBash(env, fs)).toBe('E:\\programs\\Git\\bin\\bash.exe')
  })

  it('prefers the Git whose bin\\git.exe is on PATH over an MSYS2 bash earlier on PATH', () => {
    const env = { PATH: 'C:\\msys64\\usr\\bin;E:\\programs\\Git\\bin' }
    const fs = only('C:\\msys64\\usr\\bin\\bash.exe', 'E:\\programs\\Git\\bin\\git.exe', 'E:\\programs\\Git\\bin\\bash.exe')
    expect(findGitBash(env, fs)).toBe('E:\\programs\\Git\\bin\\bash.exe')
  })

  it('prefers Program Files\\Git over a Cygwin or MSYS2 bash on PATH', () => {
    const env = { PATH: 'C:\\msys64\\usr\\bin;C:\\cygwin64\\bin' }
    const fs = only('C:\\msys64\\usr\\bin\\bash.exe', 'C:\\cygwin64\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe')
    expect(findGitBash(env, fs)).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  })

  it('takes a plain bash on PATH only when no Git for Windows is found, and never a sibling guessed from it', () => {
    // A bash beside no git.exe is not taken as a Git install root: E:\tools\bin\bash.exe is not looked for
    // from E:\tools\cmd, which was the old guess.
    expect(findGitBash({ PATH: 'E:\\tools\\cmd;C:\\cygwin64\\bin' }, only('E:\\tools\\bin\\bash.exe', 'C:\\cygwin64\\bin\\bash.exe'))).toBe(
      'C:\\cygwin64\\bin\\bash.exe'
    )
  })

  it('never returns the WSL bash in System32', () => {
    const env = { PATH: 'C:\\Windows\\System32' }
    expect(findGitBash(env, only('C:\\Windows\\System32\\bash.exe'))).toBeNull()
  })

  it('never returns the WSL bash in WindowsApps either', () => {
    const env = { PATH: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps' }
    expect(findGitBash(env, only('C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe'))).toBeNull()
  })

  it('returns null when no Git Bash exists', () => {
    expect(findGitBash({ PATH: 'C:\\Windows\\System32' }, () => false)).toBeNull()
  })

  it('reads PATH whatever its case, and tolerates an absent PATH', () => {
    expect(findGitBash({ Path: 'E:\\programs\\Git\\cmd' }, only('E:\\programs\\Git\\cmd\\git.exe', 'E:\\programs\\Git\\bin\\bash.exe'))).toBe(
      'E:\\programs\\Git\\bin\\bash.exe'
    )
    expect(findGitBash({}, () => true)).toBeNull()
  })
})

/** The async twin of `only`: present for the listed paths, absent for the rest. */
const onlyAsync =
  (...paths: string[]) =>
  async (p: string): Promise<ProbeResult> =>
    paths.includes(p) ? 'present' : 'absent'

describe('findGitBashAsync', () => {
  // The same fixtures the sync search is pinned by: with everything reachable, the answer must not move.
  const cases: { name: string; env: Record<string, string>; present: string[] }[] = [
    { name: 'git on PATH', env: { PATH: 'C:\\Windows\\System32;E:\\programs\\Git\\cmd' }, present: ['E:\\programs\\Git\\cmd\\git.exe', 'E:\\programs\\Git\\bin\\bash.exe'] },
    { name: 'bin entry', env: { PATH: 'E:\\programs\\Git\\bin' }, present: ['E:\\programs\\Git\\bin\\bash.exe'] },
    { name: 'install root', env: { PATH: 'C:\\Windows\\System32' }, present: ['C:\\Program Files\\Git\\bin\\bash.exe'] },
    {
      name: 'Git before an earlier Cygwin bash',
      env: { PATH: 'C:\\cygwin64\\bin;E:\\programs\\Git\\cmd' },
      present: ['C:\\cygwin64\\bin\\bash.exe', 'E:\\programs\\Git\\cmd\\git.exe', 'E:\\programs\\Git\\bin\\bash.exe']
    },
    { name: 'plain bash last', env: { PATH: 'C:\\cygwin64\\bin' }, present: ['C:\\cygwin64\\bin\\bash.exe'] },
    {
      name: 'WSL launchers skipped',
      env: { PATH: 'C:\\Windows\\System32;C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps' },
      present: ['C:\\Windows\\System32\\bash.exe', 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe']
    },
    { name: 'nothing', env: { PATH: 'C:\\nothing' }, present: [] }
  ]
  for (const c of cases) {
    it(`answers what the sync search answers: ${c.name}`, async () => {
      expect(await findGitBashAsync(c.env, onlyAsync(...c.present))).toBe(findGitBash(c.env, only(...c.present)))
    })
  }

  it('keeps a value the user already set, without probing', async () => {
    let probed = 0
    const found = await findGitBashAsync({ CLAUDE_CODE_GIT_BASH_PATH: 'E:/x', PATH: 'C:\\a' }, async () => {
      probed++
      return 'present'
    })
    expect(found).toBeNull()
    expect(probed).toBe(0)
  })

  it('starts every probe before any has answered, and never probes a WSL launcher', async () => {
    const asked: string[] = []
    const gates: (() => void)[] = []
    const probe = (p: string) => {
      asked.push(p)
      return new Promise<ProbeResult>((res) => gates.push(() => res('absent')))
    }
    const env = { PATH: 'Z:\\offline\\bin;C:\\Windows\\System32;E:\\Git\\cmd' }
    const pending = findGitBashAsync(env, probe)
    await Promise.resolve()
    expect(asked).toHaveLength(gates.length)
    expect(asked).toContain('Z:\\offline\\bin\\git.exe')
    expect(asked).toContain('E:\\Git\\cmd\\git.exe')
    expect(asked).toContain('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(asked).toContain('Z:\\offline\\bin\\bash.exe')
    expect(asked.some((p) => /system32\\bash\.exe$/i.test(p))).toBe(false)
    gates.forEach((g) => g())
    expect(await pending).toBeNull()
  })

  it('a PATH entry that times out counts as absent and the search goes on past it', async () => {
    const env = { PATH: 'Z:\\offline\\bin;E:\\Git\\cmd' }
    const probe = async (p: string): Promise<ProbeResult> =>
      p.startsWith('Z:') ? 'timeout' : ['E:\\Git\\cmd\\git.exe', 'E:\\Git\\bin\\bash.exe'].includes(p) ? 'present' : 'absent'
    expect(await findGitBashAsync(env, probe)).toBe('E:\\Git\\bin\\bash.exe')
  })
})

describe('createGitBashResolver', () => {
  it('probes once per PATH string: the second spawn is a cache hit and costs no probe', async () => {
    let probes = 0
    const probe = async (p: string): Promise<ProbeResult> => {
      probes++
      return p === 'C:\\Program Files\\Git\\bin\\bash.exe' ? 'present' : 'absent'
    }
    const r = createGitBashResolver(probe)
    const env = { PATH: 'Z:\\offline;C:\\a' }
    expect(r.peek(env)).toBeUndefined()
    expect(await r.resolve(env)).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    const first = probes
    expect(await r.resolve({ ...env })).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(probes).toBe(first)
    expect(r.peek(env)).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  })

  it('keeps a search that a timeout went into for PROBE_DEGRADED_TTL_MS only, not five minutes', async () => {
    let t = 0
    let probes = 0
    const r = createGitBashResolver(
      async (p) => {
        probes++
        return p.startsWith('Z:') ? 'timeout' : 'absent'
      },
      new PathKeyedCache(undefined, () => t)
    )
    const env = { PATH: 'Z:\\off;C:\\a' }
    await r.resolve(env)
    const first = probes
    t += PROBE_DEGRADED_TTL_MS - 1
    await r.resolve(env)
    expect(probes).toBe(first)
    t += 1
    await r.resolve(env)
    expect(probes).toBeGreaterThan(first)
  })

  it('keeps a clean search for the full cache time', async () => {
    let t = 0
    let probes = 0
    const r = createGitBashResolver(
      async () => {
        probes++
        return 'absent'
      },
      new PathKeyedCache(undefined, () => t)
    )
    await r.resolve({ PATH: 'C:\\a' })
    const first = probes
    t += PROBE_DEGRADED_TTL_MS * 10
    await r.resolve({ PATH: 'C:\\a' })
    expect(probes).toBe(first)
  })

  it('probes again when the PATH string changes', async () => {
    let probes = 0
    const r = createGitBashResolver(async () => {
      probes++
      return 'absent'
    })
    await r.resolve({ PATH: 'C:\\a' })
    const first = probes
    await r.resolve({ Path: 'C:\\b' })
    expect(probes).toBeGreaterThan(first)
    expect(r.peek({ PATH: 'C:\\a' })).toBeUndefined()
    expect(r.peek({ Path: 'C:\\b' })).toBeNull()
  })

  it('answers null for a user-set value, in peek too, without probing or caching', async () => {
    let probes = 0
    const r = createGitBashResolver(async () => {
      probes++
      return 'present'
    })
    const env = { PATH: 'C:\\a', CLAUDE_CODE_GIT_BASH_PATH: 'E:/x' }
    expect(r.peek(env)).toBeNull()
    expect(await r.resolve(env)).toBeNull()
    expect(probes).toBe(0)
  })
})
