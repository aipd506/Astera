// `help('name')`: the `## name(...)` section of a guide's text, by the name before the parenthesis.
// Shared by the agent browser's help() (src/main/agentBrowser/helpers.ts) and the agent workspace's
// (src/core/workspace/helpers.ts) — moved here so neither copies the other (preflight ruling F4).
export function section(guide: string, name: string): string | null {
  const lines = guide.split('\n')
  const start = lines.findIndex((l) => l.startsWith('## ') && l.slice(3).split('(')[0].trim() === name)
  if (start < 0) return null
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  if (end < 0) end = lines.length
  return lines.slice(start, end).join('\n').trimEnd()
}
