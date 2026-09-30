// What `launch({ config })` and `launch({ command, cwd? })` mean in the Host: a Run configuration of
// the session's project, found by id or name in run-configs.json and assembled by the app's own rule
// (prepareRun, then buildCommand), or a command in the session's folder. The Host reads the file the
// app writes, read only, as it does for `run-configs list` with the app closed (CLI phase D).
import path from 'node:path'
import { t, type MessageKey } from '../../core/i18n'
import { prepareRun } from '../../core/run/prepare'
import { readRunConfigsFile, readStoredRunConfigs } from '../../core/run/runConfigsFile'
import { launchEnv, type LaunchSpec, type ResolvedLaunch } from '../../core/workspace/helpers'

export function createLaunchResolver(d: {
  runConfigsFile: string
  platform: string
  /** The environment a launched app starts from: the Host's own minus what only the Host needs. */
  baseEnv(): Record<string, string | undefined>
  projectRoot(cwd: string): Promise<string>
}): (a: { sessionId: string; cwd: string; spec: LaunchSpec }) => Promise<ResolvedLaunch> {
  return async ({ cwd, spec }) => {
    if ('command' in spec) {
      const dir = spec.cwd === undefined ? cwd : path.resolve(cwd, spec.cwd)
      return { command: spec.command, cwd: dir, env: launchEnv(d.baseEnv(), {}, d.platform) }
    }
    const root = await d.projectRoot(cwd)
    const configs = await readRunConfigsFile(d.runConfigsFile, root)
    const hit = configs.find((c) => c.id === spec.config) ?? configs.find((c) => c.name === spec.config)
    if (!hit) {
      const names = configs.map((c) => c.name).join(', ')
      throw new Error(`launch: no Run configuration ${spec.config} in ${root}${names ? ` (there are: ${names})` : ''}`)
    }
    const prepared = await prepareRun({
      projectPath: root,
      configId: hit.id,
      stored: await readStoredRunConfigs(d.runConfigsFile, root),
      assertAllowedPath: async (p) => p,
      t: (key, params) => t('en', key as MessageKey, params)
    })
    return { command: prepared.command, cwd: prepared.config.cwd ?? root, env: launchEnv(d.baseEnv(), prepared.config.env ?? {}, d.platform) }
  }
}
