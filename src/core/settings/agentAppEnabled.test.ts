import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readAgentAppEnabled } from './agentAppEnabled'
import { RepairNeeded } from './repairNeeded'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-appws-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})
const file = (): string => path.join(dir, 'app-settings.json')

describe('readAgentAppEnabled (plan ruling P3)', () => {
  it('is off with no settings file, and on only for an explicit true', async () => {
    expect(await readAgentAppEnabled(file())).toBe(false)
    await fs.writeFile(file(), JSON.stringify({ agentAppEnabled: true }))
    expect(await readAgentAppEnabled(file())).toBe(true)
    await fs.writeFile(file(), JSON.stringify({ agentAppEnabled: 'yes' }))
    expect(await readAgentAppEnabled(file())).toBe(false)
  })

  it('throws RepairNeeded for a file it cannot read, rather than guessing off', async () => {
    await fs.writeFile(file(), '{not json')
    const err = await readAgentAppEnabled(file()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RepairNeeded)
    expect((err as RepairNeeded).file).toBe('app-settings.json')
    expect(String(err)).toContain('open Astera to repair it')
  })
})
