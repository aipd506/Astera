import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseCodexForResume, parseCodexMeta, parseCodexPreview, parseCodexTail } from './codexParser'
import { openTranscriptSource, type OpenTranscriptSource } from './transcriptWindow'
import {
  referenceParseCodexForResume,
  referenceParseCodexMeta,
  referenceParseCodexPreview,
  referenceParseCodexTail
} from './fixtures/codexParserReference'

// The windowed codex readers must give the same answer as the readers they replaced (kept verbatim in
// fixtures/codexParserReference.ts) on every rollout that fits in the window, and read only the window
// on rollouts that do not. The same contract parserWindow.test.ts holds the claude parser to.

let tmp: string
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-codex-window-'))
})
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})
afterEach(() => {
  vi.restoreAllMocks()
})

const line = (obj: unknown): string => JSON.stringify(obj)

async function write(name: string, content: string): Promise<string> {
  const file = path.join(tmp, name)
  await fs.writeFile(file, content, 'utf8')
  return file
}

/** Wraps the real source and counts every byte handed back to the parser. */
function countingOpen(): { open: OpenTranscriptSource; bytes: () => number } {
  let total = 0
  const open: OpenTranscriptSource = async (filePath) => {
    const src = await openTranscriptSource(filePath)
    return {
      size: src.size,
      read: async (position, length) => {
        const buf = await src.read(position, length)
        total += buf.length
        return buf
      },
      close: () => src.close()
    }
  }
  return { open, bytes: () => total }
}

function base64Of(bytes: number, seed: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let chunk = ''
  for (let i = 0; i < 4096; i++) chunk += alphabet[(i * 7 + seed) % 64]
  return chunk.repeat(Math.ceil(bytes / chunk.length)).slice(0, bytes)
}

const ts = (i: number, s = 0): string => `2026-09-11T10:${String(i % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`

const meta = (extra: Record<string, unknown> = {}): string =>
  line({
    timestamp: ts(0),
    type: 'session_meta',
    payload: { id: '019f3f12-9c11-7cc1-9198-aeeaa6463dd2', cwd: '/w/demo', source: 'cli', originator: 'codex-tui', ...extra }
  })
const msg = (role: string, text: string, i: number, s = 0): string =>
  line({
    timestamp: ts(i, s),
    type: 'response_item',
    payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] }
  })
/** A pasted screenshot the way codex records it: a data URL in an input_image block, text beside it. */
const imageMsg = (text: string, bytes: number, seed: number, i: number): string =>
  line({
    timestamp: ts(i, 30),
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_image', image_url: `data:image/png;base64,${base64Of(bytes, seed)}` },
        { type: 'input_text', text }
      ]
    }
  })

function turnLines(i: number): string[] {
  const out = [
    msg('user', `요청 ${i} — 이것을 고쳐 주세요`, i),
    line({ timestamp: ts(i, 1), type: 'event_msg', payload: { type: 'task_started' } }),
    line({ timestamp: ts(i, 2), type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAAA' } }),
    line({
      timestamp: ts(i, 3),
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: `{"cmd":"npm test -- ${i}"}`, call_id: `c${i}` }
    }),
    line({ timestamp: ts(i, 4), type: 'response_item', payload: { type: 'function_call_output', call_id: `c${i}`, output: `out ${i}` } }),
    msg('assistant', `응답 ${i}`, i, 5)
  ]
  if (i % 4 === 0) out.push(msg('user', `<environment_context>\n  <cwd>/w/demo</cwd>\n</environment_context>`, i, 6))
  if (i % 5 === 0) out.push(msg('developer', `<permissions instructions>\nskill ${i}`, i, 7))
  if (i % 6 === 0) out.push(msg('assistant', `후속 ${i}`, i, 8))
  if (i % 7 === 0) out.push('{"type":"response_item", broken')
  if (i % 8 === 0) out.push('')
  return out
}

function rollout(turns: number, opts?: { images?: boolean; bigMeta?: boolean }): string[] {
  const lines = [
    opts?.bigMeta ? meta({ base_instructions: { text: 'You are Codex. '.repeat(25_000) } }) : meta(),
    line({ timestamp: ts(0, 1), type: 'turn_context', payload: { cwd: '/w/demo' } }),
    msg('developer', '<permissions instructions>\nSandbox notes', 0, 2),
    msg('user', '# AGENTS.md instructions for /w/demo\n\nbe nice', 0, 3),
    msg('user', '<environment_context>\n  <cwd>/w/demo</cwd>\n</environment_context>', 0, 4)
  ]
  for (let i = 0; i < turns; i++) {
    lines.push(...turnLines(i))
    if (opts?.images && i % 9 === 4) lines.push(imageMsg(`붙인 그림 ${i} 을 봐 주세요`, 300_000, i, i))
  }
  return lines
}

const fixture = readFileSync(path.join(__dirname, 'fixtures/codex-rollout.jsonl'), 'utf8')

const fixtures: Array<[string, () => string]> = [
  ['codex-rollout.jsonl', () => fixture],
  ['empty', () => ''],
  ['meta only', () => meta()],
  ['few turns', () => rollout(3).join('\n')],
  ['many turns, trailing newline', () => rollout(40).join('\n') + '\n'],
  ['many turns, CRLF', () => rollout(30).join('\r\n')],
  ['a big session_meta line (base_instructions)', () => rollout(25, { bigMeta: true }).join('\n')],
  ['pasted screenshots', () => rollout(45, { images: true }).join('\n')],
  ['title after many wrapper lines', () =>
    [meta(), ...Array.from({ length: 30 }, (_, i) => msg('developer', `d${i}`, i)), msg('user', '늦은 첫 요청', 31), ...rollout(3).slice(1)].join('\n')],
  ['answers before exactly three turns', () =>
    [
      meta(),
      ...Array.from({ length: 3 }, (_, i) => msg('assistant', `lead ${i} ` + 'x'.repeat(3000), i)),
      ...Array.from({ length: 3 }, (_, i) => [msg('user', `q${i}`, i, 10), msg('assistant', `a${i} ` + 'y'.repeat(3000), i, 11)]).flat()
    ].join('\n')],
  ['assistant only', () => [meta(), ...Array.from({ length: 5 }, (_, i) => msg('assistant', `a${i}`, i))].join('\n')],
  ['old event_msg shape only', () =>
    [meta(), line({ type: 'event_msg', payload: { type: 'user_message', message: 'old' } }), ...rollout(2).slice(1)].join('\n')]
]

const TAILS = [64, 300, 1000, 4096]

describe('windowed codex parse — identical to the old readers', () => {
  for (const [name, content] of fixtures) {
    const slug = name.replace(/\W+/g, '_')

    it(`${name}: fits in the default window`, async () => {
      const file = await write(`fit-${slug}.jsonl`, content())
      expect(await parseCodexMeta(file)).toEqual(await referenceParseCodexMeta(file))
      expect(await parseCodexMeta(file, 5)).toEqual(await referenceParseCodexMeta(file, 5))
      expect(await parseCodexTail(file)).toEqual(await referenceParseCodexTail(file))
      expect(await parseCodexForResume(file)).toEqual(await referenceParseCodexForResume(file))
      for (const maxTurns of [10, 3, 1]) {
        expect(await parseCodexPreview(file, maxTurns)).toEqual(await referenceParseCodexPreview(file, maxTurns))
      }
    })

    it(`${name}: grown from a tiny window, a cut through every kind of line`, async () => {
      const file = await write(`grow-${slug}.jsonl`, content())
      const wantMeta = await referenceParseCodexMeta(file)
      for (const headBytes of [16, 128, 1000]) {
        expect(await parseCodexMeta(file, 40, { headBytes })).toEqual(wantMeta)
      }
      const wantResume = await referenceParseCodexForResume(file)
      for (const tailBytes of TAILS) {
        expect(await parseCodexForResume(file, { tailBytes })).toEqual(wantResume)
        // The tail is one fixed window, as before: the same cut must give the same answer
        expect(await parseCodexTail(file, tailBytes)).toEqual(await referenceParseCodexTail(file, tailBytes))
      }
      for (const maxTurns of [10, 3, 1]) {
        const want = await referenceParseCodexPreview(file, maxTurns)
        for (const tailBytes of TAILS) {
          expect(await parseCodexPreview(file, maxTurns, { tailBytes })).toEqual(want)
        }
      }
    })
  }

  it('a request line cut by the first window is read once, whole, never as a fragment', async () => {
    const lines = rollout(30)
    const content = lines.join('\n')
    const file = await write('straddle.jsonl', content)
    const target = lines.findIndex((l) => l.includes('요청 29'))
    const lineStart = Buffer.byteLength(lines.slice(0, target).join('\n') + '\n')
    const cutInside = lineStart + Math.floor(Buffer.byteLength(lines[target]) / 2)
    const tailBytes = Buffer.byteLength(content) - cutInside

    const preview = await parseCodexPreview(file, 1, { tailBytes })
    expect(preview).toEqual(await referenceParseCodexPreview(file, 1))
    expect(preview.messages.filter((m) => m.text.startsWith('요청 29'))).toHaveLength(1)

    const resume = await parseCodexForResume(file, { tailBytes })
    expect(resume).toEqual(await referenceParseCodexForResume(file))
    expect(resume.requests.filter((r) => r.startsWith('요청 29'))).toHaveLength(1)
  })

  it('a missing file still rejects where the old readers rejected, and the tail still answers empty', async () => {
    const gone = path.join(tmp, 'nope.jsonl')
    await expect(parseCodexMeta(gone)).rejects.toThrow()
    await expect(parseCodexPreview(gone)).rejects.toThrow()
    await expect(parseCodexForResume(gone)).rejects.toThrow()
    expect(await parseCodexTail(gone)).toEqual(await referenceParseCodexTail(gone))
  })
})

describe('windowed codex parse — a big rollout is read only as far as it must be', () => {
  const MB = 1024 * 1024
  let big: string
  let bigSize: number

  beforeAll(async () => {
    // ~50 MB: the head, then screenshots, then the conversation the resume and the preview are about.
    big = path.join(tmp, 'big.jsonl')
    const handle = await fs.open(big, 'w')
    try {
      await handle.write(rollout(2).join('\n') + '\n')
      for (let i = 0; i < 48; i++) await handle.write(imageMsg(`스크린샷 ${i}`, 1 * MB, i, i) + '\n')
      await handle.write(Array.from({ length: 30 }, (_, i) => turnLines(100 + i)).flat().join('\n') + '\n')
    } finally {
      await handle.close()
    }
    bigSize = (await fs.stat(big)).size
  }, 60_000)

  it('the synthetic file really is big', () => {
    expect(bigSize).toBeGreaterThan(48 * MB)
  })

  it('meta reads only the head window', async () => {
    const counter = countingOpen()
    const got = await parseCodexMeta(big, 40, { open: counter.open })
    expect(counter.bytes()).toBeGreaterThan(0)
    expect(counter.bytes()).toBeLessThanOrEqual(256 * 1024)
    expect(got).toEqual(await referenceParseCodexMeta(big))
  })

  it('the list tail reads its one 256 KB window', async () => {
    const counter = countingOpen()
    const got = await parseCodexTail(big, undefined, { open: counter.open })
    expect(counter.bytes()).toBe(256 * 1024)
    expect(got).toEqual(await referenceParseCodexTail(big))
  })

  it('resume reads a tail window, not the file, and answers as the old reader does', async () => {
    const counter = countingOpen()
    const got = await parseCodexForResume(big, { open: counter.open })
    expect(counter.bytes()).toBeGreaterThan(0)
    expect(counter.bytes()).toBeLessThanOrEqual(4 * MB)
    expect(got).toEqual(await referenceParseCodexForResume(big))
  }, 30_000)

  it('preview reads only a tail window and answers as the old reader does', async () => {
    const counter = countingOpen()
    const got = await parseCodexPreview(big, 10, { open: counter.open })
    expect(counter.bytes()).toBeGreaterThan(0)
    expect(counter.bytes()).toBeLessThanOrEqual(4 * MB)
    expect(got).toEqual(await referenceParseCodexPreview(big, 10))
  }, 30_000)

  it('never JSON.parses a screenshot line with its data URL still in it', async () => {
    const parse = vi.spyOn(JSON, 'parse')
    const opts = { tailBytes: 8 * MB, maxTailBytes: 8 * MB }
    await parseCodexForResume(big, opts)
    await parseCodexPreview(big, 60, opts)
    const longest = Math.max(...parse.mock.calls.map(([s]) => (typeof s === 'string' ? s.length : 0)))
    expect(longest).toBeLessThan(64 * 1024)
  }, 30_000)

  it('the text beside a pasted screenshot survives its data URL being emptied', async () => {
    const got = await parseCodexPreview(big, 60, { tailBytes: 8 * MB, maxTailBytes: 8 * MB })
    expect(got.messages.some((m) => m.text === '스크린샷 47')).toBe(true)
  }, 30_000)

  it('stops at the cap when the conversation is too sparse to fill the window', async () => {
    const sparse = path.join(tmp, 'sparse.jsonl')
    const handle = await fs.open(sparse, 'w')
    try {
      await handle.write(rollout(2).join('\n') + '\n')
      for (let i = 0; i < 40; i++) await handle.write(msg('assistant', `긴 답 ${i} ` + 'z'.repeat(1 * MB), i) + '\n')
      await handle.write(turnLines(99).join('\n') + '\n')
    } finally {
      await handle.close()
    }
    const counter = countingOpen()
    const got = await parseCodexForResume(sparse, { open: counter.open, maxTailBytes: 8 * MB })
    expect(counter.bytes()).toBeGreaterThan(0)
    expect(counter.bytes()).toBeLessThanOrEqual(8 * MB)
    expect(got.requests).toEqual(['요청 99 — 이것을 고쳐 주세요']) // the whole file has three
    expect((await referenceParseCodexForResume(sparse)).requests).toHaveLength(3)

    const previewCounter = countingOpen()
    const preview = await parseCodexPreview(sparse, 10, { open: previewCounter.open, maxTailBytes: 8 * MB })
    expect(previewCounter.bytes()).toBeLessThanOrEqual(8 * MB)
    expect(preview.truncated).toBe(true)
    // Fewer than maxTurns requests in the window: the answers in front of the one request belong to a
    // turn that is shown too, so they stay (parseTranscriptPreview's rule at the cap)
    expect(preview.messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['요청 99 — 이것을 고쳐 주세요'])
    expect(preview.messages[0]).toMatchObject({ role: 'assistant' })
    expect(preview.messages.at(-1)).toMatchObject({ role: 'assistant', text: '응답 99' })
  }, 60_000)
})

// Where the windowed readers are documented to differ from the old ones. Each case states it.
describe('windowed codex parse — the documented differences', () => {
  it('meta: a field past the head cap is not seen', async () => {
    const file = await write(
      'meta-past-cap.jsonl',
      [meta(), msg('developer', 'x'.repeat(5000), 0), msg('user', '첫 요청', 1)].join('\n')
    )
    expect((await referenceParseCodexMeta(file)).title).toBe('첫 요청')
    const capped = await parseCodexMeta(file, 40, { headBytes: 1024, maxHeadBytes: 4096 })
    expect(capped).toMatchObject({ cwd: '/w/demo', title: null })
    expect(await parseCodexMeta(file)).toEqual(await referenceParseCodexMeta(file))
  })

  it('a line over 4M characters is not parsed: a request that long is left out', async () => {
    const huge = 'word '.repeat(900_000)
    const file = await write('huge-line.jsonl', [...rollout(2), msg('user', huge, 9)].join('\n'))
    const reference = await referenceParseCodexForResume(file)
    expect(reference.requests.at(-1)).toBe(huge)
    const got = await parseCodexForResume(file)
    expect(got.requests).toEqual(reference.requests.slice(0, -1))
  })

  it('in a line over 256K characters, a message that is one long base64 token is emptied and so dropped', async () => {
    const run = base64Of(300_000, 3)
    const file = await write('typed-base64.jsonl', [...rollout(2), msg('user', run, 9), msg('user', '다음 요청', 10)].join('\n'))
    const reference = await referenceParseCodexForResume(file)
    expect(reference.requests.slice(-2)).toEqual([run, '다음 요청'])
    const got = await parseCodexForResume(file)
    expect(got.requests.slice(-2)).toEqual(['요청 1 — 이것을 고쳐 주세요', '다음 요청'])
  })
})
