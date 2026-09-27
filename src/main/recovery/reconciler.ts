// The recovery reconciler (P1 design §6): the piece that finds a lost worker, asks decide.ts for a
// strategy, journals the decision, and hands it to execute.ts. Nothing here decides or carries out a
// strategy — those live in core/recovery/decide.ts and main/recovery/execute.ts, the same split the
// orchestration guide draws between "what happened", "what to do" and "doing it".
import { jobOf, placedByApp, type OrchState } from '../../core/orchestration/state'
import { checkConfigIdsOf, policyOf } from '../../core/orchestration/convergence'
import { DEFAULT_CONCURRENCY } from '../../core/orchestration/types'
import type { GitFacts, LostAttempt, RecoveryDecision } from '../../core/recovery/types'
import { decideRecovery } from '../../core/recovery/decide'
import type { ContinuityEvent, ContinuityEventType } from '../../core/continuity/events'
import type { CheckpointRow, ContinuityJournal, RecoveryActionRow } from '../../core/continuity/journal'
import { retryBusy } from '../../core/continuity/busyRetry'
import type { ExecuteResult } from './execute'

// `candidates` and its seed live in core now (the Host's lost-worker Gate asks the same question, R16).
export { candidates, type LostAttemptSeed } from '../../core/recovery/candidates'
import { candidates, type LostAttemptSeed } from '../../core/recovery/candidates'

/** What the reconciler needs of the journal. A port rather than the class since the Host journal (J3):
 *  in front of a Host that writes the journal the app reads through a read-only reader and sends its
 *  writes as `journal-append` (appJournal.ts); otherwise these are the app's own ContinuityJournal. */
export type ReconcilerJournal = Pick<
  ContinuityJournal,
  'eventsFor' | 'firstCheckpointFor' | 'append' | 'startRecoveryAction' | 'finishRecoveryAction'
>

export interface ReconcilerDeps {
  getState(): OrchState
  setState(next: OrchState): Promise<void>
  journal: ReconcilerJournal
  readGitFacts(cwd: string): Promise<GitFacts>
  smartResume(): boolean
  execute(a: { attempt: LostAttempt; decision: RecoveryDecision; state: OrchState; now: string }): Promise<ExecuteResult>
  log(m: string): void
  /** ISO clock. The journal holds no clock of its own — every write takes its time from the caller. */
  now(): string
  /** The pause before a busy journal is asked again; a timer when left out. Tests pass one that does not wait. */
  sleep?(ms: number): Promise<void>
}

/** Recovery is a second door into starting workers, so it obeys the scheduler's concurrency rule too
 *  (the `room` calculation in core/orchestration/schedule.ts's slotsToFill). Several lost Tasks in one
 *  Run would otherwise all restart at once, and in a Run whose Tasks dispatch into the Run root they
 *  would land in the same folder. A candidate with no room is left for the next trigger. */
const hasRoom = (state: OrchState, runId: string): boolean => {
  const run = state.runs.find((r) => r.id === runId)
  if (!run) return false
  const openHere = state.dispatches.filter(
    (d) => !d.outcome && !d.endedAt && state.tasks.find((t) => t.id === d.taskId)?.runId === runId
  ).length
  return openHere < (jobOf(state, run)?.concurrency ?? DEFAULT_CONCURRENCY)
}

export class RecoveryReconciler {
  constructor(private readonly deps: ReconcilerDeps) {}

  /** Swallows a journal failure into the log and returns `fallback` — a journal problem must never
   *  block a Job, the discipline `ContinuityRecorder`'s `append` already follows. */
  private note<T>(label: string, fallback: T, fn: () => T): T {
    try {
      return fn()
    } catch (err) {
      this.deps.log(`recovery: ${label} failed: ${String(err)}`)
      return fallback
    }
  }

  /** A dispatch whose recovery is under way: a sweep and a live reconcileOne can overlap now that the
   *  journal reads wait on the event loop (stage 3 T1 review), and only the first acts. */
  private readonly inFlight = new Set<string>()

  /** What recovery reads from the journal about one dispatch (stage 3 T1): whether any row names it,
   *  whether its prompt write was confirmed, and its first checkpoint. Each is one indexed read of at
   *  most one row, never the Run's whole record; the rows are checked again here, so a port that ignores
   *  the bound still answers right. A busy journal is asked again first (retryBusy). null when any read
   *  failed: "cannot say", which decide.ts turns into a person's review. **The checkpoint counts too**
   *  (stage 3 T1 review): read as absent, it drops the base head and the native session, and a worker
   *  that committed on a clean tree would be restarted with its commits duplicated. */
  private async evidenceFor(
    runId: string,
    dispatchId: string
  ): Promise<{ witnessed: boolean; promptConfirmed: boolean; checkpoint: CheckpointRow | null } | null> {
    const journal = this.deps.journal
    const retried = await retryBusy(
      () => {
        const witnessed = journal.eventsFor(runId, { dispatchId, limit: 1 }).some((e) => e.dispatchId === dispatchId)
        if (!witnessed) return { witnessed, promptConfirmed: false, checkpoint: null }
        const promptConfirmed = journal
          .eventsFor(runId, { dispatchId, types: ['PROMPT_WRITE_CONFIRMED'], limit: 1 })
          .some((e) => e.type === 'PROMPT_WRITE_CONFIRMED' && e.dispatchId === dispatchId)
        return { witnessed, promptConfirmed, checkpoint: journal.firstCheckpointFor(dispatchId) }
      },
      {
        sleep: this.deps.sleep,
        onBusy: (err) => this.deps.log(`recovery: the journal is busy, dispatch ${dispatchId} asks again shortly: ${String(err)}`)
      }
    )
    if (retried.ok) return retried.value
    this.deps.log(`recovery: eventsFor failed${retried.busy ? ' (still busy)' : ''}: ${String(retried.error)}`)
    return null
  }

  /** Carries one seed all the way through, or returns false having done nothing at all — the caller
   *  counts only what it acted on. */
  private async recoverOne(seed: LostAttemptSeed): Promise<boolean> {
    if (this.inFlight.has(seed.dispatch.id)) return false
    this.inFlight.add(seed.dispatch.id)
    try {
      return await this.recoverOneNow(seed)
    } finally {
      this.inFlight.delete(seed.dispatch.id)
    }
  }

  private async recoverOneNow(seed: LostAttemptSeed): Promise<boolean> {
    const { runId, taskId, dispatch } = seed
    const now = this.deps.now()
    const journal = this.deps.journal

    // null, not false — a read that failed is not a read that found nothing. decide.ts reads a `false`
    // here as positive evidence that the prompt never left the app; null is "we cannot say".
    const evidence = await this.evidenceFor(runId, dispatch.id)
    const promptConfirmed = evidence === null ? null : evidence.promptConfirmed

    // The journal witnesses every attempt it was on for (ATTEMPT_START_REQUESTED at the very least),
    // so rows that name this dispatch are the evidence recovery reasons from. None of them, on a read
    // that worked, means the attempt happened while the toggle was off or before this journal file
    // existed — there is nothing to reason from, and guessing would restart work nobody recorded.
    // This is what bounds the first sweep after the toggle is switched on: store.load()'s restart
    // cleanup closes every open Dispatch as outcome_unknown, so without it every Task any past crash
    // ever stranded inside the 30-day TTL would be decided from an empty record.
    if (evidence !== null && !evidence.witnessed) {
      this.deps.log(
        `recovery: no journal rows for dispatch ${dispatch.id} — the attempt predates this journal, leaving it alone`
      )
      return false
    }

    const checkpoint = evidence?.checkpoint ?? null
    const baseHead = checkpoint?.gitHead ?? null

    const state = this.deps.getState()
    const task = state.tasks.find((t) => t.id === taskId)
    const run = task && state.runs.find((r) => r.id === task.runId)
    if (!task || !run) {
      // candidates() built this seed from a Task whose runId resolved to a live Run; both should
      // still be there a moment later. If not, there is nothing left to recover — logged and
      // returned rather than thrown, the same failure shape executeRecovery uses for an unknown
      // task or run, and reconcileOne has nothing here to catch a throw with.
      this.deps.log(`recovery: task ${taskId} or its run vanished before it could be recovered`)
      return false
    }

    const attempt: LostAttempt = {
      runId,
      taskId,
      dispatchId: dispatch.id,
      provider: dispatch.provider,
      accountId: dispatch.accountId,
      cwd: dispatch.cwd,
      nativeSessionId: dispatch.nativeSessionId ?? checkpoint?.nativeSessionId ?? undefined,
      promptConfirmed,
      baseHead,
      hasValidateConfig: checkConfigIdsOf(task).length > 0,
      // repair 에 대해서는 앱이 dispatch 권한을 갖는다(설계 §10) — 코디네이터 Run 이어도 redispatch·smart-resume
      // 가 열린다. 첫 구현 attempt 는 지금처럼 코디네이터의 것이다.
      // policyOf 로 본다, run.convergence !== undefined 가 아니다 — 손으로 고친 "convergence": null 은
      // !== undefined 로는 정책이 있다고 잘못 읽히지만, policyOf 는 falsy 한 convergence 를 그대로
      // "정책 없음" 으로 읽는다(이 파일이 손으로 고쳐질 수 있다는 전제는 곳곳에 이미 있다).
      appDriven: placedByApp(jobOf(state, run), run) || (policyOf(state, task) !== null && dispatch.repair !== undefined),
      ...(dispatch.repair ? { repair: dispatch.repair } : {}),
      ...(dispatch.grantedExtra ? { grantedExtra: true } : {})
    }

    const git = await this.deps.readGitFacts(dispatch.cwd)
    // The reads above waited on the event loop (a busy journal, git). A person may have stopped or
    // reopened this dispatch meanwhile (stage 3 T1 review): acted on only while it is still a candidate.
    // Another trigger may also have started a worker in this Run, so the concurrency room is asked again.
    const after = this.deps.getState()
    if (!candidates(after).some((c) => c.dispatch.id === dispatch.id)) {
      this.deps.log(`recovery: dispatch ${dispatch.id} is no longer lost, leaving it alone`)
      return false
    }
    if (!hasRoom(after, runId)) {
      this.deps.log(`recovery: run ${runId} filled up while dispatch ${dispatch.id}'s evidence was read, left for the next trigger`)
      return false
    }
    const decision = decideRecovery({ attempt, git, smartResume: this.deps.smartResume() })

    const mk = (type: ContinuityEventType, payload: Record<string, unknown>): ContinuityEvent => ({
      runId,
      taskId,
      dispatchId: dispatch.id,
      type,
      at: now,
      idempotencyKey: `${type}:${dispatch.id}:${now}`,
      payload
    })

    this.note('append', 0, () =>
      journal.append([
        mk('RECOVERY_DETECTED', {
          provider: attempt.provider,
          accountId: attempt.accountId,
          cwd: attempt.cwd,
          promptConfirmed: attempt.promptConfirmed,
          baseHead: attempt.baseHead,
          nativeSessionId: attempt.nativeSessionId ?? null,
          git
        }),
        // Both halves of the sentence: the English one the file keeps, and the key the Timeline
        // renders in the reader's language. A row read by a build that no longer has the key still
        // has the English one to fall back on (ContinuityRecorder's reasonText).
        mk('RECOVERY_STRATEGY_SELECTED', {
          strategy: decision.strategy,
          class: decision.class,
          reason: decision.reason,
          reasonKey: decision.reasonMessage.key,
          ...(decision.reasonMessage.params ? { reasonParams: decision.reasonMessage.params } : {})
        })
      ])
    )

    const action = this.note('startRecoveryAction', null as RecoveryActionRow | null, () =>
      journal.startRecoveryAction({
        runId,
        taskId,
        dispatchId: dispatch.id,
        strategy: decision.strategy,
        class: decision.class,
        reason: decision.reason,
        at: now
      })
    )

    const requested: ContinuityEvent[] =
      decision.strategy === 'resume-native'
        ? [mk('RECOVERY_NATIVE_RESUME_REQUESTED', { strategy: decision.strategy })]
        : decision.strategy === 'smart-resume'
          ? [mk('RECOVERY_SMART_RESUME_REQUESTED', { strategy: decision.strategy })]
          : []
    if (requested.length > 0) this.note('append', 0, () => journal.append(requested))

    let result: ExecuteResult
    try {
      result = await this.deps.execute({ attempt, decision, state: this.deps.getState(), now })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.log(`recovery: execute threw for dispatch ${dispatch.id}: ${message}`)
      result = { ok: false, error: message }
    }

    const outcome: ContinuityEvent[] = []
    if (result.ok) {
      if (decision.strategy === 'resume-native')
        outcome.push(mk('RECOVERY_NATIVE_RESUME_SUCCEEDED', { strategy: decision.strategy }))
      else if (decision.strategy === 'smart-resume')
        outcome.push(mk('RECOVERY_SMART_RESUME_SUCCEEDED', { strategy: decision.strategy }))
      else if (decision.strategy === 'redispatch')
        outcome.push(mk('RECOVERY_TASK_RESTARTED', { strategy: decision.strategy }))
      else if (decision.strategy === 'review')
        outcome.push(mk('RECOVERY_REQUIRES_REVIEW', { strategy: decision.strategy }))
      // recheck: no strategy-specific event — RECOVERY_STRATEGY_SELECTED already named it.
      outcome.push(mk('RECOVERY_COMPLETED', { strategy: decision.strategy }))
    } else {
      if (decision.strategy === 'resume-native')
        outcome.push(mk('RECOVERY_NATIVE_RESUME_FAILED', { strategy: decision.strategy, error: result.error }))
      else if (decision.strategy === 'smart-resume')
        outcome.push(mk('RECOVERY_SMART_RESUME_FAILED', { strategy: decision.strategy, error: result.error }))
      outcome.push(mk('RECOVERY_FAILED', { strategy: decision.strategy, error: result.error }))
    }
    this.note('append', 0, () => journal.append(outcome))

    if (action) {
      const details = result.ok ? { newDispatchId: result.newDispatchId ?? null } : { error: result.error }
      this.note('finishRecoveryAction', undefined, () =>
        journal.finishRecoveryAction(action.recoveryActionId, result.ok ? 'completed' : 'failed', now, details)
      )
    }
    return true
  }

  /** Sweeps every candidate once, one at a time — two recoveries spawning at once would fight over
   *  the concurrency limit. Returns how many attempts it acted on, not how many it fixed: a failure
   *  still counts, and is isolated so it cannot stop the rest of the sweep.
   *
   *  The initial list is only the sweep's agenda, not a fact still true by the time it is reached —
   *  each recovery awaits an executor that takes real time and changes the state, so a person can
   *  stop or abandon a worker further down the agenda while an earlier one is still being recovered.
   *  Re-checking against a fresh `candidates(getState())` right before acting is what stops that
   *  Dispatch from being restarted behind their back; a seed no longer present there is skipped
   *  without counting, and it is the fresh seed that is acted on, not the stale one.
   *
   *  An attempt recoverOne itself declines (no journal rows name it) is not counted either — it
   *  returns before anything is journaled or executed. */
  async reconcileAll(): Promise<number> {
    let count = 0
    for (const seed of candidates(this.deps.getState())) {
      const fresh = candidates(this.deps.getState()).find((c) => c.dispatch.id === seed.dispatch.id)
      if (!fresh) continue
      // The concurrency limit binds recovery too (hasRoom above) — a candidate with no room is left
      // for the next trigger, not counted as acted on.
      if (!hasRoom(this.deps.getState(), fresh.runId)) continue
      try {
        if (await this.recoverOne(fresh)) count++
      } catch (err) {
        this.deps.log(`recovery: reconcile failed for dispatch ${fresh.dispatch.id}: ${String(err)}`)
      }
    }
    return count
  }

  /** The same path for one Dispatch, used when a worker is found lost outside a full sweep (a
   *  process exit the app observes live). Re-reads the state so a Dispatch that is no longer a
   *  candidate (already reopened, already closed by a person) is quietly skipped. */
  async reconcileOne(dispatchId: string): Promise<void> {
    const seed = candidates(this.deps.getState()).find((c) => c.dispatch.id === dispatchId)
    if (!seed) return
    // Same concurrency gate as reconcileAll — a single lost worker found live is still a second
    // door into starting one, and the Run it belongs to may already be at its limit.
    if (!hasRoom(this.deps.getState(), seed.runId)) return
    await this.recoverOne(seed)
  }
}
