// The editor's save: content goes to a temporary file beside the target and is renamed over it, so a
// crash mid-write leaves the old file whole. Two things here are about a repository that is not on
// the person's side (security review 2026-09-28):
//
// - The temporary file is opened with O_EXCL ('wx') under a name nobody can predict, and only after
//   lstat says nothing is at that name. The old write opened `<file>.cmtmp` with O_TRUNC, and open
//   follows a symbolic link — so a repository shipping `X` beside a link `X.cmtmp` that points at
//   ~/.zshrc had that file rewritten with X's content the moment X was saved. On posix O_EXCL refuses
//   any existing path, a link included; on Windows CreateFile resolves a link before the disposition
//   applies, so a dangling link is followed and its target created even under O_EXCL (measured on the
//   CI runner) — which is what the lstat is for. The random name means there is nothing to plant a
//   link at in the first place; the two checks are for the day that assumption is wrong.
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
/** The error message when something already sits at the temporary name — never this call's. */
export const TMP_TAKEN = 'WRITE_TMP_TAKEN'

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
  if (await fs.lstat(tmp).then(() => true, () => false)) throw new Error(`${TMP_TAKEN}: ${tmp}`)
  await fs.writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' })
  try {
    await fs.rename(tmp, target)
  } catch (e) {
    // Clean up so a failed rename (antivirus, a lock, the disk) leaves no temporary file behind, then propagate the error
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}
