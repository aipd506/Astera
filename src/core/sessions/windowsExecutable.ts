// Where a command actually is on Windows, looked up on PATH and nowhere else (security review
// 2026-09-28, CWE-427).
//
// The CLIs were spawned as `cmd.exe /c claude …` with the project folder as the working directory,
// and cmd.exe looks a bare name up in its current directory before it looks at PATH. A repository
// shipping a `claude.cmd` therefore ran it the moment its folder was picked in the New Session
// dialog (`system.checkCli` runs `claude --version` there) and again in place of the real CLI when a
// session started, before Claude Code's own trust prompt. git and gh were spawned by name too, and
// libuv's lookup has the same order. sh never searches the working directory, so this is win32 only.
//
// `findOnWindowsPath` walks the absolute entries of PATH with the executable extensions cmd.exe
// itself would try, and `windowsSpawn` turns a bare name into something the working directory cannot
// redirect: an .exe or .com is spawned directly, a .cmd or .bat goes through `cmd.exe /d /c call
// "<absolute path>"` (the path carries a separator, so cmd.exe does not search for it; `call` keeps a
// quoted path with spaces from tripping cmd.exe's /c quote stripping; `/d` skips AutoRun), and a
// name PATH does not know is spawned bare with no shell at all, which CreateProcess resolves from the
// parent's own folders rather than the child's cwd — and which simply fails when it is not there.
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { SpawnCommand } from './commands'

/** The extensions cmd.exe tries for a bare name, in PATHEXT's default order. PATHEXT is honoured
 *  for the order, but only these four are executables a CLI ships as. */
const EXECUTABLE_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd']

export function findOnWindowsPath(
  name: string,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean = existsSync
): string | null {
  // A name that already carries a path is not looked up: that is a path, and it is the caller's.
  if (/[\\/]/.test(name)) return path.win32.isAbsolute(name) && exists(name) ? name : null
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  const entries = (pathKey ? env[pathKey] ?? '' : '')
    .split(';')
    .map((e) => e.trim().replace(/^"(.*)"$/, '$1'))
    // A relative entry (`.` and the like) is the working directory in disguise: skipped.
    .filter((e) => e !== '' && path.win32.isAbsolute(e))
  const pathext = (env['PATHEXT'] ?? env['Pathext'] ?? '')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => EXECUTABLE_EXTENSIONS.includes(e))
  const exts = pathext.length > 0 ? pathext : EXECUTABLE_EXTENSIONS
  const hasExt = EXECUTABLE_EXTENSIONS.includes(path.win32.extname(name).toLowerCase())
  for (const dir of entries) {
    if (hasExt) {
      const p = path.win32.join(dir, name)
      if (exists(p)) return p
      continue
    }
    for (const ext of exts) {
      const p = path.win32.join(dir, name + ext)
      if (exists(p)) return p
    }
  }
  return null
}

/** PATH lookup against this process's environment, on win32; null everywhere else (a posix spawn
 *  by name is PATH-only already). */
export function resolveWindowsExecutable(name: string): string | null {
  return process.platform === 'win32' ? findOnWindowsPath(name, process.env) : null
}

/** The file to hand child_process for a tool spawned by name with a repository as its cwd: on win32
 *  the absolute path PATH names (or the bare name when PATH does not know it — CreateProcess then
 *  resolves it from the parent's folders and fails otherwise), elsewhere the name itself. Cached per
 *  PATH value, so a PATH the app extends after an install is looked at again. */
export function windowsExecutable(name: string): string {
  if (process.platform !== 'win32') return name
  const pathNow = process.env.PATH ?? process.env.Path ?? ''
  const hit = executableCache.get(name)
  if (hit && hit.path === pathNow) return hit.file
  const file = findOnWindowsPath(name, process.env) ?? name
  executableCache.set(name, { path: pathNow, file })
  return file
}
const executableCache = new Map<string, { path: string; file: string }>()

/** How to spawn `name args…` on win32 without the working directory taking part in the lookup. */
export function windowsSpawn(
  name: string,
  args: string[],
  resolve: (name: string) => string | null = resolveWindowsExecutable
): SpawnCommand {
  const found = resolve(name)
  if (found === null) return { file: name, args }
  const ext = path.win32.extname(found).toLowerCase()
  if (ext === '.exe' || ext === '.com') return { file: found, args }
  return { file: 'cmd.exe', args: ['/d', '/c', 'call', found, ...args] }
}
