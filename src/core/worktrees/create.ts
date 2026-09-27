import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WorktreeCreateProgress, WorktreeInfo } from '../types'
import { isPathWithin, isSamePath } from '../files/tree'
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
import { askUntilAnswered, defaultActionPresenceCheck, type PresenceCheck } from './presence'

const WORKTREE_ADD_TIMEOUT_MS = 180_000

/** What making the repo's folder answered: `created` when this call made it, `present` when it was
 *  already there, or the probe's `absent` / `timeout`. */
export type MakeDirResult = 'created' | 'present' | 'absent' | 'timeout'

/** Makes a folder (recursively) through the session folder's probe lane (pathProbe.ts): cut at
 *  PROBE_TIMEOUT_MS, inside the process-wide probe budget. `created` only when this call made it. */
async function defaultMakeDir(p: string): Promise<MakeDirResult> {
  let made = false
  const probe = createProber({
    access: (d) =>
      fs.mkdir(d, { recursive: true }).then((first) => {
        made = first !== undefined
      }),
    skipQueue: true
  })
  const r = await probe(p)
  return r === 'present' ? (made ? 'created' : 'present') : r
}

/** Undoes a `worktree add` this call made: the worktree (a locked, half-made one too — git marks a
 *  worktree "initializing" until add finishes, hence the second --force), its folder if git left one,
 *  git's record of it, and the branch. Then it **checks**: what is still there comes back by name, so
 *  the caller can say so instead of claiming a clean rollback.
 *
 *  The folder is removed by hand only when git did not: it is the path this call found free a moment
 *  ago and git created, inside the worktree root. */
async function rollbackAdd(repo: string, wtPath: string, branch: string): Promise<string[]> {
  await git(['worktree', 'remove', '--force', '--force', wtPath], { cwd: repo })
  const exists = (): Promise<boolean> => fs.lstat(wtPath).then(() => true, () => false)
  if (await exists()) {
    try {
      await fs.rm(wtPath, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // reported below as a folder that remains
    }
  }
  await git(['worktree', 'prune'], { cwd: repo })
  await git(['branch', '-D', branch], { cwd: repo })

  const remains: string[] = []
  if (await exists()) remains.push('folder')
  if (await localBranchExists(repo, branch)) remains.push('branch')
  try {
    if ((await listGitWorktrees(repo)).some((w) => isSamePath(w.path, wtPath))) remains.push('git-worktree')
  } catch {
    remains.push('unverified')
  }
  return remains
}

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
  /** Test seams for taking the repo folder back: the fs work, run inside a time-limited probe call,
   *  and the pool that call goes through (the process-wide budget by default). */
  removeDirAccess?: (p: string) => Promise<void>
  cleanupPool?: ProbePool
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
      slug = cand
      branch = candBranch
      wtPath = candPath
      break
    }
  } finally {
    // The repo's folder was made before a name was picked. When none was, it is taken back — but only
    // when **this call made it** (never one that was there before, a link or a junction included), only
    // when the root is still answering, and only through a time-limited probe call inside the
    // process-wide budget: a cleanup never waits past the probe limit. rmdir is not recursive, so a
    // sibling worktree keeps the folder. What the cleanup answers changes nothing.
    if (!slug && !unreachable && made === 'created') {
      const cleanup = createProber({
        access: args.removeDirAccess ?? removeOwnEmptyDir,
        skipQueue: true,
        ...(args.cleanupPool ? { pool: args.cleanupPool } : {})
      })
      await cleanup(parent)
    }
  }
  if (!slug) throw new Error(`NAME_EXHAUSTED: no name starting with '${baseSlug}' is available (20 attempts)`)

  throwIfCancelled(signal)
  report({ stage: 'checkout' })
  const add = await git(['worktree', 'add', '--no-track', '-b', branch, wtPath, fullBase], {
    cwd: repo,
    timeoutMs: WORKTREE_ADD_TIMEOUT_MS,
    signal
  })
  // Killed part-way: the folder, git's record and the branch may each be there or not. All of it goes.
  if (add.cancelled) throw afterRollback(cancelledError(), await rollbackAdd(repo, wtPath, branch), wtPath, branch)
  if (!add.ok) throw new Error(`GIT_ADD_FAILED: ${add.stderr || add.stdout}`)

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
    throw afterRollback(err, await rollbackAdd(repo, wtPath, branch), wtPath, branch)
  }
}
