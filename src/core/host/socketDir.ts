// Whether the directory a posix Host socket sits in is private to this user — asked by the Host
// before it binds there (host/server.ts) and by every client before it connects there (main/host
// /client.ts, core/host/connect.ts). Design section 5 says access control is the operating system,
// and that only holds while the directory's own mode says so.
//
// **Both sides, not just the Host's.** On linux the parent is /tmp at 1777 and the address key is a
// hash of a guessable profile path, so another local user can make the directory first and put a
// socket of their own in it. The Host already refused to serve there; the app and the CLI did not
// check, connected to whatever answered, and handed it every terminal's environment and keystrokes
// (security review 2026-09-28). On macOS os.tmpdir() is the user's own 0700 folder and this never
// arises; on win32 the address is a named pipe and there is no directory to ask about.
import { promises as fs } from 'node:fs'
import path from 'node:path'

const PIPE_PREFIX = '\\\\.\\pipe\\'

/** Null when `st` is a directory owned by `uid` that nobody else can enter; otherwise why not. */
export function privateDirProblem(
  st: { isDirectory(): boolean; uid: number; mode: number },
  uid: number | undefined
): string | null {
  if (!st.isDirectory()) return 'not a directory'
  if (uid !== st.uid) return `owned by uid ${st.uid}, not this user`
  if ((st.mode & 0o077) !== 0) return `mode ${(st.mode & 0o777).toString(8)} lets other users in`
  return null
}

/** For a posix socket address: why its directory must not be trusted, or null when it may be — and
 *  null for a named pipe or a directory that is not there (nothing listens, and that is the caller's
 *  ordinary "no Host" path). */
export async function unsafeSocketDir(address: string): Promise<string | null> {
  if (address.startsWith(PIPE_PREFIX) || process.platform === 'win32') return null
  const dir = path.dirname(address)
  let st
  try {
    st = await fs.lstat(dir)
  } catch {
    return null
  }
  const problem = privateDirProblem(st, process.getuid?.())
  return problem === null ? null : `${dir} is not a directory only this user can open (${problem})`
}
