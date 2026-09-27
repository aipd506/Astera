// What the composer names before a chat session's first turn: the model Claude's settings choose
// (core/models/parse.ts configuredModelOf has the why and the order). Read here, in main, from the
// session's folder and the account's folder.
//
// **Asynchronously, each folder asked once through the probe budget first** (stage 4 T1). The pane asks
// on mount, and the session's folder can sit on an offline share: readFileSync there froze the Electron
// main thread for 20 to 60 s, and an async read alone still holds a libuv thread for as long. A folder
// that does not answer is not read; its files are simply not a source, like a file that is not there —
// the label is a hint the first turn corrects, never something acted on.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { configuredModelOf } from '../../core/models/parse'
import { defaultCwdProbe, type Probe } from '../../core/sessions/pathProbe'

export interface ConfiguredModelDeps {
  /** The budgeted session-folder probe by default. */
  gate?: Probe
  readFile?: (p: string) => Promise<string>
}

/** The configured model, or null. Never rejects. */
export async function readConfiguredModel(
  a: { cwd?: string; configDir: string },
  deps: ConfiguredModelDeps = {}
): Promise<string | null> {
  const gate = deps.gate ?? defaultCwdProbe
  const readFile = deps.readFile ?? ((p: string) => fs.readFile(p, 'utf8'))
  const reachable = async (dir: string): Promise<boolean> =>
    (await gate(dir).catch(() => 'timeout' as const)) !== 'timeout'
  const read = async (file: string): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(file))
    } catch {
      return null
    }
  }
  const cwdOk = a.cwd ? await reachable(a.cwd) : false
  const cfgOk = await reachable(a.configDir)
  const [local, project, user] = await Promise.all([
    cwdOk && a.cwd ? read(path.join(a.cwd, '.claude', 'settings.local.json')) : null,
    cwdOk && a.cwd ? read(path.join(a.cwd, '.claude', 'settings.json')) : null,
    cfgOk ? read(path.join(a.configDir, 'settings.json')) : null
  ])
  return configuredModelOf([local, project, user])
}
