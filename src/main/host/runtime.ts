// Putting the Host's own runtime in place, and sweeping what an update leaves behind
// (docs/superpowers/specs/2026-09-14-host-runtime-design.md).
//
// **win32 only.** The Host is spawned from `process.execPath` — the app's own `Astera.exe` run with
// ELECTRON_RUN_AS_NODE — and Windows locks the image of a running process, so a Host that outlives
// the app pins the install directory and no installer can write over it. macOS and Linux replace a
// running binary without complaint, so their Hosts already survive an update and `hostRuntimeBase`
// returns null there: nothing is copied, nothing is swept, the spawn is unchanged.
//
// **`hostRuntimeBase` and `hostRuntimePaths` moved to `../../core/host/runtime.ts`.** They are pure
// path arithmetic and `astera host start` (src/cli/host.ts) needs to compute the same paths to find a
// runtime this module already prepared. What is left here — `prepareHostRuntime`, `sweepHostRuntime`
// — touches the filesystem, and laying a runtime down (87MB of copying) stays the app's job alone; the
// CLI only ever looks for one.
//
// Pure, with the platform and the filesystem arriving as arguments, for the reason `address.ts` gives
// for the same choice: these tests run on windows, macos and ubuntu, and a module that asks the host
// which platform it is on can only be tested on one of them. Paths are built with `path.win32`
// rather than `path` for the same reason — this code only ever produces Windows paths, and on win32
// `path.win32` *is* `path`, so the tests read the same everywhere.
import { win32 as w } from 'node:path'
import { HOST_EXE, NODE_PREFIX, nodeDirName, type HostRuntimePaths } from '../../core/host/runtime'

/** Which `node-*` directories are no longer the current one — the current Node's own directory from
 *  before the executable was renamed among them. **The prefix check is the guard, not decoration**:
 *  this list is deleted, and `base` is a directory a person could have put something else in. A name
 *  that does not look like ours is never a candidate. */
export function staleNodeDirs(names: readonly string[], keepNodeVersion: string): string[] {
  const keep = nodeDirName(keepNodeVersion)
  return names.filter((n) => n.startsWith(NODE_PREFIX) && n !== keep)
}

/** Which build directories under the current Node are no longer the current app version.
 *
 *  Deleting the previous version's build while its Host is still running is deliberate and safe:
 *  `host.js` and its chunks are CommonJS, read at startup and closed, so a running Host holds no
 *  handle on them and never reads them again. `node.exe` is the opposite — a locked running image —
 *  which is why a whole `node-*` directory can only go once its Host has, and why the sweep has to
 *  tolerate failing (see `sweepHostRuntime`). */
export function staleBuildDirs(names: readonly string[], keepAppVersion: string): string[] {
  return names.filter((n) => n !== keepAppVersion)
}

/** The filesystem this module needs, injected so the sequencing below is testable. Every one of
 *  these is allowed to reject; the callers here say what that means in each place.
 *
 *  **Asynchronous, every one of them** (stage 3 task 2). This runs on Electron's main thread, and the
 *  first half of an install is an 87 MB copy of `node.exe` that an antivirus then scans: done with
 *  `cpSync` it froze the window for as long as that took, with nothing on screen to say why. */
export interface RuntimeFs {
  exists(p: string): Promise<boolean>
  /** The entries of a directory, or `[]` when it is not there — "nothing to sweep" and "no such
   *  directory" are the same answer to the only question asked of it. */
  readdir(p: string): Promise<string[]>
  /** Recursive copy, creating the destination's parents. */
  copy(from: string, to: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Recursive delete that does not mind a path which is not there. */
  rm(p: string): Promise<void>
}

export interface PrepareResult {
  /** Whether the runtime is complete and can be spawned. False means the caller falls back to
   *  `process.execPath`, which is what every version before this one did. */
  ready: boolean
  /** What was actually written, for the log — an ordinary update does `build` alone. */
  did: 'nothing' | 'build' | 'node'
  /** The runtime is missing files and could not be repaired, because a Host is still running out of
   *  it and Windows will not delete a locked `node.exe`. The Host on the other end of that is one
   *  spawn away from stalling, so the app carries this in its status and replaces it the first moment
   *  it holds nothing (docs/2026-09-22-host-unresponsive-recovery-design.md F6). */
  incomplete: boolean
  /** Why the runtime could not be put in place, or null when nothing went wrong — including when
   *  nothing was shipped, which is a fallback and not a fault. The caller shows it; the next start
   *  tries again, as it always did. */
  failure: string | null
}

/**
 * Which files a whole runtime has, as the build wrote them into `runtime.json`.
 *
 * **Two lists, because a file being absent means opposite things in the two halves.** Nothing under
 * `builds\<version>` exists yet on the machine that is taking this app's first update — that is an
 * ordinary install, not damage. Everything under the node directory was laid down together by one
 * rename, so one of them missing means somebody or something took it, and what is left cannot spawn.
 */
export interface RuntimeFiles {
  /** Paths relative to `nodeDir`, excluding `builds`. */
  node: string[]
  /** Paths relative to `buildDir` — this app version's own build. */
  build: string[]
}

/**
 * Puts the shipped runtime where the Host can be spawned from it, doing as little as possible.
 *
 * The expensive half — `node.exe`, 87 MB — is copied **once per Node version**, because the
 * directory is keyed by that and nothing else. An ordinary app update finds it already there and
 * writes only the build directory, a few tens of kilobytes.
 *
 * **Both copies land through a staging directory and a rename.** An interrupted copy that left a
 * half-written `node.exe` behind would be believed by every later launch — `exists` was once the only
 * question asked of it — and the Host would never start again. A rename is the one step that either
 * happened or did not.
 *
 * **And `exists(node.exe)` is no longer the only question.** On 2026-09-22 a recursive delete of
 * `%LOCALAPPDATA%\astera` took everything in the runtime except the two files the running Host had
 * open, `node.exe` among them. This function looked at that and saw a runtime already in place; the
 * restart wrote the build directory and nothing else, and the Host went on being unable to spawn
 * anything at all. So every file the build recorded is checked, and a node directory that is missing
 * one is not patched but replaced (design D5, F6).
 */
export async function prepareHostRuntime(a: {
  paths: HostRuntimePaths
  /** `<resources>\host-runtime`, as shipped in the installer. */
  shipped: string
  /** The app version, which is also the name of the build directory inside `shipped`. */
  appVersion: string
  /** Distinguishes this attempt's staging directory from a concurrent one. */
  stamp: string
  /** What a whole runtime has, from the shipped `runtime.json`. Empty lists mean the check is skipped
   *  — see where that is decided. */
  files: RuntimeFiles
  fs: RuntimeFs
  /** Called once, just before the first thing is written or removed — the moment the app starts
   *  saying "Preparing the Astera Host". A runtime that is already whole never calls it, so an
   *  ordinary launch does not flash a status for a handful of existence checks. */
  onInstall?: () => void
  log(m: string): void
}): Promise<PrepareResult> {
  const { paths, fs, shipped } = a
  let announced = false
  const installing = (): void => {
    if (announced) return
    announced = true
    try {
      a.onInstall?.()
    } catch (err) {
      a.log(`the host runtime's install status could not be shown: ${String(err)}`)
    }
  }
  if (!(await fs.exists(w.join(shipped, HOST_EXE)))) {
    a.log('no host runtime shipped with this build — the Host runs from the app executable')
    return { ready: false, did: 'nothing', incomplete: false, failure: null }
  }

  /** The first of `names` that is not under `dir`, or null. Swallows a filesystem that refuses to
   *  answer: **a check that cannot be made is not a failure**, and reading it as one would replace a
   *  working runtime, or worse refuse to start a Host, on no evidence at all. The same rule
   *  `host/nodePtyCheck.ts` follows on the other side of this. */
  const firstMissing = async (dir: string, names: string[]): Promise<string | null> => {
    try {
      // One at a time, in the manifest's order: the answer is the *first* missing name, and the list
      // is a few dozen entries at most.
      for (const n of names) if (!(await fs.exists(w.join(dir, n)))) return n
      return null
    } catch {
      return null
    }
  }
  if (a.files.node.length === 0 && a.files.build.length === 0) {
    a.log('the shipped runtime lists no files — installed without checking what is already there')
  }

  let incomplete = false
  // Only for a runtime that is already installed. A machine that has none is the ordinary first
  // install, and the copy below is what puts every one of these files there.
  if (await fs.exists(paths.exePath)) {
    const missing = await firstMissing(paths.nodeDir, a.files.node)
    if (missing) {
      a.log(`the host runtime is missing ${missing} — replacing it`)
      installing()
      try {
        // The whole directory, not the one file: what took that file took whatever else was not
        // locked at the time, and the list is only as complete as this build's own manifest.
        await fs.rm(paths.nodeDir)
      } catch (err) {
        // The expected failure, and the one worth reporting: a Host is still running out of this
        // directory and holds its `node.exe`. Nothing can be repaired until that Host is gone, so the
        // caller is told, and the Host gets replaced the first moment it holds nothing.
        incomplete = true
        a.log(`the host runtime could not be repaired while a Host is running from it: ${String(err)}`)
      }
    }
  }

  let did: PrepareResult['did'] = 'nothing'
  if (!(await fs.exists(paths.exePath))) {
    const stage = `${paths.nodeDir}.staging-${a.stamp}`
    installing()
    try {
      await fs.rm(stage)
      await fs.copy(shipped, stage)
      await fs.rename(stage, paths.nodeDir)
      did = 'node'
    } catch (err) {
      // A second instance that got there first is the expected loser here, and it has already
      // produced exactly what this one was going to. Anything else leaves `ready` false below.
      await fs.rm(stage)
      if (!(await fs.exists(paths.exePath))) {
        const failure = `the host runtime could not be installed: ${String(err)}`
        a.log(failure)
        return { ready: false, did: 'nothing', incomplete, failure }
      }
    }
  }

  // The entry alone is not the question either: `host.js` requires the chunks beside it, and a build
  // directory with the entry and none of them is a Host that dies on its first line.
  const buildMissing = await firstMissing(paths.buildDir, a.files.build)
  const entryThere = await fs.exists(paths.entryPath)
  if (buildMissing && entryThere) a.log(`this build's host runtime is missing ${buildMissing} — rewriting it`)
  if (!entryThere || buildMissing) {
    const from = w.join(shipped, 'builds', a.appVersion)
    const stage = `${paths.buildDir}.staging-${a.stamp}`
    installing()
    try {
      await fs.rm(stage)
      await fs.copy(from, stage)
      await fs.rm(paths.buildDir)
      await fs.rename(stage, paths.buildDir)
      if (did === 'nothing') did = 'build'
    } catch (err) {
      await fs.rm(stage)
      if (!(await fs.exists(paths.entryPath))) {
        const failure = `the host runtime's entry could not be installed: ${String(err)}`
        a.log(failure)
        return { ready: false, did: 'nothing', incomplete, failure }
      }
    }
  }

  const ready = (await fs.exists(paths.exePath)) && (await fs.exists(paths.entryPath))
  return { ready, did, incomplete, failure: ready ? null : 'the host runtime is not whole after installing it' }
}

/**
 * Removes what this version will never use again: every other Node's directory, and every other app
 * version's build under this one.
 *
 * **A failure here is expected, not exceptional.** The directory most worth removing is an old
 * Node's, and that is precisely the one an old Host may still be running out of — Windows refuses to
 * delete a locked image. So each removal stands alone and a refusal is swallowed: the sweep is
 * self-healing, and the next launch after that Host exits finishes the job.
 */
export async function sweepHostRuntime(a: {
  paths: HostRuntimePaths
  nodeVersion: string
  appVersion: string
  fs: RuntimeFs
  log(m: string): void
}): Promise<number> {
  let removed = 0
  const drop = async (p: string): Promise<void> => {
    try {
      await a.fs.rm(p)
      removed += 1
    } catch {
      /* still in use, or gone already — either way the next launch tries again */
    }
  }
  // Staging directories too: a copy killed between `copy` and `rename` leaves one behind, and
  // nothing else will ever look at it.
  for (const name of await a.fs.readdir(a.paths.base)) {
    if (name.includes('.staging-')) await drop(w.join(a.paths.base, name))
  }
  for (const name of staleNodeDirs(await a.fs.readdir(a.paths.base), a.nodeVersion)) {
    await drop(w.join(a.paths.base, name))
  }
  for (const name of staleBuildDirs(await a.fs.readdir(a.paths.buildsDir), a.appVersion)) {
    await drop(w.join(a.paths.buildsDir, name))
  }
  if (removed > 0) a.log(`swept ${removed} unused host runtime director${removed === 1 ? 'y' : 'ies'}`)
  return removed
}
