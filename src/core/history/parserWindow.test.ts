import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseTranscriptForResume, parseTranscriptPreview } from './parser'
import { openTranscriptSource, type OpenTranscriptSource } from './transcriptWindow'
import { referenceParseTranscriptForResume, referenceParseTranscriptPreview } from './fixtures/parserReference'

// The windowed parseTranscriptForResume / parseTranscriptPreview must give the same answer as the
// whole-file versions they replaced (kept verbatim in fixtures/parserReference.ts) on every file that
// fits in the window, and read only the window on files that do not.

let tmp: string
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-parser-window-'))
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

/** A base64 run the size of a screenshot Read result. */
function base64Of(bytes: number, seed: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let chunk = ''
  for (let i = 0; i < 4096; i++) chunk += alphabet[(i * 7 + seed) % 64]
  return chunk.repeat(Math.ceil(bytes / chunk.length)).slice(0, bytes)
}

/** A user tool_result carrying an image, the way Claude Code writes a Read of a screenshot: the base64
 *  twice, once in message.content and once in toolUseResult. */
function imageResultLine(id: string, bytes: number, seed: number): string {
  const data = base64Of(bytes / 2, seed)
  return line({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }]
        }
      ]
    },
    toolUseResult: { type: 'image', file: { base64: data, type: 'image/png' } },
    timestamp: `2026-09-01T00:00:${String(seed % 60).padStart(2, '0')}.000Z`
  })
}

/** A pasted image with the prompt beside it — the text is a real request and must survive. */
function pastedImageLine(text: string, bytes: number, seed: number): string {
  return line({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64Of(bytes, seed) } },
        { type: 'text', text }
      ]
    },
    timestamp: '2026-09-01T00:00:00.000Z'
  })
}

function turnLines(i: number): string[] {
  const out = [
    line({ type: 'user', message: { role: 'user', content: `요청 ${i} — 이것을 고쳐 주세요` }, timestamp: `t${i}u` }),
    line({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: `응답 ${i}` },
          { type: 'tool_use', id: `bash-${i}`, name: 'Bash', input: { command: `npm test -- ${i}` } }
        ]
      },
      timestamp: `t${i}a`
    }),
    line({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `bash-${i}`, is_error: i % 3 === 0, content: `out ${i}` }]
      }
    }),
    line({ type: 'file-history-snapshot', snapshot: { trackedFileBackups: { [`D:\\p\\f${i}.ts`]: {}, 'D:\\p\\a.ts': {} } } })
  ]
  if (i % 4 === 0) out.push(line({ type: 'user', message: { role: 'user', content: `<bash-input>ls ${i}</bash-input>` } }))
  if (i % 5 === 0) out.push(line({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: `skill body ${i}` }] } }))
  if (i % 6 === 0) out.push(line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `후속 ${i}` }] } }))
  if (i % 7 === 0) out.push('{"type":"user", broken')
  if (i % 8 === 0) out.push(line({ type: 'progress', data: { x: i } }))
  return out
}

function transcript(turns: number, opts?: { title?: boolean; images?: boolean }): string[] {
  const lines: string[] = [line({ type: 'queue-operation', operation: 'enqueue' })]
  for (let i = 0; i < turns; i++) {
    lines.push(...turnLines(i))
    if (opts?.title !== false && i === 1) lines.push(line({ type: 'ai-title', aiTitle: '  첫 제목  ' }))
    if (opts?.title !== false && i === 3) lines.push(line({ type: 'ai-title', aiTitle: '두 번째 제목' }))
    if (opts?.images && i % 9 === 4) lines.push(imageResultLine(`img-${i}`, 300_000, i))
    if (opts?.images && i % 11 === 5) lines.push(pastedImageLine(`붙인 그림 ${i} 을 봐 주세요`, 400_000, i))
  }
  return lines
}

const shapes = readFileSync(path.join(__dirname, 'fixtures/conversation-shapes.jsonl'), 'utf8')
const turn = readFileSync(path.join(__dirname, 'fixtures/conversation-turn.jsonl'), 'utf8')

const fixtures: Array<[string, () => string]> = [
  ['conversation-shapes.jsonl', () => shapes],
  ['conversation-turn.jsonl', () => turn],
  ['empty', () => ''],
  ['few turns', () => transcript(3).join('\n')],
  ['many turns, trailing newline', () => transcript(40).join('\n') + '\n'],
  ['many turns, CRLF', () => transcript(30).join('\r\n')],
  ['legacy summary title, no snapshot', () =>
    [line({ type: 'summary', summary: 'old title' }), ...transcript(25, { title: false }).filter((l) => !l.includes('file-history-snapshot'))].join('\n')],
  ['no title at all', () => transcript(22, { title: false }).join('\n')],
  ['heavy image lines', () => transcript(45, { images: true }).join('\n')],
  // The latest snapshot sits far before the last 20 requests: the window must keep growing to reach it.
  ['one early snapshot', () =>
    [
      line({ type: 'file-history-snapshot', snapshot: { trackedFileBackups: { 'D:\\early.ts': {} } } }),
      ...transcript(60).filter((l) => !l.includes('file-history-snapshot'))
    ].join('\n')],
  // Exactly three turns after long answers that belong to no turn: with maxTurns 3, a window holding
  // three user messages cannot yet tell that nothing is truncated.
  ['answers before exactly three turns', () =>
    [
      ...Array.from({ length: 3 }, (_, i) => line({ type: 'assistant', message: { content: [{ type: 'text', text: `lead ${i} ` + 'x'.repeat(3000) }] } })),
      ...Array.from({ length: 3 }, (_, i) => [
        line({ type: 'user', message: { content: `q${i}` } }),
        line({ type: 'assistant', message: { content: [{ type: 'text', text: `a${i} ` + 'y'.repeat(3000) }] } })
      ]).flat()
    ].join('\n')],
  ['assistant only', () =>
    Array.from({ length: 5 }, (_, i) => line({ type: 'assistant', message: { content: [{ type: 'text', text: `a${i}` }] } })).join('\n')]
]

describe('windowed parse — identical to the whole-file parse', () => {
  for (const [name, content] of fixtures) {
    it(`${name}: fits in the default window`, async () => {
      const file = await write(`fit-${name.replace(/\W+/g, '_')}.jsonl`, content())
      expect(await parseTranscriptForResume(file)).toEqual(await referenceParseTranscriptForResume(file))
      for (const maxTurns of [10, 3, 1]) {
        expect(await parseTranscriptPreview(file, maxTurns)).toEqual(await referenceParseTranscriptPreview(file, maxTurns))
      }
    })

    it(`${name}: grown from a tiny window, a cut through every kind of line`, async () => {
      const file = await write(`grow-${name.replace(/\W+/g, '_')}.jsonl`, content())
      const want = await referenceParseTranscriptForResume(file)
      for (const tailBytes of [64, 300, 1000, 4096]) {
        const got = await parseTranscriptForResume(file, { tailBytes, headBytes: 128 })
        expect(got).toEqual(want)
      }
      for (const maxTurns of [10, 3, 1]) {
        const wantPreview = await referenceParseTranscriptPreview(file, maxTurns)
        for (const tailBytes of [64, 300, 1000, 4096]) {
          expect(await parseTranscriptPreview(file, maxTurns, { tailBytes })).toEqual(wantPreview)
        }
      }
    })
  }

  it('a request line cut by the first window is read once, whole, never as a fragment', async () => {
    const lines = transcript(30)
    const content = lines.join('\n')
    const file = await write('straddle.jsonl', content)
    // Land the first window's start in the middle of the last real request line.
    const target = lines.map((l, i) => [l, i] as const).filter(([l]) => l.includes('"content":"요청 29'))[0]
    const lineStart = Buffer.byteLength(lines.slice(0, target[1]).join('\n') + '\n')
    const cutInside = lineStart + Math.floor(Buffer.byteLength(target[0]) / 2)
    const tailBytes = Buffer.byteLength(content) - cutInside

    const preview = await parseTranscriptPreview(file, 1, { tailBytes })
    expect(preview).toEqual(await referenceParseTranscriptPreview(file, 1))
    expect(preview.messages.filter((m) => m.text.startsWith('요청 29'))).toHaveLength(1)

    const resume = await parseTranscriptForResume(file, { tailBytes })
    expect(resume).toEqual(await referenceParseTranscriptForResume(file))
    expect(resume.requests.filter((r) => r.startsWith('요청 29'))).toHaveLength(1)
  })
})

describe('windowed parse — a big transcript is read only as far as it must be', () => {
  const MB = 1024 * 1024
  let big: string
  let bigSize: number

  beforeAll(async () => {
    // ~50 MB: a head with the title, then screenshots, then the conversation the resume is about.
    big = path.join(tmp, 'big.jsonl')
    const handle = await fs.open(big, 'w')
    try {
      await handle.write(transcript(2).join('\n') + '\n')
      for (let i = 0; i < 48; i++) await handle.write(imageResultLine(`big-${i}`, 1 * MB, i) + '\n')
      await handle.write(transcript(30).slice(1).join('\n') + '\n')
    } finally {
      await handle.close()
    }
    bigSize = (await fs.stat(big)).size
  }, 60_000)

  it('the synthetic file really is big', () => {
    expect(bigSize).toBeGreaterThan(48 * MB)
  })

  it('resume reads a tail window and a head window, not the file, and answers as the full parse does', async () => {
    const counter = countingOpen()
    const got = await parseTranscriptForResume(big, { open: counter.open })
    expect(counter.bytes()).toBeGreaterThan(0) // the parse went through the injected reader
    expect(counter.bytes()).toBeLessThan(6 * MB)
    expect(got).toEqual(await referenceParseTranscriptForResume(big))
    expect(got.title).toBe('첫 제목')
  }, 30_000)

  it('preview reads only a tail window and answers as the full parse does', async () => {
    const counter = countingOpen()
    const got = await parseTranscriptPreview(big, 10, { open: counter.open })
    expect(counter.bytes()).toBeGreaterThan(0)
    expect(counter.bytes()).toBeLessThanOrEqual(4 * MB)
    expect(got).toEqual(await referenceParseTranscriptPreview(big, 10))
  }, 30_000)

  it('never JSON.parses a screenshot line with its base64 still in it', async () => {
    const parse = vi.spyOn(JSON, 'parse')
    await parseTranscriptForResume(big, { tailBytes: 8 * MB })
    await parseTranscriptPreview(big, 10, { tailBytes: 8 * MB })
    const longest = Math.max(...parse.mock.calls.map(([s]) => (typeof s === 'string' ? s.length : 0)))
    expect(longest).toBeLessThan(64 * 1024)
  }, 30_000)

  it('stops at the cap when the conversation is too sparse to fill the window', async () => {
    // Only one real request after the screenshots: the resume would like 20 and will never find them.
    const sparse = path.join(tmp, 'sparse.jsonl')
    const handle = await fs.open(sparse, 'w')
    try {
      await handle.write(transcript(2).join('\n') + '\n')
      for (let i = 0; i < 40; i++) await handle.write(imageResultLine(`sp-${i}`, 1 * MB, i) + '\n')
      await handle.write(turnLines(99).join('\n') + '\n')
    } finally {
      await handle.close()
    }
    const counter = countingOpen()
    const got = await parseTranscriptForResume(sparse, { open: counter.open, maxTailBytes: 8 * MB, maxHeadBytes: 1 * MB })
    expect(counter.bytes()).toBeGreaterThan(0)
    expect(counter.bytes()).toBeLessThanOrEqual(9 * MB)
    expect(got.requests).toEqual(['요청 99 — 이것을 고쳐 주세요'])
    expect(got.title).toBe('첫 제목') // from the head window
    expect(got.lastCommand).toEqual({ command: 'npm test -- 99', failed: true, excerpt: 'out 99' }) // 99 % 3 === 0

    const previewCounter = countingOpen()
    const preview = await parseTranscriptPreview(sparse, 10, { open: previewCounter.open, maxTailBytes: 8 * MB })
    expect(previewCounter.bytes()).toBeGreaterThan(0)
    expect(previewCounter.bytes()).toBeLessThanOrEqual(8 * MB)
    expect(preview.truncated).toBe(true)
    expect(preview.messages[0]).toMatchObject({ role: 'user', text: '요청 99 — 이것을 고쳐 주세요' })
  }, 60_000)
})
