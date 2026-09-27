// The process tools the workspace needs outside a helper: creation times for the leftover rule, a
// tree kill, and a free loopback port. Windows PowerShell and taskkill, the conhost reaper's route
// (src/host/conhostReaper.ts); the port is Node's own.
import { execFile } from 'node:child_process'
import net from 'node:net'
import { treeKillCommand } from '../../core/run/kill'

export type Exec = (file: string, args: string[]) => Promise<string>

const defaultExec: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 30_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
  })

/** Each live pid's creation time in epoch ms. One query for all of them. */
export async function processStartTimes(pids: number[], exec: Exec = defaultExec): Promise<Map<number, number>> {
  for (const p of pids) if (!Number.isSafeInteger(p) || p <= 0) throw new Error(`not a pid: ${p}`)
  const out = new Map<number, number>()
  if (pids.length === 0) return out
  const filter = pids.map((p) => `ProcessId=${p}`).join(' OR ')
  const script =
    `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { ` +
    `'{0}|{1}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }`
  const text = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  for (const line of text.split(/\r?\n/)) {
    const [pid, ms] = line.trim().split('|').map(Number)
    if (Number.isSafeInteger(pid) && pid > 0 && Number.isFinite(ms)) out.set(pid, ms)
  }
  return out
}

/** Ends `pid` and every process it started. A process already gone is not a failure: taskkill
 *  answers 128 for it, and the result the caller wanted is already true. */
export async function killTree(pid: number, exec: Exec = defaultExec): Promise<void> {
  const cmd = treeKillCommand('win32', pid)
  if (!cmd) return
  await exec(cmd.file, cmd.args).catch((err: { code?: unknown }) => {
    if (err?.code === 128) return ''
    throw err
  })
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}
