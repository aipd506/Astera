// The agent app workspace setting from app-settings.json, read by a process that is not the app (the
// Host answers `app js` with the app closed; plan ruling P3).
import { readAppSettingsObject } from './settingsObject'

/**
 * - **Missing file: off**, the store's default: the feature launches apps on the person's behalf.
 * - **A valid file**: on only for an explicit `true`, the narrowing `skillSettingsOf` applies.
 * - **Unreadable, or not a JSON object: it throws**, because the file may have said on, and answering
 *   off would tell the agent a setting the person turned on is off.
 *
 * Shares its file read with `readAgentPermissionMode` (`readAppSettingsObject`, preflight ruling F5).
 */
export async function readAgentAppEnabled(filePath: string): Promise<boolean> {
  const parsed = await readAppSettingsObject(filePath)
  return parsed?.agentAppEnabled === true
}
