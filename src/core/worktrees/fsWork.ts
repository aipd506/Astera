// Disk work that changes something (rm, rmdir, unlink, a copy, the link walk before a removal), run
// with its own deadline and **outside** the probe budget (sessions/pathProbe.ts).
//
// The probe budget is for the reachability question only: "is this folder there", answered within
// PROBE_TIMEOUT_MS (1.5 s). A call that runs past that marks its root stuck for every lane — sessions
// on that drive fail as unreachable, presence checks answer refused, PATH lookups answer absent. That is
// right for an lstat on a dead share and wrong for an rm of a large tree, which is simply slow. So the
// mutating work goes through here instead: asked only after a probe said the root answers, given a
// generous deadline of its own, and never counted as stuck.
//
// A deadline here does not stop the work (Node cannot cancel an fs call); it stops the waiting. The
// answer is then `timeout`, and a caller must read that as "not known", never as done.

/** How long mutating disk work may take before its caller stops waiting. Long enough for an rm of a
 *  large node_modules on a slow disk; short enough that a hung share does not hold a creation forever. */
export const FS_WORK_TIMEOUT_MS = 120_000

export type FsWorkResult = 'done' | 'failed' | 'timeout'

/** Runs `work` with a deadline. `done` when it resolved in time, `failed` when it rejected, `timeout`
 *  when it did not settle within `timeoutMs`. Never rejects; a late settle is swallowed. */
export function runFsWork(work: () => Promise<unknown>, timeoutMs: number = FS_WORK_TIMEOUT_MS): Promise<FsWorkResult> {
  return new Promise<FsWorkResult>((resolve) => {
    let settled = false
    const finish = (r: FsWorkResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    Promise.resolve()
      .then(work)
      .then(
        () => finish('done'),
        () => finish('failed')
      )
  })
}
