// Stage 3, task 3: every log the app and the Host write goes through the shared writer (logWriter.ts),
// and each quit path flushes it. A grep over the sources, so an `appendFileSync` that comes back in a
// log path fails here rather than on somebody's frozen window. The patterns match any layout (review
// M8): an import, a call, a `fs.` prefix, a call split across lines.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

const read = (rel: string): string => readFileSync(path.join(src, rel), 'utf8')
/** The body of the first `<head>... => {` block, up to its closing line `})` at the head's indent. */
function blockAfter(text: string, head: string): string {
  const at = text.indexOf(head)
  if (at < 0) return ''
  const lineStart = text.lastIndexOf('\n', at) + 1
  const indent = text.slice(lineStart, at).match(/^\s*/)![0]
  const end = text.indexOf(`\n${indent}}`, at)
  return end < 0 ? text.slice(at) : text.slice(at, end)
}
const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Each file that writes a log, and the log names it writes. */
const writers: Record<string, string[]> = {
  'main/index.ts': ['slack.log', 'rolling.log', 'orchestration.log', 'host-client.log', 'updater.log'],
  'main/core.ts': ['chat.log', 'sessions.log', 'worktrees.log'],
  'host/rollingLog.ts': ['rolling.log'],
  'host/slackWiring.ts': ['slack.log'],
  'host/log.ts': []
}

describe('log sites (stage 3, task 3)', () => {
  it('no file in src/main or src/host appends synchronously, however it is spelled', () => {
    const offenders = [...sources(path.join(src, 'main')), ...sources(path.join(src, 'host'))]
      .filter((f) => /\bappendFileSync\b/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(src, f))
    expect(offenders).toEqual([])
  })

  it('no file that writes one of the logs touches a sync append or write anywhere', () => {
    for (const file of Object.keys(writers)) expect(read(file), file).not.toMatch(/\b(appendFileSync|writeFileSync)\b/)
  })

  it('the Host log no longer stats per line', () => {
    expect(read('host/log.ts')).not.toMatch(/\bstatSync\b/)
    expect(read('host/log.ts')).toMatch(/core\/log\/logWriter/)
  })

  it('every file that writes one of the logs goes through the shared writer', () => {
    for (const [file, names] of Object.entries(writers)) {
      const text = read(file)
      expect(text, file).toMatch(/from\s*['"]\.\.\/core\/log\/logWriter['"]/)
      for (const n of names) {
        const name = `['"]${esc(n)}['"]`
        // Handed to lineLog directly, or through a const that lineLog is then given — any layout.
        const direct = new RegExp(`lineLog\\(\\s*path\\.join\\([\\s\\S]{0,200}?${name}`)
        const viaConst = new RegExp(`const\\s+(\\w+)\\s*=\\s*path\\.join\\([\\s\\S]{0,200}?${name}`).exec(text)
        const ok = direct.test(text) || (viaConst !== null && new RegExp(`lineLog\\(\\s*${viaConst[1]}\\s*\\)`).test(text))
        expect(ok, `${file} ${n}`).toBe(true)
      }
    }
  })

  it('the app flushes the logs on before-quit and in a will-quit listener after the cleanup', () => {
    const text = read('main/index.ts')
    expect(blockAfter(text, "app.on('before-quit'")).toMatch(/flushAllLogsSync\s*\(\s*\)/)
    // Its own will-quit listener, registered after the cleanup's, so it runs last and the lines the
    // cleanup itself writes are on disk too; the cleanup's early return cannot skip it.
    const first = text.indexOf("app.on('will-quit'")
    const last = text.lastIndexOf("app.on('will-quit'")
    expect(last).toBeGreaterThan(first)
    expect(blockAfter(text.slice(last), "app.on('will-quit'")).toMatch(/flushAllLogsSync\s*\(\s*\)/)
  })

  it('the Host awaits the in-flight log writes (capped), then flushes the rest, before it exits', () => {
    const leave = blockAfter(read('host/index.ts'), 'const leave = (why?: string): void => {')
    const awaited = /await[\s\S]{0,120}?\bflushAll\s*\(\s*\)/.exec(leave)
    expect(awaited).not.toBeNull()
    const syncAt = leave.search(/flushAllLogsSync\s*\(\s*\)/)
    expect(awaited!.index).toBeLessThan(syncAt)
    expect(syncAt).toBeLessThan(leave.indexOf('process.exit(0)'))
  })
})
