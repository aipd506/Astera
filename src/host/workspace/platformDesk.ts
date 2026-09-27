// Which Desk a Host's workspaces get, by platform (Linux and macOS design): the PowerShell helper on
// Windows, an Xvfb display on Linux, a background launch on macOS. One starter per Host, so the Linux
// desks share one set of reserved display numbers (R4). `linux` and `mac` replace the real deps in tests.
import path from 'node:path'
import type { DeskHandle } from '../../core/workspace/helpers'
import { spawnPowerShell, startDesktopHelper, writeDeskScript } from './desktopHelper'
import { createLinuxDesks, realLinuxDeskDeps, type LinuxDeskDeps } from './deskLinux'
import { createMacDesks, realMacDeskDeps, type MacDeskDeps } from './deskMac'

export function workspaceDeskStarter(a: {
  platform: string
  profileDir: string
  hostEnv: Record<string, string | undefined>
  log(m: string): void
  linux?: LinuxDeskDeps
  mac?: MacDeskDeps
}): (name: string) => Promise<DeskHandle> {
  if (a.platform === 'linux') {
    const desks = createLinuxDesks(a.linux ?? realLinuxDeskDeps({ hostEnv: a.hostEnv, log: a.log }))
    return (name) => desks.start(name)
  }
  if (a.platform === 'darwin') {
    const desks = createMacDesks(a.mac ?? realMacDeskDeps({ log: a.log }))
    return (name) => desks.start(name)
  }
  return async (name) => {
    const script = await writeDeskScript(path.join(a.profileDir, 'host'))
    return startDesktopHelper({ name, spawn: () => spawnPowerShell(script), log: a.log })
  }
}
