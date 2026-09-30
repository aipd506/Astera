// What the three real desktop e2e files share (desktop.e2e.test.ts, desktop.linux.e2e.test.ts and
// desktop.mac.e2e.test.ts): the Electron the fixture runs on, a file check, and one CDP read of the
// fixture's page. Test support only; nothing in the Host imports it.
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectCdp } from './cdp'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** The Electron binary `npm ci` put in node_modules, as its own path.txt names it. */
export const electronExe = (): string =>
  path.join(repo, 'node_modules', 'electron', 'dist', readFileSync(path.join(repo, 'node_modules', 'electron', 'path.txt'), 'utf8').trim())

export const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false)

/** One expression evaluated over a fresh CDP client of the fixture's port, then closed. */
export const read2 = async (port: number, expression: string): Promise<unknown> => {
  const c = await connectCdp(port, 5_000)
  if (!c) throw new Error(`no page on port ${port}`)
  try {
    return ((await c.send('Runtime.evaluate', { expression, returnByValue: true })).result as { value?: unknown }).value
  } finally {
    c.close()
  }
}
