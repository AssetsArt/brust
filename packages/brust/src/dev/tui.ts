// The inline terminal UI of `brust dev` (R13.5). NEVER the alternate screen: request log lines scroll
// normally, and a status block of at most 6 lines is redrawn at the bottom (cursor-up + clear, wrapped
// lines counted, resize aware). Not a TTY, `CI` or `NO_COLOR` -> plain line logs, no redraw, no raw mode.

export type DevState = 'building' | 'ready' | 'error'

export interface TuiStatus {
  state: DevState
  url: string
  gen: number
  buildMs?: number
  /** The last page request (route + status) until L14's per-page trace lands. */
  last?: { method: string; path: string; status: number; /** Components of the last page by tier (from its trace + `dev.json`). */ tiers?: { static: number; native: number; react: number } }
  warnings: string[]
  /** One line shown under the state while `error` (the first line of the diagnostic). */
  error?: string
}

export interface TuiOut {
  write(s: string): unknown
  columns?: number
  isTTY?: boolean
}

const STATE_DOT: Record<DevState, string> = { building: '◌', ready: '●', error: '✖' }
const STATE_COLOR: Record<DevState, string> = { building: '33', ready: '32', error: '31' }
export const HOTKEYS = '[r]eload  [o]pen  [w]arnings  [c]lear  [q]uit'
export const MAX_STATUS_LINES = 6

/** Visible length (ANSI escapes do not count). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
export const visibleLen = (s: string): number => [...s.replace(ANSI, '')].length

/** `s` cut to `width` visible columns, with a trailing `…` when it was cut (escapes are not split: input is plain here). */
function fit(s: string, width: number): string {
  const cs = [...s]
  return cs.length <= width ? s : `${cs.slice(0, Math.max(0, width - 1)).join('')}…`
}

/** The status block, plain text (colour is added by the caller), every line at most `width` columns. */
export function renderStatus(s: TuiStatus, width: number): string[] {
  const w = Math.max(20, width - 1)
  const head = `${STATE_DOT[s.state]} ${s.state}  ${s.url}  gen ${s.gen}${s.buildMs !== undefined ? ` · built in ${s.buildMs}ms` : ''}`
  const lines = [head]
  if (s.state === 'error' && s.error) lines.push(`  error: ${s.error}`)
  else if (s.last) lines.push(`  last: ${s.last.method} ${s.last.path} → ${s.last.status}${s.last.tiers ? `  ·  ${s.last.tiers.static} static ${s.last.tiers.native} native ${s.last.tiers.react} react` : ''}`)
  else lines.push('  last: (no request yet)')
  if (s.warnings.length > 0) lines.push(`  warnings: ${s.warnings.length} — ${s.warnings[0]}`)
  lines.push(`  ${HOTKEYS}`)
  return lines.slice(0, MAX_STATUS_LINES).map((l) => fit(l, w))
}

/** Rows `lines` occupy on a terminal `width` columns wide (a line wider than the terminal wraps). */
export function rowsFor(lines: string[], width: number): number {
  const w = Math.max(1, width)
  return lines.reduce((n, l) => n + Math.max(1, Math.ceil(visibleLen(l) / w)), 0)
}

/** Colour is on for a TTY unless NO_COLOR; the redraw is on only for an interactive TTY outside CI. */
export function tuiMode(out: TuiOut, env: Record<string, string | undefined>): { interactive: boolean; color: boolean } {
  const tty = out.isTTY === true
  const interactive = tty && !env.CI && !env.NO_COLOR
  return { interactive, color: interactive }
}

export class Tui {
  private status: TuiStatus | null = null
  private drawn: string[] = []
  private closed = false
  private lastPlain = ''

  constructor(
    private readonly out: TuiOut,
    private readonly interactive: boolean,
    private readonly color = interactive,
  ) {}

  private width(): number {
    return this.out.columns && this.out.columns > 0 ? this.out.columns : 80
  }

  private paint(l: string, i: number): string {
    if (!this.color || !this.status) return l
    if (i === 0) return `\x1b[${STATE_COLOR[this.status.state]}m${l}\x1b[0m`
    return `\x1b[2m${l}\x1b[0m`
  }

  private erase(): string {
    if (this.drawn.length === 0) return ''
    const rows = rowsFor(this.drawn, this.width())
    this.drawn = []
    return `\r\x1b[${rows}A\x1b[J`
  }

  private draw(): string {
    if (!this.status) return ''
    const lines = renderStatus(this.status, this.width())
    this.drawn = lines
    return `${lines.map((l, i) => this.paint(l, i)).join('\n')}\n`
  }

  /** One scrolling log line (a request, a warning, a message). */
  log(raw: string): void {
    if (this.closed) return
    // Colour only where colour is on: a child's ANSI-coloured tracing line is plain text in plain mode.
    const line = this.color ? raw : raw.replace(ANSI, '')
    if (!this.interactive) {
      this.out.write(`${line}\n`)
      return
    }
    this.out.write(`${this.erase()}${line}\n${this.draw()}`)
  }

  /** Replace the status block. Plain mode prints a line only when the state line changes. */
  setStatus(s: TuiStatus): void {
    if (this.closed) return
    this.status = s
    if (!this.interactive) {
      const l = `[brust] ${s.state} ${s.url} gen ${s.gen}${s.buildMs !== undefined ? ` (${s.buildMs}ms)` : ''}${s.error ? ` — ${s.error}` : ''}`
      if (l !== this.lastPlain) this.out.write(`${l}\n`)
      this.lastPlain = l
      return
    }
    this.out.write(`${this.erase()}${this.draw()}`)
  }

  /** Redraw after a terminal resize (the rows the old block took are recounted at the new width). */
  resize(): void {
    if (this.interactive && !this.closed) this.out.write(`${this.erase()}${this.draw()}`)
  }

  /** The `c` hotkey: clear the screen and redraw the block. */
  clear(): void {
    if (!this.interactive) return
    this.drawn = []
    this.out.write(`\x1b[2J\x1b[H${this.draw()}`)
  }

  /** Leave the final block on screen and stop drawing. */
  close(): void {
    this.closed = true
  }
}
