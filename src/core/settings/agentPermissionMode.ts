// The permission mode from app-settings.json, read by a process that is not the app (the Host).
import type { AgentPermissionMode } from '../types'
import { readAppSettingsObject } from './settingsObject'

/** The store's own narrowing: only the explicit 'manual' turns the bypass off. */
export function agentPermissionModeOf(value: unknown): AgentPermissionMode {
  return value === 'manual' ? 'manual' : 'yolo'
}

/**
 * Read only; not AppSettingsStore.load, which copies a file it cannot parse to `.bak`, and the app is
 * the file's only writer.
 *
 * - **Missing file: 'yolo'**, the store's default and D12's choice for a profile that has never saved
 *   a setting: 'manual' would stop a headless worker at its first command with nobody to answer.
 * - **A valid file** narrows the field the way `load` does: only 'manual' is manual.
 * - **Unreadable, or not a JSON object: it throws** with a message that says what to do. It does not
 *   answer 'yolo', because the file may have said 'manual', and answering the bypass would start the
 *   Host's workers with permissions off. The caller refuses the spawn. The same rule
 *   readSkillSettings (main/appSettingsStore.ts) and accountsFile.ts apply.
 *
 * Shares its file read with `readAgentAppEnabled` (`readAppSettingsObject`, preflight ruling F5).
 */
export async function readAgentPermissionMode(filePath: string): Promise<AgentPermissionMode> {
  const parsed = await readAppSettingsObject(filePath)
  return agentPermissionModeOf(parsed?.agentPermissionMode)
}
