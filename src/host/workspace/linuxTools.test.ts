import { describe, it, expect } from 'vitest'
import { probeLinuxTools, type ProbeDeps } from './linuxTools'

const deps = (have: string[], osRelease: string | null = 'ID=ubuntu\nID_LIKE=debian\n'): ProbeDeps & { seen: string[] } => {
  const seen: string[] = []
  return {
    seen,
    pathEnv: '/usr/local/bin:/usr/bin:relative/bin:',
    executable: async (p) => {
      seen.push(p)
      return have.includes(p)
    },
    readFile: async (p) => {
      if (osRelease === null || p !== '/etc/os-release') throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' })
      return osRelease
    }
  }
}

describe('probeLinuxTools', () => {
  it('finds each tool in any PATH folder and reports none missing', async () => {
    expect(await probeLinuxTools(deps(['/usr/bin/Xvfb', '/usr/local/bin/xdotool', '/usr/bin/import']))).toEqual({ missing: [], installLine: '' })
  })

  it('names what is missing and the install line for this distribution', async () => {
    expect(await probeLinuxTools(deps(['/usr/bin/Xvfb']))).toEqual({ missing: ['xdotool', 'import'], installLine: 'sudo apt-get install -y xdotool imagemagick' })
  })

  it("skips relative PATH entries, which would depend on the Host's folder", async () => {
    const d = deps([])
    await probeLinuxTools(d)
    expect(d.seen.length).toBe(6)
    expect(d.seen.every((p) => p.startsWith('/usr/'))).toBe(true)
  })

  it('gives the generic line when there is no os-release', async () => {
    expect((await probeLinuxTools(deps([], null))).installLine).toContain("with your distribution's package manager")
  })
})
