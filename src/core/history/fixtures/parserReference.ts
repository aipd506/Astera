// **Test oracle only — never import this from production code.**
//
// These are parseTranscriptForResume and parseTranscriptPreview exactly as they were before they
// learned to read byte windows (parser.ts at 7011aba0): each streams the whole file and JSON.parses
// every line. They stay here, unchanged apart from their names, so that parserWindow.test.ts can
// prove the windowed versions give the same answer on any file that fits in the window.
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { TranscriptMessage } from '../../types'
import {
  PREVIEW_TURNS,
  READ_BUFFER_MAX,
  extractText,
  isMetaUserRecord,
  isRealUserText,
  lastTurns,
  toTitle,
  type TranscriptResumeMaterial
} from '../parser'

function toPortablePath(p: string): string {
  return p.replace(/\\/g, '/')
}

function extractToolResultText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const block = content.find(
      (c): c is { type: string; text: string } =>
        typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text' &&
        typeof (c as { text?: unknown }).text === 'string'
    )
    return block ? block.text : null
  }
  return null
}

export async function referenceParseTranscriptForResume(filePath: string): Promise<TranscriptResumeMaterial> {
  const result: TranscriptResumeMaterial = {
    title: null,
    requests: [],
    editedFiles: [],
    tail: [],
    lastCommand: null
  }
  // 아직 tool_result 를 못 받은, 가장 최근에 본 Bash tool_use — id 와 command 를 함께 들고 있다가
  // 짝이 되는 tool_result(같은 id) 를 만나면 result.lastCommand 로 확정한다. **결과가 도착한
  // 순서대로 확정하므로 "마지막" 은 결과가 가장 나중에 온 호출이다.**
  //
  // **한 슬롯이 아니라 맵인 이유(리뷰가 잡았다).** 한 턴이 Bash tool_use 를 여러 개 내보낼 수 있고
  // (독립적인 호출은 한 번에 묶어 보내는 것이 권장된다), 슬롯 하나면 나중 id 가 앞 id 를 덮어써서
  // **먼저 시작된 호출의 결과가 도착해도 짝을 못 찾고 조용히 버려졌다.** 맵이면 어느 순서로
  // 도착해도 짝이 맞는다. 미완으로 남는 항목은 파일을 다 읽고 그냥 버려진다 — 결과가 없는 호출은
  // 성공/실패를 말할 수 없으므로 이 절에 실을 것이 없다.
  const pendingBash = new Map<string, string>()
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream })
  try {
    for await (const raw of rl) {
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(raw)
      } catch {
        continue // defensive parsing — ignore a broken line
      }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) continue

      // 제목 레코드는 **이름이 버전마다 다르다** — 현행 Claude Code 는 `ai-title`(필드 `aiTitle`),
      // 구버전은 `summary`(필드 `summary`)로 남긴다. 이 앱은 구버전 CLI 를 쓰는 사용자에게도 나가므로
      // 둘 다 받는다. 한쪽만 받으면 그 사용자는 제목 줄을 영구히 못 받고, 그 사실이 조용히 지나간다.
      if (result.title === null && obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
        result.title = toTitle(obj.aiTitle)
        continue
      }
      if (result.title === null && obj.type === 'summary' && typeof obj.summary === 'string') {
        result.title = toTitle(obj.summary)
        continue
      }

      if (obj.type === 'file-history-snapshot') {
        const snapshot = obj.snapshot as { trackedFileBackups?: unknown } | undefined
        const tracked = snapshot?.trackedFileBackups
        if (tracked && typeof tracked === 'object' && !Array.isArray(tracked)) {
          result.editedFiles = Object.keys(tracked).map(toPortablePath)
        }
        continue
      }

      // Bash 호출과 그 결과 — extractText 가 text 블록만 찾는 것과 달리 여기서는 같은
      // message.content 배열에서 tool_use/tool_result 블록을 본다. 이 검사는 아래 text 추출과
      // 배타적이지 않다(같은 줄이 text 와 tool_use 를 함께 실을 수 있다) — 그래서 continue 하지
      // 않고 통과시킨다.
      const blocks = (obj.message as { content?: unknown } | undefined)?.content
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b === null || typeof b !== 'object') continue
          const item = b as Record<string, unknown>
          if (obj.type === 'assistant' && item.type === 'tool_use' && item.name === 'Bash') {
            const input = item.input as { command?: unknown } | undefined
            if (typeof item.id === 'string' && typeof input?.command === 'string') {
              pendingBash.set(item.id, input.command)
            }
          } else if (
            obj.type === 'user' &&
            item.type === 'tool_result' &&
            typeof item.tool_use_id === 'string' &&
            pendingBash.has(item.tool_use_id)
          ) {
            result.lastCommand = {
              command: pendingBash.get(item.tool_use_id) as string,
              failed: item.is_error === true,
              excerpt: extractToolResultText(item.content) ?? ''
            }
            pendingBash.delete(item.tool_use_id) // 같은 id 의 결과가 두 번 오면 첫 번째만 센다
          }
        }
      }

      if (obj.type !== 'user' && obj.type !== 'assistant') continue
      const text = extractText(obj.message)
      if (text === null) continue

      if (obj.type === 'user') {
        // 기계가 남긴 user 줄 — 요청도 꼬리도 아니다. 표지를 단 부류(접두어)와 표지 없이 오는
        // 부류(isMeta, 스킬 본문 등) 둘 다 여기서 떨어진다.
        if (!isRealUserText(text) || isMetaUserRecord(obj)) continue
        result.requests.push(text)
        if (result.requests.length > READ_BUFFER_MAX) result.requests.shift()
      }

      result.tail.push({
        role: obj.type,
        text,
        timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined
      })
      if (result.tail.length > READ_BUFFER_MAX) result.tail.shift()
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  return result
}

export async function referenceParseTranscriptPreview(
  filePath: string,
  maxTurns = PREVIEW_TURNS
): Promise<{ messages: TranscriptMessage[]; truncated: boolean }> {
  const messages: TranscriptMessage[] = []
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream })
  try {
    for await (const raw of rl) {
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(raw)
      } catch {
        continue
      }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) continue
      if (obj.type !== 'user' && obj.type !== 'assistant') continue
      const text = extractText(obj.message)
      if (!text) continue
      messages.push({
        role: obj.type as 'user' | 'assistant',
        text,
        timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined
      })
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  // **파일을 끝까지 읽는다.** 마지막 턴들을 남기려면 끝을 봐야 하고, parseTranscriptTail 처럼
  // 바이트 꼬리만 읽으면 10 턴이 그 안에 들어오는지 알 수 없어 조용히 더 적게 보여 준다.
  // 값은 실측했다: 28MB·15,873 줄(user/assistant 5,270 개)을 162ms 에 읽는다. 이 함수는 사용자가
  // 미리보기를 열 때만 불린다 — 목록 갱신마다 불리는 parseTranscriptTail 과 다른 자리다.
  //
  // 대가는 잠깐 파일만큼의 문자열을 드는 것이다. 병목이 되면 여기서 롤링 버퍼로 바꾼다(턴 시작
  // 인덱스를 들고 앞에서 잘라 내면 메모리가 maxTurns 로 묶인다).
  return lastTurns(messages, maxTurns)
}
