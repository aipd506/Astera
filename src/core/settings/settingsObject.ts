import { promises as fs } from 'node:fs'
import { RepairNeeded } from './repairNeeded'

/** The text of app-settings.json as its readers take it: a JSON object, or a throw. Same guard as the
 *  sibling stores (ProjectSettings, RunConfigStore) — typeof [] === 'object', so an array would
 *  otherwise pass straight through. In core so the Host's read (agentPermissionMode.ts) and the app's
 *  store (main/appSettingsStore.ts) parse the file the same way. */
export function settingsObjectOf(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid schema')
  return parsed as Record<string, unknown>
}

/**
 * The whole of app-settings.json, read by a process that is not the app: `readAgentPermissionMode`
 * and `readAgentAppEnabled` both build on this rather than each opening and parsing the file
 * themselves (preflight ruling F5) — one read, one parse, one pair of `RepairNeeded` messages.
 *
 * - **Missing file: `null`**, distinct from an empty object, so each caller applies its own default
 *   (D12's 'yolo' for the permission mode, off for the agent app workspace).
 * - **A valid file:** the parsed object, `settingsObjectOf`'s guard applied.
 * - **Unreadable, or not a JSON object: it throws** `RepairNeeded`. The file may have set a field a
 *   caller cares about, and answering as though it were empty would tell an agent that a setting the
 *   person turned on is off. The caller refuses rather than guess.
 */
export async function readAppSettingsObject(filePath: string): Promise<Record<string, unknown> | null> {
  let text: string
  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new RepairNeeded(`app-settings.json could not be read (${String(err)}); open Astera to repair it`, 'app-settings.json')
  }
  try {
    return settingsObjectOf(text)
  } catch {
    throw new RepairNeeded('app-settings.json is not a valid settings file; open Astera to repair it', 'app-settings.json')
  }
}
