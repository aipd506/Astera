// The editor's save: content goes to a temporary file beside the target and is renamed over it, so a
// crash mid-write leaves the old file whole. Two things here are about a repository that is not on
// the person's side (security review 2026-09-28):
//
// - The temporary file is opened with O_EXCL ('wx') under a name nobody can predict. The old write
//   opened `<file>.cmtmp` with O_TRUNC, and open follows a symbolic link — so a repository shipping
//   `X` beside a link `X.cmtmp` that points at ~/.zshrc had that file rewritten with X's content the
//   moment X was saved. O_EXCL refuses any existing path, a link included, and the random name means
//   there is nothing to plant a link at in the first place.
// - The directory the file sits in is resolved for real before anything is written. `isPathWithin`
//   is lexical, and a directory link inside the root (`cfg -> ~/.ssh`) would put both the temporary
//   file and the rename outside it. Compared realpath against realpath, as files.readDataUrl does:
//   on macOS the root itself commonly sits under /var or /tmp, which are links.
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { isPathWithin } from './tree'

/** The error message when the file's real directory is not inside the root's real directory. */
export const OUTSIDE_ROOT = 'WRITE_OUTSIDE_ROOT'

export async function writeWithinRoot(
  root: string,
  filePath: string,
  content: string,
  deps: { tmpName?: (filePath: string) => string } = {}
): Promise<void> {
  const [realDir, realRoot] = await Promise.all([fs.realpath(path.dirname(filePath)), fs.realpath(root)])
  if (!isPathWithin(realRoot, realDir)) throw new Error(`${OUTSIDE_ROOT}: ${filePath}`)
  const target = path.join(realDir, path.basename(filePath))
  const tmp = (deps.tmpName ?? ((p) => `${p}.${randomUUID().slice(0, 8)}.cmtmp`))(target)
  await fs.writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' })
  try {
    await fs.rename(tmp, target)
  } catch (e) {
    // Clean up so a failed rename (antivirus, a lock, the disk) leaves no temporary file behind, then propagate the error
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}
