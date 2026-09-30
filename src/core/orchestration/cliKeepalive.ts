// The line a waiting command prints on stderr while it is still waiting.
//
// **Why anything is printed at all.** `ask`, `check --wait`, `jobs wait` and `runs wait` block for
// human-minutes — that is the point of them, because the thing being waited for is a person. Until
// now they printed nothing for that whole time, which makes a wait that is working look exactly like
// the one failure this repo has already been bitten by: a Host that accepted the socket and then went
// quiet (docs/2026-09-22-host-unresponsive-recovery-design.md). Whoever is watching cannot tell the
// two apart, and neither can a CI log.
//
// **Only stderr, and never stdout.** stdout carries exactly one result and its envelope is the
// contract a script reads (cliOutput.ts). Because of that, a caller needs no filter to strip these
// lines: `astera runs wait --id r | jq .data` is unaffected by them. They are diagnostics, they have
// no contract, and their shape may change — the same footing as `logToStderr` (src/cli/host.ts),
// whose `astera: ` prefix they share.
//
// **The line is pure here and the timer is in run.ts**, the same split as cliHuman.ts: what to print
// is decided without a clock, a socket or a process.
import { GIT_WRITE_TIMEOUT_MS } from '../worktrees/git'
import { HOST_UNRESPONSIVE_MS, PING_MS } from '../host/unresponsive'
import { spelledCommand } from './cliUsage'

/**
 * How often a waiting command says it is still waiting.
 *
 * **This is not a new number, and it must not become one.** `HOST_UNRESPONSIVE_MS` is this repo's
 * single answer to "how long may a Host that has said hello go silent before it is not merely slow"
 * — the app's heartbeat derives its miss count from it, and `astera host stop` times its wait for a
 * `retire` reply by it (core/host/unresponsive.ts). A keepalive exists to tell a live wait from a
 * wedged Host, which is the same question those two ask, so it asks it on the same clock. Two
 * independently chosen intervals would let the CLI and the app disagree about the same Host.
 *
 * The volume this implies was checked rather than assumed: the longest deadline in the program is
 * `jobs wait`'s one hour, which is 240 lines of stderr — a log a person scrolls, not a stream.
 * Doubling the interval would halve that and double how long a wedged Host goes unreported, and the
 * volume was never the problem.
 */
export const KEEPALIVE_MS = HOST_UNRESPONSIVE_MS

/**
 * How often the Host is asked whether its event loop is still turning while a wait is on.
 *
 * **It has to be shorter than the line, or the line cannot say anything true.** Asked once per line,
 * every healthy Host would report a last answer exactly one interval old — the same number an
 * unresponsive one reports — and the field would carry no information at all.
 *
 * **It is the app's own `PING_MS`, not a divisor written a second time.** This used to say
 * `HOST_UNRESPONSIVE_MS / 3`, which is the arithmetic `PING_MISSES` does in `main/host/client.ts`
 * (`HOST_UNRESPONSIVE_MS / PING_MS`) with the answer hardcoded — so a change to `PING_MS` would have
 * moved the app's heartbeat and left this one where it was, silently. The constant moved to
 * core/host/unresponsive.ts instead, beside the threshold it is paired with, and both processes now
 * ask the same Host at the same rate by construction.
 */
export const KEEPALIVE_PING_MS = PING_MS

/**
 * How long the CLI waits for a merge command (`run-merge`, `run-delete --merge`) before it says the Host
 * did not answer.
 *
 * **Longer than the Host can take, or the client gives up on a merge the Host then finishes** — and for
 * `run-delete` goes on to delete the Run. Each git write in a merge runs under GIT_WRITE_TIMEOUT_MS (10
 * minutes), and one worktree is up to three of them (the `merge-tree` probe, the merge, and on failure
 * the abort). The client cannot know how many worktrees a Run has, so this is a fixed, generous value:
 * six full write ceilings, one hour — two worktrees that each hit the ceiling on every write. A real
 * merge takes seconds; this only runs out when several writes are truly hung. `--timeout-ms` still wins.
 */
export const MERGE_CLIENT_TIMEOUT_MS = 6 * GIT_WRITE_TIMEOUT_MS

/** A call that makes the Host merge worktrees — see MERGE_CLIENT_TIMEOUT_MS. */
export function mergeCommand(a: { cmd: string; args: Record<string, unknown> }): boolean {
  return a.cmd === 'run-merge' || (a.cmd === 'run-delete' && a.args.merge === true)
}

/**
 * Is this call one that blocks for a person — or for a merge?
 *
 * The four that long-poll, plus the merge commands (mergeCommand), and no others. A merge can run for
 * minutes on a big repository, and a silent stderr for that long looks exactly like a wedged Host.
 * `browser js` has a deadline too and is deliberately not here: it waits for a script in a browser,
 * which finishes in seconds and has no person in it, so a keepalive would be noise on a command whose
 * output is not a wait.
 */
export function waitingCommand(a: { cmd: string; args: Record<string, unknown> }): boolean {
  if (mergeCommand(a)) return true
  // `runs follow` prints events on stdout as they land, and between two of them it can be as quiet as
  // a wait. These lines go to stderr, so the event stream on stdout stays exactly one line per event.
  if (a.cmd === 'ask' || a.cmd === 'jobs-wait' || a.cmd === 'runs-wait' || a.cmd === 'runs-follow') return true
  // `check` blocks only when asked to. Without --wait it answers at once, and a keepalive on it
  // would be a line about a wait that never happened.
  // `sessions send --wait` waits for the turn it started; without --wait it answers once the text went.
  return (a.cmd === 'check' || a.cmd === 'sessions-send') && a.args.wait === true
}

/** `45s`, `3m 20s`. Seconds alone stop reading as a duration somewhere around a minute, and the
 *  longest wait here is an hour. */
export function elapsedWord(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m ${total % 60}s`
}

/**
 * One keepalive.
 *
 * **It says what the Host is doing, not only what this process is doing.** A timer that only proves
 * the CLI is alive answers the easy half of the question and leaves the half that matters: a CLI
 * happily printing keepalives at a Host whose event loop stopped turning is the exact picture this
 * feature exists to break. So when the Host announced the `ping` feature, each line carries how long
 * ago it last answered one. `silentMs` is `null` for a Host that does not have it, and then the line
 * says only what it can honestly say.
 */
export function keepaliveLine(a: {
  cmd: string
  elapsedMs: number
  /** Time since the Host's last `pong`, or `null` when this Host has no heartbeat to ask. */
  silentMs: number | null
}): string {
  const head = `waiting for ${spelledCommand(a.cmd)}, ${elapsedWord(a.elapsedMs)} so far`
  if (a.silentMs === null) return head
  if (a.silentMs < KEEPALIVE_MS) return `${head}; the Host answered ${elapsedWord(a.silentMs)} ago`
  // Past the threshold the app itself calls a Host unresponsive. The line stops reassuring and says
  // the number, because from here the honest reading is that this may no longer be a wait at all.
  return `${head}; the Host has not answered a ping for ${elapsedWord(a.silentMs)}`
}

/**
 * How long a command that does not wait may go without an answer before it says so on stderr.
 *
 * **Slow is acceptable; looking frozen is not.** `status`, `jobs list` and the rest answer in
 * milliseconds from a healthy Host, so for them a keepalive from the first second would be noise on
 * every line. But a Host that is busy or wedged holds them for up to the client deadline, five and a
 * half minutes, and until now that was five and a half minutes of nothing. Three seconds is well past
 * any answer a healthy Host gives these, and short enough that a person has not yet started to wonder.
 */
export const SLOW_ANSWER_NOTICE_MS = 3_000

/**
 * How long before the first notice its ping goes out, so the notice can already say whether the Host
 * answered. A pong from a live Host takes milliseconds; a second is room to spare.
 */
export const SLOW_ANSWER_PING_LEAD_MS = 1_000

/**
 * Does a command that does not wait get the late-answer notice at all?
 *
 * **Every one but the two script runners.** `browser js` and `app js` run a script that may
 * legitimately take many seconds, so a slow answer there is the script working rather than a Host in
 * trouble. `browser js` is bounded by its 60 second deadline; `app js` by the same 60 seconds plus up
 * to LAUNCH_WAIT_MAX_MS (5 minutes) spent waiting for the app to start, which that deadline does not
 * count (core/workspace/script.ts). And an agent is who calls them: its tool output
 * would fill with lines that say nothing it needs.
 */
export function slowAnswerNotice(cmd: string): boolean {
  return cmd !== 'browser-js' && cmd !== 'app-js'
}

/**
 * The line a command that does not wait prints once it has waited `SLOW_ANSWER_NOTICE_MS` for its
 * answer, and every `KEEPALIVE_MS` after that.
 *
 * **Same family as keepaliveLine, one difference in the tail.** The first notice comes at three
 * seconds, long before the fifteen second threshold keepaliveLine judges by, so waiting for that
 * threshold would make the first line reassure about a Host that has just ignored a ping. A ping
 * sent and not yet answered (`pingUnanswered`) is therefore the fact itself: the Host did not answer.
 * An answered one means its event loop is turning, which is what "still working" can honestly claim.
 */
export function slowAnswerLine(a: {
  cmd: string
  elapsedMs: number
  /** Time since the Host last answered anything, or `null` when this Host has no heartbeat. */
  silentMs: number | null
  /** A ping went out after the last answer and has not come back. */
  pingUnanswered: boolean
}): string {
  const head = `waiting for the Host to answer ${spelledCommand(a.cmd)}, ${elapsedWord(a.elapsedMs)} so far`
  if (a.silentMs === null) return head
  if (a.pingUnanswered || a.silentMs >= KEEPALIVE_MS)
    return `${head}; the Host has not answered a ping for ${elapsedWord(a.silentMs)}`
  return `${head}; the Host is still working (it answered a ping ${elapsedWord(a.silentMs)} ago)`
}

/**
 * When `host start` and `host stop` first say they are still waiting, and how often after that (stage 4 T6).
 *
 * **Slow is acceptable; looking frozen is not**, the same rule as SLOW_ANSWER_NOTICE_MS, but these two
 * have no Host to ping: `start` is waiting for one to exist, and `stop` for one to be gone. A first
 * start can take several seconds (the runtime checks, the journal opening), and a stop waits out the
 * Host's own settle, with the workspaces capped at 10 s and the log flush at 1 s. One second is past
 * the time either takes when nothing is in the way, so a quick start or stop prints nothing; five
 * seconds after that is often enough that a person never wonders whether it hung.
 */
export const HOST_WAIT_NOTICE_MS = 1_000
export const HOST_WAIT_EVERY_MS = 5_000

/**
 * The line `host start` or `host stop` prints on stderr while it waits, or `null` for a `host-*`
 * command that does not wait (`host status` is one connect). Plain ASCII dots rather than an ellipsis
 * character, so an older Windows console code page cannot mangle it.
 */
export function hostWaitLine(a: { cmd: string; elapsedMs: number }): string | null {
  const so = `(${elapsedWord(a.elapsedMs)} so far)`
  if (a.cmd === 'host-start') return `Starting the Astera Host... ${so}`
  if (a.cmd === 'host-stop') return `Waiting for the Host to leave... ${so}`
  return null
}
