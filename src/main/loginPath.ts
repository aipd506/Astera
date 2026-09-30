// PATH recovery for the GUI app on macOS and Linux.
//
// A .app launched from Finder (or the Dock, or LaunchServices) never goes through a login shell, so
// it only gets launchd's default PATH (/usr/bin:/bin:/usr/sbin:/sbin). Everything this app spawns is
// a tool the user installed themselves — claude (~/.local/bin), codex (npm global), git (Xcode CLT or
// homebrew), node, gradle. Without recovery, session creation fails outright.
//
// Linux has the same gap for the same reason: an app started from a .desktop entry inherits the
// systemd user-session environment and never sources ~/.bashrc or ~/.zshrc (and on Wayland often not
// ~/.profile either), so nvm's shims and ~/.local/bin are missing. Launched from a terminal it works
// by accident — the parent shell's PATH is inherited — which is why the deb/AppImage install path is
// the one that breaks. Windows has no shell to ask: PATH there is a machine/user environment variable,
// read from where Windows keeps it (windowsPathProbe), because a process can inherit a copy that is
// older than that.
//
// Why process.env.PATH is patched directly: session env is built by SessionManager.spawn as
// { ...process.env } (core/sessions/manager.ts), main/terminalManager.ts's onPath (resolveShell's
// default exists implementation) reads process.env.PATH directly, and jdkScanner and git spawn do
// the same.
// Fixing one place carries through everywhere.
//
// Why an actual login shell gets run: PATH can be assembled from any of .zshrc/.zprofile/.bash_profile,
// and homebrew/mise/asdf/nvm all evaluate shellenv from within an rc file. Statically listing candidate
// directories would miss every one of them.
import { execFile } from 'node:child_process'

/** Wraps the value in markers to separate PATH from whatever banners/warnings the rc file prints. */
const START = '__ASTERA_PATH__'
const END = '__END__'
const PROBE = `printf '%s%s%s' '${START}' "$PATH" '${END}'`

/** Keeps startup from stalling if the rc file hangs forever (e.g. a prompt waiting for input). */
const PROBE_TIMEOUT_MS = 5_000

/** Extracts just PATH from the probe output. Returns null if the markers are missing or empty in between. */
export function parseLoginPath(stdout: string): string | null {
  const start = stdout.indexOf(START)
  if (start === -1) return null
  const from = start + START.length
  const end = stdout.indexOf(END, from)
  if (end === -1) return null
  const value = stdout.slice(from, end).trim()
  return value === '' ? null : value
}

/**
 * Puts the login PATH first, with the rest of the existing PATH's unique entries after it.
 *
 * Why merge instead of replace: some entries launchd added may not be in the login shell (an MDM
 * profile on a managed Mac, for instance), and losing those would go unnoticed. Why login PATH goes
 * first: whatever order the user set in their rc file (e.g. homebrew ahead of /usr/bin) is that
 * user's intent.
 */
export function mergePath(current: string | undefined, loginPath: string | null): string | undefined {
  if (loginPath === null) return current
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of [...loginPath.split(':'), ...(current ?? '').split(':')]) {
    if (part === '' || seen.has(part)) continue
    seen.add(part)
    out.push(part)
  }
  return out.length > 0 ? out.join(':') : current
}

/**
 * The shell to probe. SHELL being empty is rare, but if it is, fall back to the platform's default:
 * zsh is macOS's login shell, and /bin/sh is the only shell POSIX guarantees exists on Linux (naming
 * bash would break a musl/dash-only image). Both accept -ilc.
 */
export function probeShell(platform: NodeJS.Platform, shell: string | undefined): string {
  return shell || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
}

/**
 * win32: the Path Windows keeps, Machine then User, the way a freshly started process gets it.
 *
 * **A GUI process does not always get that.** It gets a copy of whoever started it, and the 1.4.0
 * update showed where that goes wrong (2026-09-30): the installer relaunched the app with the old
 * app's environment, copied before Codex had put its folder on the user Path, and the app said codex
 * was not installed. Until then it went unnoticed because the CLIs were started through cmd.exe;
 * since they are started from where this process's PATH says they are (windowsExecutable.ts), a stale
 * copy means a missing CLI. Windows PowerShell by its absolute path, and UTF-8 out, so a folder with
 * non-ASCII letters survives.
 */
const windowsPathProbe = (): { file: string; args: string[] } => ({
  file: `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
  args: [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write('${START}' + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + '${END}')`
  ]
})

/** One win32 Path entry as a folder to compare: case folded, trailing separators and quotes off. */
const windowsFolderKey = (entry: string): string =>
  entry
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/[\\/]+$/, '')
    .toLowerCase()

/**
 * The inherited win32 PATH with every folder of the saved one it lacks appended, in the saved order.
 * **Appended, not put first**: whatever started this process may have put something in front on
 * purpose, and that stays where it was. The inherited string is kept as it is when nothing is new.
 */
export function mergeWindowsPath(current: string | undefined, saved: string | null): string | undefined {
  if (saved === null) return current
  const have = new Set((current ?? '').split(';').filter((e) => e.trim() !== '').map(windowsFolderKey))
  const added: string[] = []
  for (const e of saved.split(';')) {
    if (e.trim() === '') continue
    const key = windowsFolderKey(e)
    if (have.has(key)) continue
    have.add(key)
    added.push(e.trim())
  }
  if (added.length === 0) return current
  const kept = (current ?? '').replace(/;+$/, '')
  return kept === '' ? added.join(';') : `${kept};${added.join(';')}`
}

/** Asks the login shell for PATH, or on win32 the Path Windows keeps (see windowsPathProbe). */
export async function readLoginPath(opts: {
  platform: NodeJS.Platform
  shell: string | undefined
  run: (file: string, args: string[]) => Promise<string>
}): Promise<string | null> {
  if (opts.platform === 'win32') {
    const probe = windowsPathProbe()
    try {
      return parseLoginPath(await opts.run(probe.file, probe.args))
    } catch {
      return null // the inherited PATH then, as before
    }
  }
  const shell = probeShell(opts.platform, opts.shell)
  try {
    // Why -i (interactive) is included: version managers like nvm/mise only initialize in an rc file
    // (.zshrc, .bashrc), and an rc file is often not read by non-interactive shells.
    return parseLoginPath(await opts.run(shell, ['-ilc', PROBE]))
  } catch {
    return null // A probe failure must not block app startup
  }
}

function runShell(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', windowsHide: true }, (err, stdout) => {
      // Treated as success if stdout has the markers even when the exit code is nonzero — it's
      // common for the rc file's last command to fail and leave the shell exiting non-zero.
      if (err && !stdout) reject(err)
      else resolve(stdout)
    })
  })
}

/** Updates process.env.PATH from the login shell's PATH, or on win32 from the Path Windows keeps. */
export async function applyLoginPath(log: (m: string) => void): Promise<void> {
  const before = process.env.PATH
  const loginPath = await readLoginPath({
    platform: process.platform,
    shell: process.env.SHELL,
    run: runShell
  })
  if (loginPath === null) {
    log('loginPath: probe failed, keeping the inherited PATH')
    return
  }
  const win = process.platform === 'win32'
  const merged = win ? mergeWindowsPath(before, loginPath) : mergePath(before, loginPath)
  if (merged && merged !== before) {
    process.env.PATH = merged
    log(
      win
        ? 'loginPath: PATH completed from the Path Windows keeps (this process was started with an older copy)'
        : `loginPath: PATH restored from ${probeShell(process.platform, process.env.SHELL)}`
    )
  }
}
