// Stage 3, task 3: every log the app and the Host write goes through the shared writer (logWriter.ts),
// and each quit path flushes it. A grep over the sources, so an `appendFileSync` that comes back in a
// log path fails here rather than on somebody's frozen window.
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

describe('log sites (stage 3, task 3)', () => {
  it('no file in src/main or src/host appends synchronously', () => {
    const offenders = [...sources(path.join(src, 'main')), ...sources(path.join(src, 'host'))]
      .filter((f) => /appendFileSync\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(src, f))
    expect(offenders).toEqual([])
  })

  it('the Host log no longer stats per line', () => {
    expect(read('host/log.ts')).not.toMatch(/statSync/)
    expect(read('host/log.ts')).toMatch(/core\/log\/logWriter/)
  })

  it('every file that writes one of the logs goes through the shared writer', () => {
    const writers: Record<string, string[]> = {
      'main/index.ts': ["'slack.log'", "'rolling.log'", "'orchestration.log'", "'host-client.log'", "'updater.log'"],
      'main/core.ts': ["'chat.log'", "'sessions.log'", "'worktrees.log'"],
      'host/rollingLog.ts': ["'rolling.log'"],
      'host/slackWiring.ts': ["'slack.log'"]
    }
    for (const [file, names] of Object.entries(writers)) {
      const text = read(file)
      expect(text, file).toMatch(/from '\.\.\/core\/log\/logWriter'/)
      for (const n of names) {
        // The name is kept, and it is handed to lineLog on its own line or the next.
        const at = text.indexOf(n)
        expect(at, `${file} ${n}`).toBeGreaterThan(-1)
        const stmt = text.slice(text.lastIndexOf('\n', at), text.indexOf('\n', text.indexOf('\n', at) + 1))
        expect(stmt, `${file} ${n}`).toMatch(/lineLog\(/)
      }
    }
  })

  it('the app flushes the logs on before-quit and at the end of will-quit', () => {
    const text = read('main/index.ts')
    expect(blockAfter(text, "app.on('before-quit'")).toMatch(/flushAllLogsSync\(\)/)
    // Its own will-quit listener, registered after the cleanup's, so it runs last and the lines the
    // cleanup itself writes are on disk too; the cleanup's early return cannot skip it.
    const first = text.indexOf("app.on('will-quit'")
    const last = text.lastIndexOf("app.on('will-quit'")
    expect(last).toBeGreaterThan(first)
    expect(blockAfter(text.slice(first), "app.on('will-quit'")).not.toMatch(/flushAllLogsSync/)
    expect(blockAfter(text.slice(last), "app.on('will-quit'")).toMatch(/^app\.on\('will-quit', \(\) => \{\s*flushAllLogsSync\(\)\s*$/)
  })

  it('the Host flushes the logs when it leaves, before it exits', () => {
    const leave = blockAfter(read('host/index.ts'), 'const leave = (why?: string): void => {')
    const flushAt = leave.indexOf('flushAllLogsSync()')
    expect(flushAt).toBeGreaterThan(-1)
    expect(flushAt).toBeLessThan(leave.indexOf('process.exit(0)'))
  })
})
