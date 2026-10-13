// Parsing `brust build` output for the dev server: `error <rule> <file:line:col> <message>` (cli.ts) and
// `warning <rule> <file:line:col> <message>` (compile.ts).
export interface Diag {
  rule: string
  file?: string
  line?: number
  col?: number
  message: string
  /** The whole error text (stack, extra lines). */
  raw: string
}

/** The first `error …` line of `out` and everything after it; null when there is none. */
export function parseBuildError(out: string): Diag | null {
  const i = out.search(/^error /m)
  if (i < 0) return null
  const raw = out.slice(i).trim()
  const m = /^error (\S+) (?:(\S+?):(\d+):(\d+)[: ]\s*)?([^\n]*)/.exec(raw)
  if (!m) return { rule: 'build', message: raw.split('\n')[0] ?? raw, raw }
  const [, rule, file, line, col, message] = m
  return { rule: rule ?? 'build', ...(file ? { file, line: Number(line), col: Number(col) } : {}), message: message ?? '', raw }
}

/** Every `warning …` line of `out`, without the `warning ` prefix. */
export function parseWarnings(out: string): string[] {
  return out
    .split('\n')
    .filter((l) => l.startsWith('warning '))
    .map((l) => l.slice('warning '.length).trim())
}
