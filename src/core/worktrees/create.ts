import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WorktreeCreateProgress, WorktreeInfo } from '../types'
import { comparablePath, isPathWithin, isSamePath } from '../files/tree'
import {
  git, repoRoot, gitUserName, detectBaseRef, toFullRef, fetchBaseRef, localBranchExists, listGitWorktrees
} from './git'
import { cancelledError, throwIfCancelled } from './cancel'
import {
  autoName, branchNameFor, candidateName, repoDirName, slugify, worktreePathFor, MAX_SUFFIX_ATTEMPTS
} from './naming'
import { copyWorktreeInclude } from './include'
import type { WorktreeStore } from './registry'
import type { Message } from '../i18n'
import { createProber, type ProbePool } from '../sessions/pathProbe'
import { runFsWork, FS_WORK_TIMEOUT_MS } from './fsWork'
import { detachLinks } from './detachLinks'
import { askUntilAnswered, defaultActionPresenceCheck, type PresenceCheck } from './presence'

const WORKTREE_ADD_TIMEOUT_MS = 180_000

/** What making the repo's folder answered: `created` when this call made it, `present` when it was
 *  already there, or the probe's `absent` / `timeout`. */
export type MakeDirResult = 'created' | 'present' | 'absent' | 'timeout'

/** Makes a folder (recursively). Whether its drive answers is asked first, through the session
 *  folder's probe lane (pathProbe.ts): an lstat cut at PROBE_TIMEOUT_MS, inside the process-wide probe
 *  budget, so a dead root answers `timeout` at once. The mkdir itself is mutating work and runs outside
 *  the budget with its own deadline (fsWork.ts). `created` only when this call made it. */
async function defaultMakeDir(p: string): Promise<MakeDirResult> {
  const reach = await createProber({ access: (d) => fs.lstat(d).then(() => undefined), skipQueue: true })(p)
  if (reach === 'timeout') return 'timeout'
  let made = false
  const r = await runFsWork(() =>
    fs.mkdir(p, { recursive: true }).then((first) => {
      made = first !== undefined
    })
  )
  if (r === 'timeout') return 'timeout'
  if (r === 'failed') return 'absent'
  return made ? 'created' : 'present'
}

/** The fs side of a rollback: whether the path is there, taking the links out of it before git removes
 *  it (detachLinks.ts), removing a folder this call owns, and removing one it cannot prove it owns (only
 *  when empty).
 *
 *  Only `exists` is a probe: an lstat through the process-wide probe budget, so a root that stopped
 *  answering costs at most the probe limit and answers "could not tell". The rest changes the disk and
 *  can be slow for good reasons (a large tree), so it runs outside the budget with its own deadline
 *  (fsWork.ts): a slow rm must never mark the drive stuck for every session on it. */
export interface RollbackFs {
  exists(p: string): Promise<'yes' | 'no' | 'unknown'>
  /** Takes every link out of the folder, never following one. False when that could not be finished. */
  detachLinks(p: string): Promise<boolean>
  removeOwned(p: string): Promise<boolean>
  removeIfEmpty(p: string): Promise<boolean>
}

/** The default RollbackFs. Exported for its tests, with seams for the probe pool, the tree removal and
 *  the mutating work's deadline. */
export function probedRollbackFs(
  pool?: ProbePool,
  deps: { rmTree?: (p: string) => Promise<void>; fsWorkTimeoutMs?: number } = {}
): RollbackFs {
  const lstat = createProber({
    access: (p) => fs.lstat(p).then(() => undefined),
    skipQueue: true,
    ...(pool ? { pool } : {})
  })
  const rmTree = deps.rmTree ?? ((p: string) => fs.rm(p, { recursive: true, force: true, maxRetries: 3 }))
  const timeoutMs = deps.fsWorkTimeoutMs ?? FS_WORK_TIMEOUT_MS
  return {
    exists: async (p) => {
      const r = await lstat(p)
      return r === 'present' ? 'yes' : r === 'absent' ? 'no' : 'unknown'
    },
    detachLinks: async (p) => (await detachLinks(p, { timeoutMs })).ok,
    removeOwned: async (p) => (await runFsWork(() => rmTree(p), timeoutMs)) === 'done',
    removeIfEmpty: async (p) => (await runFsWork(() => removeOwnEmptyDir(p), timeoutMs)) === 'done'
  }
}

/** Undoes a `worktree add` — **only what this call made**. Exported for its tests.
 *
 *  Ownership is proved, not assumed from the name: the worktree git has at `wtPath` is removed only
 *  when it is on this call's `branch` (`remove --force --force`, the second for a half-made one git
 *  still marks "initializing"; git switches the new worktree's HEAD to the branch before the long
 *  checkout, so a killed add is still recognisable). A worktree there on any other branch is someone
 *  else's and is left alone. A folder git no longer knows is removed by hand only when this call owned
 *  the worktree, otherwise only when it is empty — a folder that appeared from elsewhere is never
 *  deleted. The branch is deleted with `branch -D` (git refuses while any worktree has it out).
 *
 *  Before git removes the worktree, every link in it is taken out (detachLinks.ts): Git for Windows'
 *  `worktree remove` deletes through a junction, into whatever folder outside it points at. When the
 *  folder cannot be checked, or its links cannot all be taken out, git is not run on it at all and the
 *  folder is kept, reported `unverified`.
 *
 *  Then it **checks**: what is still there comes back by name ('folder', 'branch', 'git-worktree',
 *  'unverified'), so the caller can say so instead of claiming a clean rollback. */
export async function rollbackAdd(
  repo: string,
  wtPath: string,
  branch: string,
  rfs: RollbackFs = probedRollbackFs()
): Promise<string[]> {
  let rows
  try {
    rows = await listGitWorktrees(repo)
  } catch {
    return ['unverified'] // without git's list nothing here can be proved to be ours
  }
  const entry = rows.find((w) => isSamePath(w.path, wtPath))
  const owned = entry !== undefined && entry.branch === branch
  /** The folder could not be checked, or its links could not all be taken out: nothing touches it. */
  let kept = false
  if (owned) {
    const at = await rfs.exists(wtPath)
    if (at === 'unknown' || (at === 'yes' && !(await rfs.detachLinks(wtPath)))) kept = true
    else await git(['worktree', 'remove', '--force', '--force', wtPath], { cwd: repo })
  }
  if (!kept && (!entry || owned)) {
    if ((await rfs.exists(wtPath)) === 'yes') {
      if (owned) await rfs.removeOwned(wtPath)
      else await rfs.removeIfEmpty(wtPath)
    }
  }
  await git(['worktree', 'prune'], { cwd: repo })
  if (await localBranchExists(repo, branch)) await git(['branch', '-D', branch], { cwd: repo })

  const remains: string[] = []
  if (kept) remains.push('unverified')
  const left = await rfs.exists(wtPath)
  if (left === 'yes') remains.push('folder')
  else if (left === 'unknown' && !kept) remains.push('unverified')
  if (await localBranchExists(repo, branch)) remains.push('branch')
  try {
    if ((await listGitWorktrees(repo)).some((w) => isSamePath(w.path, wtPath))) remains.push('git-worktree')
  } catch {
    if (!remains.includes('unverified')) remains.push('unverified')
  }
  return remains
}

/** In-process reservations of the names being created, from the moment a candidate is checked until its
 *  `worktree add` has finished. The checks (branch exists? folder there?) are asynchronous, so two
 *  creations of the same name in one process could both find it free and both take it — and the loser's
 *  rollback would then have removed the winner's worktree by name. Keys fold case the way the paths do. */
const reserved = new Set<string>()
const reservationKeys = (repo: string, candPath: string, candBranch: string): string[] => [
  `path:${comparablePath(path.resolve(candPath))}`,
  `branch:${comparablePath(path.resolve(repo))}:${process.platform === 'win32' || process.platform === 'darwin' ? candBranch.toLowerCase() : candBranch}`
]

/** The error a failed or cancelled creation ends with, once rollbackAdd has run: the original one when
 *  the rollback is complete, otherwise ROLLBACK_INCOMPLETE naming what is left and where — never a
 *  silent half-made worktree. */
function afterRollback(cause: unknown, remains: string[], wtPath: string, branch: string): Error {
  const err = cause instanceof Error ? cause : new Error(String(cause))
  if (remains.length === 0) return err
  return new Error(
    `ROLLBACK_INCOMPLETE: ${JSON.stringify({ path: wtPath, branch, remains })} — remove it by hand; the rollback ` +
      `after "${err.message}" did not finish`
  )
}

/** Takes back a folder create made itself: only a real, empty directory, never a link or a junction
 *  (lstat), and never a folder with anything in it (rmdir is not recursive). */
async function removeOwnEmptyDir(d: string): Promise<void> {
  const st = await fs.lstat(d)
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`not a plain directory: ${d}`)
  await fs.rmdir(d)
}

export async function createWorktree(args: {
  repoPath: string
  name?: string
  /** The branch to fork from, in short form ('develop' or 'origin/develop'). Optional: the orchestration
   *  path creates worker worktrees without a user in the loop and keeps the automatic detection. */
  baseRef?: string
  registry: WorktreeStore
  /** Test seams: whether a candidate folder is taken (presence.ts), and making the repo's folder
   *  under the root. Default to the process-wide action-lane check and a time-limited mkdir. */
  presence?: PresenceCheck
  makeDir?: (p: string) => Promise<MakeDirResult>
  /** Test seams for taking the repo folder back and for the rollback: the removal itself (mutating work,
   *  run with its own deadline outside the probe budget), the pool the existence checks go through (the
   *  process-wide budget by default), and that deadline (FS_WORK_TIMEOUT_MS by default). */
  removeDirAccess?: (p: string) => Promise<void>
  cleanupPool?: ProbePool
  fsWorkTimeoutMs?: number
  /** Test seam: the deadline of `worktree add` (WORKTREE_ADD_TIMEOUT_MS by default). */
  addTimeoutMs?: number
  /** Stage and copy progress (fetch → checkout → copy-includes). Optional; a throwing callback is ignored. */
  onProgress?: (p: WorktreeCreateProgress) => void
  /** Stops the creation: a running git is killed, the include walk and copy stop, and whatever this call
   *  made is rolled back before it throws WORKTREE_CANCELLED (or ROLLBACK_INCOMPLETE, naming what is
   *  left, when the rollback itself could not finish). Once the registry entry is written the creation
   *  is done and an abort changes nothing. Optional; callers without one behave exactly as before. */
  signal?: AbortSignal
}): Promise<{ info: WorktreeInfo; warnings: Message[] }> {
  const { signal } = args
  const report = (p: WorktreeCreateProgress): void => {
    try {
      args.onProgress?.(p)
    } catch {
      // progress is for show; it never breaks the creation
    }
  }
  throwIfCancelled(signal)
  report({ stage: 'fetch' })
  const repo = await repoRoot(args.repoPath)
  if (!repo) throw new Error(`NOT_GIT_REPO: ${args.repoPath}`)

  const warnings: Message[] = []
  const baseSlug = args.name && args.name.trim() !== '' ? slugify(args.name) : autoName()
  const username = await gitUserName(repo)

  // A base the user picked is used as given; only the automatic path probes. Validation is the same for
  // both — toFullRef below rejects anything that does not resolve, so a branch deleted between the picker
  // rendering and the spawn lands on NO_BASE rather than a confusing git error.
  const baseRef = args.baseRef ?? (await detectBaseRef(repo))
  if (!baseRef) throw new Error('NO_BASE: could not find a default branch (origin/HEAD, main or master)')
  if ((await fetchBaseRef(repo, baseRef, { signal })) === 'stale')
    warnings.push({ key: 'worktree.create.fetchFailed', params: { baseRef } })
  const fullBase = await toFullRef(repo, baseRef)
  if (!fullBase) throw new Error(`NO_BASE: cannot resolve the ${baseRef} ref`)
  throwIfCancelled(signal)

  // Name-collision avoidance loop: checks the local branch and the path.
  //
  // **Nothing here looks at the disk synchronously.** A sync existsSync on a root that sits on an
  // offline network share froze the calling thread (the Electron main thread, or the Host's) for 20
  // to 60 s. So the repo's folder under the root is made first through a time-limited call, and each
  // candidate is asked about asynchronously (presence.ts). A root that does not answer fails at once
  // with WORKTREE_ROOT_UNREACHABLE; a candidate whose presence is not known is never taken as free.
  const root = args.registry.getRoot()
  const presence = args.presence ?? defaultActionPresenceCheck
  const parent = path.join(root, repoDirName(repo))
  if (!isPathWithin(root, parent)) throw new Error(`DANGEROUS_PATH: ${parent}`)
  const made = await (args.makeDir ?? defaultMakeDir)(parent)
  if (made === 'timeout') throw new Error(`WORKTREE_ROOT_UNREACHABLE: folder not reachable: ${parent}`)
  if (made !== 'present' && made !== 'created')
    throw new Error(`WORKTREE_ROOT_UNREACHABLE: cannot create the folder ${parent}`)
  let slug: string | null = null
  /** The reservation of the picked name, held until its `worktree add` has finished. */
  let held: string[] = []
  const release = (): void => {
    held.forEach((k) => reserved.delete(k))
    held = []
  }
  let branch = ''
  let wtPath = ''
  /** The root stopped answering: nothing more is asked of it, the cleanup included. */
  let unreachable = false
  try {
    for (let attempt = 1; attempt <= MAX_SUFFIX_ATTEMPTS; attempt++) {
      throwIfCancelled(signal) // before anything is picked — the finally below takes the repo folder back
      const cand = candidateName(baseSlug, attempt)
      const candBranch = branchNameFor(username, cand)
      const candPath = worktreePathFor(root, repo, cand)
      if (!isPathWithin(root, candPath)) throw new Error(`DANGEROUS_PATH: ${candPath}`)
      // Reserved before it is checked, synchronously: another creation in this process skips it
      // instead of racing this one through the same asynchronous checks (see `reserved`).
      const keys = reservationKeys(repo, candPath, candBranch)
      if (keys.some((k) => reserved.has(k))) continue
      keys.forEach((k) => reserved.add(k))
      let keep = false
      try {
        if (await localBranchExists(repo, candBranch)) continue
        // The action lane: a check stuck on another drive never refuses this one. A refusal is asked
        // again (askUntilAnswered); one that lasts is "could not check", never "free".
        const at = await askUntilAnswered(presence, candPath)
        if (at === 'present') continue
        if (at !== 'missing') {
          unreachable = true
          throw new Error(
            at === 'refused'
              ? `WORKTREE_ROOT_UNREACHABLE: could not check just now whether ${candPath} is free`
              : `WORKTREE_ROOT_UNREACHABLE: could not check whether ${candPath} is free`
          )
        }
        keep = true
        held = keys
      } finally {
        if (!keep) keys.forEach((k) => reserved.delete(k))
      }
      slug = cand
      branch = candBranch
      wtPath = candPath
      break
    }
  } finally {
    // The repo's folder was made before a name was picked. When none was, it is taken back — but only
    // when **this call made it** (never one that was there before, a link or a junction included), and
    // only when the root is still answering: that is asked first with a time-limited probe inside the
    // process-wide budget. The rmdir itself is mutating work and runs outside the budget with its own
    // deadline, so a slow one never marks the drive stuck. rmdir is not recursive, so a sibling worktree
    // keeps the folder. What the cleanup answers changes nothing.
    if (!slug && !unreachable && made === 'created') {
      const there = await createProber({
        access: (d) => fs.lstat(d).then(() => undefined),
        skipQueue: true,
        ...(args.cleanupPool ? { pool: args.cleanupPool } : {})
      })(parent)
      if (there === 'present')
        await runFsWork(() => (args.removeDirAccess ?? removeOwnEmptyDir)(parent), args.fsWorkTimeoutMs)
    }
  }
  if (!slug) throw new Error(`NAME_EXHAUSTED: no name starting with '${baseSlug}' is available (20 attempts)`)

  const rfs = probedRollbackFs(
    args.cleanupPool,
    args.fsWorkTimeoutMs !== undefined ? { fsWorkTimeoutMs: args.fsWorkTimeoutMs } : {}
  )
  try {
    throwIfCancelled(signal)
    report({ stage: 'checkout' })
    const add = await git(['worktree', 'add', '--no-track', '-b', branch, wtPath, fullBase], {
      cwd: repo,
      timeoutMs: args.addTimeoutMs ?? WORKTREE_ADD_TIMEOUT_MS,
      signal
    })
    // Killed part-way — cancelled, or past its deadline, or git never answered at all: the folder,
    // git's record and the branch may each be there or not, and whatever of it is this call's goes.
    // (git() has already killed the process tree.) The name stays reserved until that is done.
    if (add.cancelled)
      throw afterRollback(cancelledError(), await rollbackAdd(repo, wtPath, branch, rfs), wtPath, branch)
    if (!add.ok && add.exitCode === undefined) {
      const cause = new Error(
        `GIT_ADD_FAILED: git worktree add ${add.timedOut ? 'timed out' : 'did not answer'} (${add.stderr || add.stdout})`
      )
      throw afterRollback(cause, await rollbackAdd(repo, wtPath, branch, rfs), wtPath, branch)
    }
    // git answered with an error (the folder already exists, say): what is there is not this call's
    // to take, so nothing is rolled back.
    if (!add.ok) throw new Error(`GIT_ADD_FAILED: ${add.stderr || add.stdout}`)
  } finally {
    release()
  }

  try {
    // follow-up configuration only produces warnings
    const setBase = await git(['config', '--local', `branch.${branch}.base`, fullBase], { cwd: repo })
    if (!setBase.ok) warnings.push({ key: 'worktree.create.baseRecordFailed' })
    const autoSetup = await git(['config', '--get', 'push.autoSetupRemote'], { cwd: repo })
    if (!autoSetup.ok) {
      const set = await git(['config', '--local', 'push.autoSetupRemote', 'true'], { cwd: repo })
      if (!set.ok) warnings.push({ key: 'worktree.create.autoSetupRemoteFailed' })
    }
    throwIfCancelled(signal)
    warnings.push(
      ...(await copyWorktreeInclude(repo, wtPath, {
        signal,
        onProgress: (p) => report({ stage: 'copy-includes', ...p })
      }))
    )
    throwIfCancelled(signal) // the last point a cancel is honoured — after the registry write it is done

    const info: WorktreeInfo = {
      id: randomUUID(),
      repoPath: repo,
      path: wtPath,
      name: slug,
      branch,
      baseRef,
      createdAt: new Date().toISOString()
    }
    await args.registry.add(info)
    return { info, warnings }
  } catch (err) {
    // rollback: do not leave behind the worktree and branch that were just created — and say so when
    // some of it could not be taken back
    throw afterRollback(err, await rollbackAdd(repo, wtPath, branch, rfs), wtPath, branch)
  }
}
