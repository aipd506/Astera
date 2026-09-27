// The process tools the workspace needs outside a desk: creation times for the leftover rule, a tree
// kill, and a free loopback port. On Windows, PowerShell and taskkill (the conhost reaper's route,
// src/host/conhostReaper.ts); on Linux and macOS, /proc or ps and a process group kill (posixProc.ts).
import { execFile } from 'node:child_process'
import net from 'node:net'
import { treeKillCommand } from '../../core/run/kill'
import { killGroup, linuxStartTimes, macStartTimes, realLinuxProcFs, realSignals, type LinuxProcFs, type Signals } from './posixProc'

export type Exec = (file: string, args: string[]) => Promise<string>

const defaultExec: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 30_000 }, (err, stdout) =>
      err ? reject(Object.assign(err, { stdout: String(stdout) })) : resolve(String(stdout))
    )
  })

let defaultLinuxProc: LinuxProcFs | null = null

/** Each live pid's creation time in epoch ms. One query for all of them. */
export async function processStartTimes(pids: number[], exec: Exec = defaultExec, platform: string = process.platform): Promise<Map<number, number>> {
  for (const p of pids) if (!Number.isSafeInteger(p) || p <= 0) throw new Error(`not a pid: ${p}`)
  if (platform === 'linux') return linuxStartTimes(pids, exec === defaultExec ? (defaultLinuxProc ??= realLinuxProcFs(exec)) : realLinuxProcFs(exec))
  if (platform === 'darwin') return macStartTimes(pids, exec)
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

/** Ends `pid` and every process it started. On Windows through taskkill, which answers 128 for a
 *  process already gone; elsewhere its process group (R10). Gone is not a failure: the result the
 *  caller wanted is already true. */
export async function killTree(pid: number, exec: Exec = defaultExec, platform: string = process.platform, signals: Signals = realSignals): Promise<void> {
  if (platform !== 'win32') return killGroup(pid, signals)
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
