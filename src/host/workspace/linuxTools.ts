// Which of the Linux desk's three programs are missing (Linux and macOS design, L1; R8): each is looked
// for in every absolute PATH folder, with no `which` process, and the install line is chosen from
// /etc/os-release. Asked on every `app js`, so a tool installed while the Host runs counts at once.
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { LINUX_TOOLS, linuxInstallLine, type LinuxTool, type LinuxTools } from '../../core/workspace/platform'

export interface ProbeDeps {
  pathEnv: string | undefined
  executable(p: string): Promise<boolean>
  readFile(p: string): Promise<string>
}

export async function probeLinuxTools(d: ProbeDeps): Promise<LinuxTools> {
  const dirs = (d.pathEnv ?? '').split(':').filter((dir) => dir !== '' && path.posix.isAbsolute(dir))
  const missing: LinuxTool[] = []
  for (const tool of LINUX_TOOLS) {
    let found = false
    for (const dir of dirs) {
      if (await d.executable(path.posix.join(dir, tool))) {
        found = true
        break
      }
    }
    if (!found) missing.push(tool)
  }
  if (missing.length === 0) return { missing, installLine: '' }
  const osRelease = await d
    .readFile('/etc/os-release')
    .catch(() => d.readFile('/usr/lib/os-release'))
    .catch(() => '')
  return { missing, installLine: linuxInstallLine(osRelease, missing) }
}

export function realProbeDeps(env: Record<string, string | undefined>): ProbeDeps {
  return {
    pathEnv: env.PATH,
    executable: (p) => fs.access(p, constants.X_OK).then(() => true, () => false),
    readFile: (p) => fs.readFile(p, 'utf8')
  }
}
