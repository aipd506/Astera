import { open } from 'node:fs/promises'

/** A transcript as bytes at offsets — what the windowed parsers in parser.ts read through. A seam, so
 *  a test can count how many bytes a parse actually pulls off the disk instead of timing it. */
export interface TranscriptByteSource {
  /** The file's size when it was opened. A live session keeps appending; what came after is the next
   *  read's business. */
  readonly size: number
  /** Up to `length` bytes starting at `position` — shorter only at end of file. */
  read(position: number, length: number): Promise<Buffer>
  close(): Promise<void>
}

export type OpenTranscriptSource = (filePath: string) => Promise<TranscriptByteSource>

export const openTranscriptSource: OpenTranscriptSource = async (filePath) => {
  const handle = await open(filePath, 'r')
  try {
    const size = (await handle.stat()).size
    return {
      size,
      read: async (position, length) => {
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, position)
        return buffer.subarray(0, bytesRead) // a zero-filled remainder is not content
      },
      close: () => handle.close()
    }
  } catch (err) {
    await handle.close().catch(() => undefined)
    throw err
  }
}

/** How far the windowed parsers read. Every field has a default; tests shrink them. */
export interface TranscriptWindowOptions {
  /** First tail window. It doubles until the parser has what it needs, the file's start, or the cap. */
  tailBytes?: number
  maxTailBytes?: number
  /** First head window (title records sit near the start of a file). Doubles up to its own cap. */
  headBytes?: number
  maxHeadBytes?: number
  open?: OpenTranscriptSource
}

/** **Measured 2026-09-27 on this machine's ~/.claude/projects** (the nine transcripts over 20 MB, the
 *  biggest 143 MB). What a resume needs — the last 20 real requests and 20 messages, and the latest
 *  file-history-snapshot — sat within the last 0.7 to 31.4 MB; the last 11 user messages a 10-turn
 *  preview needs, within 0.4 to 15.2 MB. 4 MB covers the common case in one read, and 64 MB is two
 *  doublings past the worst file, while still bounding what a file that never fills the window costs. */
export const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024
export const TRANSCRIPT_TAIL_BYTES_MAX = 64 * 1024 * 1024

/** Same survey: of the 32 transcripts over 4 MB, 18 carry a title record, the first one 31 KB to
 *  222 KB in for all but one, which had it at 1,379,909 bytes. The other 14 carry none at all, and for
 *  them the head read is wasted — so it starts small and the cap is kept small. Only lines that name a
 *  title type are parsed here, so reading the head is mostly a byte search. */
export const TRANSCRIPT_HEAD_BYTES = 256 * 1024
export const TRANSCRIPT_HEAD_BYTES_MAX = 4 * 1024 * 1024

const NEWLINE = 0x0a

/** readline's own line endings, so a window splits a file into exactly the lines a stream would. */
const LINE_ENDING = /\r?\n|\r(?!\n)/

function linesOf(buffer: Buffer): string[] {
  if (buffer.length === 0) return []
  return buffer.toString('utf8').split(LINE_ENDING)
}

/**
 * Hands `take` the file's lines from the end backwards, one window at a time: the first call gets the
 * lines of the last `tailBytes`, each later call the lines just before the previous ones (always in
 * file order within a call). Stops as soon as `take` returns true, at the start of the file, or once
 * the window reaches `maxBytes`.
 *
 * Byte offsets, never string offsets — the same reasoning as readConversationWindow
 * (conversationRead.ts): a 0x0a byte is always a real line break in UTF-8, so a window that starts
 * mid-file drops everything up to its first newline — the torn tail of a line that began earlier —
 * and every later window reads only up to where the previous one's whole lines began, so no byte is
 * decoded twice and no line is handed over twice or in pieces. A line bigger than the window (an
 * image) simply yields nothing until the window grows past its start.
 *
 * Returns `from`, where the lines handed over begin (0 when the whole file was read).
 */
export async function readTailLines(
  src: TranscriptByteSource,
  bytes: { initial: number; max: number },
  take: (lines: string[]) => boolean
): Promise<{ from: number }> {
  let from = src.size
  // Bytes already read in front of `from`: the torn start of the line `from` follows. Kept rather than
  // read again, so a parse reads each byte at most once and never more than `max` in all.
  let carry: Buffer = Buffer.alloc(0)
  let readFrom = src.size
  let window = Math.max(1, bytes.initial)
  for (;;) {
    const start = Math.max(0, src.size - window)
    if (start < readFrom) {
      const chunk = await src.read(start, readFrom - start)
      if (chunk.length < readFrom - start) return { from } // the file shrank under us — keep what we have
      readFrom = start
      const buffer = carry.length ? Buffer.concat([chunk, carry]) : chunk
      let cut = 0
      if (start > 0) {
        const nl = buffer.indexOf(NEWLINE)
        cut = nl === -1 ? buffer.length : nl + 1
      }
      carry = buffer.subarray(0, cut)
      if (cut < buffer.length) {
        from = start + cut
        if (take(linesOf(buffer.subarray(cut)))) return { from }
      }
    }
    if (from === 0 || window >= bytes.max) return { from }
    window = Math.min(window * 2, bytes.max)
  }
}

/**
 * Hands `take` the whole lines of the file's head, window by window, never past `end` (where a tail
 * read's lines begin — a line boundary). Stops when `take` returns true, at `end`, or at `maxBytes`.
 */
export async function readHeadLines(
  src: TranscriptByteSource,
  end: number,
  bytes: { initial: number; max: number },
  take: (lines: string[]) => boolean
): Promise<void> {
  let pos = 0
  let carry: Buffer = Buffer.alloc(0)
  let limit = Math.max(1, bytes.initial)
  for (;;) {
    const stop = Math.min(limit, end)
    if (stop > pos) {
      const chunk = await src.read(pos, stop - pos)
      if (chunk.length < stop - pos) return
      pos = stop
      const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk
      // At `end` the last line is whole (end is a line boundary); before it, the last line may not be.
      const cut = stop === end ? buffer.length : buffer.lastIndexOf(NEWLINE) + 1
      carry = buffer.subarray(cut)
      if (take(linesOf(buffer.subarray(0, cut)))) return
    }
    if (stop >= end || limit >= bytes.max) return
    limit = Math.min(limit * 2, bytes.max)
  }
}

/** Lines longer than this are checked for inline base64 before they are parsed. Text lines — even a
 *  long assistant answer — are far below it; an image Read result is 100 KB to 1.3 MB. */
export const HEAVY_LINE_CHARS = 256 * 1024

/** Past this, even after the base64 is gone, a line is not parsed at all — the one hard cap on what
 *  JSON.parse is ever handed. */
export const PARSE_LINE_CHARS_MAX = 4 * 1024 * 1024

/** A JSON string whose whole value is a long base64 run: an image's `source.data`, or the copy of it
 *  Claude Code keeps in `toolUseResult.file.base64`. Neither is ever text a parser here reads — the
 *  text of a turn is in `text` blocks and tool output. The lookbehind keeps an escaped quote inside a
 *  longer string from being taken for the start of one. */
const INLINE_BASE64 = /(?<!\\)"[A-Za-z0-9+/=]{4096,}"/g

/** JSON.parse for one transcript line, without paying for its images. A line over HEAVY_LINE_CHARS has
 *  its base64 string values emptied first — a regex pass over the raw text is far cheaper than
 *  building a megabyte string on the heap, and the text blocks beside the image (a pasted screenshot's
 *  prompt) are left as they were. Returns null for anything that is not a JSON object, as the callers
 *  skip those anyway. */
export function parseTranscriptLine(raw: string): Record<string, unknown> | null {
  let text = raw
  if (text.length > HEAVY_LINE_CHARS) {
    text = text.replace(INLINE_BASE64, '""')
    if (text.length > PARSE_LINE_CHARS_MAX) return null
  }
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    return null // defensive parsing — a broken line is skipped
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null
  return obj as Record<string, unknown>
}
