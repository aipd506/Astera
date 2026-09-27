// Claude Code runs hooks and the statusLine command through bash, and finds it by
// CLAUDE_CODE_GIT_BASH_PATH or its own search. When Git is installed off the standard path the
// search fails ("requires bash but Git Bash was not found"), the statusLine capture never runs, and
// the app never learns the session id or the usage figures that come with it — which disables the
// native-session leg of Job Continuity recovery and the usage gate of account rolling. So the app
// looks for a real Git Bash itself and hands the path to every session it spawns.
//
// Pure: the filesystem arrives as `probe`, the environment as `env`. Windows-shaped, because that is
// where the problem is; on other platforms the probe simply finds nothing and null is returned.
// win32 semantics on purpose, on every host: CLAUDE_CODE_GIT_BASH_PATH is a Windows-only concept, so
// the separators and the delimiter this parses are Windows' ones wherever the tests happen to run.
// The plain 'node:path' takes the host's semantics, which turned these tests red on the macOS and
// Linux legs of the CI matrix while passing on a Windows developer machine.
import { win32 as path } from 'node:path'
import { PROBE_CACHE_TTL_MS, PROBE_DEGRADED_TTL_MS, PathKeyedCache, type ProbeResult } from './pathProbe'

/** Where a Git for Windows install keeps the bash that hooks need, relative to the install root. */
const BIN_BASH = path.join('bin', 'bash.exe')
const ROOTS = ['C:\\Program Files\\Git', 'C:\\Program Files (x86)\\Git']

/** `System32\bash.exe` and the Store alias `WindowsApps\bash.exe` are WSL launchers, not Git Bash: handing
 *  either over makes the hook fail differently rather than work. Recognized by folder name, case-insensitively. */
const isWslBash = (p: string): boolean => /[\\/](system32|windowsapps)[\\/]bash\.exe$/i.test(p)

function pathEntries(env: Record<string, string | undefined>): string[] {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  const value = key ? env[key] : undefined
  return value ? value.split(path.delimiter).filter((s) => s !== '') : []
}

/** The install root of the Git for Windows whose git.exe sits in this PATH entry, or null. Git for Windows
 *  puts `<root>\cmd` (or, when asked, `<root>\bin`) on PATH, and both hold a git.exe. */
function gitRootOf(entry: string, probe: (p: string) => boolean): string | null {
  const dir = path.basename(entry).toLowerCase()
  if (dir !== 'cmd' && dir !== 'bin') return null
  return probe(path.join(entry, 'git.exe')) ? path.dirname(entry) : null
}

/**
 * The Git Bash to hand to a spawned agent, or null when there is nothing to add — either the user
 * already set `CLAUDE_CODE_GIT_BASH_PATH` (never overwritten: their choice wins) or no real Git Bash
 * could be found (better to leave the CLI's own error than to point it at the wrong binary).
 *
 * **Git for Windows first, then any bash on PATH** (P1 carry-over 4). A Cygwin or MSYS2 bash earlier on
 * PATH is a bash, not Git Bash, and the hooks fail differently with it. So the order is: the install
 * whose git.exe is on PATH (`<root>\cmd\git.exe` or `<root>\bin\git.exe`, giving `<root>\bin\bash.exe`),
 * then the Program Files installs, and only then a plain `bash.exe` in a PATH entry.
 */
export function findGitBash(
  env: Record<string, string | undefined>,
  probe: (p: string) => boolean
): string | null {
  if (env.CLAUDE_CODE_GIT_BASH_PATH) return null
  // Check if PATH key exists in environment (case-insensitive)
  const hasPath = Object.keys(env).some((k) => k.toUpperCase() === 'PATH')
  const entries = pathEntries(env)
  const candidates: string[] = []
  for (const entry of entries) {
    const root = gitRootOf(entry, probe)
    if (root !== null) candidates.push(path.join(root, BIN_BASH))
  }
  // Only check standard roots if PATH was actually set in the environment
  if (hasPath) {
    for (const root of ROOTS) candidates.push(path.join(root, BIN_BASH))
  }
  for (const entry of entries) candidates.push(path.join(entry, 'bash.exe'))
  for (const c of candidates) {
    if (isWslBash(c)) continue
    if (probe(c)) return c
  }
  return null
}

/** Every path `findGitBash` could ask about for this env, WSL launchers left out: each PATH entry's
 *  git.exe and the bash beside its install root (for a `cmd` or `bin` entry), the install roots, and
 *  each PATH entry's own bash.exe. Knowing them up front is what lets them be probed together. */
function gitBashProbePaths(env: Record<string, string | undefined>): string[] {
  const hasPath = Object.keys(env).some((k) => k.toUpperCase() === 'PATH')
  const entries = pathEntries(env)
  const out: string[] = []
  for (const entry of entries) {
    const dir = path.basename(entry).toLowerCase()
    if (dir === 'cmd' || dir === 'bin') {
      out.push(path.join(entry, 'git.exe'), path.join(path.dirname(entry), BIN_BASH))
    }
  }
  if (hasPath) for (const root of ROOTS) out.push(path.join(root, BIN_BASH))
  for (const entry of entries) out.push(path.join(entry, 'bash.exe'))
  return [...new Set(out)].filter((p) => !isWslBash(p))
}

/**
 * `findGitBash` over an async probe: every candidate is probed at once (the probe's own limiter bounds
 * how many are in flight), then the same search runs over the answers, so the order it prefers — Git
 * for Windows, then a plain bash, never a WSL launcher — is exactly the sync one. A probe that timed out
 * counts as absent. Pure apart from `probe`.
 */
export async function findGitBashAsync(
  env: Record<string, string | undefined>,
  probe: (p: string) => Promise<ProbeResult>
): Promise<string | null> {
  return (await searchGitBash(env, probe)).bash
}

/** What one search found, and whether a timeout went into it — then an earlier candidate may have been
 *  missed, and the answer is kept only briefly (PROBE_DEGRADED_TTL_MS). */
export interface GitBashSearch {
  bash: string | null
  timedOut: boolean
}

async function searchGitBash(
  env: Record<string, string | undefined>,
  probe: (p: string) => Promise<ProbeResult>
): Promise<GitBashSearch> {
  if (env.CLAUDE_CODE_GIT_BASH_PATH) return { bash: null, timedOut: false }
  const paths = gitBashProbePaths(env)
  const results = await Promise.all(paths.map((p) => probe(p)))
  const present = new Set(paths.filter((_, i) => results[i] === 'present'))
  return { bash: findGitBash(env, (p) => present.has(p)), timedOut: results.includes('timeout') }
}

export interface GitBashResolver {
  /** The Git Bash for this env, probed at most once per PATH string while the cache holds it. */
  resolve(env: Record<string, string | undefined>): Promise<string | null>
  /** What `resolve` last found for this env's PATH string, if it is still fresh; undefined otherwise. */
  peek(env: Record<string, string | undefined>): string | null | undefined
}

const pathValueOf = (env: Record<string, string | undefined>): string => {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  return (key ? env[key] : undefined) ?? ''
}

/** A per-process cache over the async search, keyed by the PATH string: an offline drive on PATH costs
 *  its probe timeout once, not on every spawn. A search a timeout went into is kept for
 *  PROBE_DEGRADED_TTL_MS only, since the drive may come back and hold the preferred bash. A user-set
 *  CLAUDE_CODE_GIT_BASH_PATH is answered (null, nothing to add) without probing or caching. */
export function createGitBashResolver(
  probe: (p: string) => Promise<ProbeResult>,
  cache: PathKeyedCache<GitBashSearch> = new PathKeyedCache()
): GitBashResolver {
  const ttlOf = (r: GitBashSearch): number => (r.timedOut ? PROBE_DEGRADED_TTL_MS : PROBE_CACHE_TTL_MS)
  return {
    resolve: async (env) =>
      env.CLAUDE_CODE_GIT_BASH_PATH
        ? null
        : (await cache.get(pathValueOf(env), 'gitBash', () => searchGitBash(env, probe), ttlOf)).bash,
    peek: (env) => (env.CLAUDE_CODE_GIT_BASH_PATH ? null : cache.peek(pathValueOf(env), 'gitBash')?.bash)
  }
}
