/** Interactive shell resolution. Pure function — the file-existence check is injected as exists to keep it testable. */
export interface ShellSpawn {
  file: string
  args: string[]
}

// win32 candidate order: PS7 → PS5 → cmd. The earlier ones are better to develop with, so they win.
const WIN_CANDIDATES = ['pwsh.exe', 'powershell.exe', 'cmd.exe']

/**
 * Decides which shell to launch from platform and exists (whether it is on PATH).
 * win32: takes the first of WIN_CANDIDATES that exists, and returns cmd.exe as the fallback when none do
 * (if even that fails to spawn, the caller raises the exception up to the renderer).
 * Otherwise: envShell (the caller passes process.env.SHELL) or /bin/sh.
 */
export function resolveShell(
  platform: NodeJS.Platform,
  exists: (file: string) => boolean,
  envShell?: string
): ShellSpawn {
  if (platform === 'win32') {
    return { file: WIN_CANDIDATES.find(exists) ?? 'cmd.exe', args: [] }
  }
  return { file: envShell || '/bin/sh', args: [] }
}

/**
 * resolveShell over an async lookup that says **where** a candidate is: on win32 every candidate is
 * looked for at once — each lookup walks PATH, and one PATH entry on an offline drive must not be paid
 * for three times in a row — and then the same order decides. The answer is the absolute path the
 * lookup found, or `fallback` when none was found: a bare name would make node-pty walk PATH again
 * itself, synchronously, on the spawning thread (conpty.cc). Off win32 nothing is looked for, exactly
 * as resolveShell does.
 */
export async function resolveShellAsync(
  platform: NodeJS.Platform,
  locate: (file: string) => Promise<string | null>,
  envShell?: string,
  fallback = 'cmd.exe'
): Promise<ShellSpawn> {
  if (platform !== 'win32') return resolveShell(platform, () => false, envShell)
  const found = await Promise.all(WIN_CANDIDATES.map((f) => locate(f)))
  return { file: found.find((f): f is string => typeof f === 'string' && f !== '') ?? fallback, args: [] }
}
