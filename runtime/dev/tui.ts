const ESC = '\x1b['
const RESET = ESC + '0m'
const DIM = ESC + '2m'
const BRAND = ESC + '38;2;138;51;36m'
const GREEN = ESC + '32m'
const RED = ESC + '31m'
const BAR = BRAND + '┃' + RESET

const VERSION = '0.1.0'
const DEFAULT_CAPACITY = 10

interface Status {
  port: number
  workers: number
  watching: string[]
}

export interface TuiOptions {
  isTty: boolean
  write: (s: string) => void
  capacity?: number
}

/** Astro-style dev output: a clean one-time banner on ready, then event lines
 * that scroll naturally below it. Deliberately NOT a full-screen TUI — it never
 * hides the cursor or clears the screen, so the terminal is left exactly as it
 * was found when the dev server exits (no more vanished cursor on Ctrl-C). */
export class Tui {
  private events: string[] = []
  private capacity: number
  private bannerShown = false

  constructor(private opts: TuiOptions) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY
  }

  eventsForTests(): string[] {
    return [...this.events]
  }

  /** Print the ready banner. Idempotent — only the first call emits it. */
  updateStatus(s: Status): void {
    if (this.bannerShown) return
    this.bannerShown = true

    if (!this.opts.isTty) {
      this.opts.write(
        `brust ${VERSION} · dev — http://127.0.0.1:${s.port}/ (workers: ${s.workers})\n`,
      )
      return
    }

    const lines = [
      '',
      ` ${BRAND}brust${RESET}  ${DIM}v${VERSION}${RESET}`,
      '',
      ` ${BAR} ${DIM}Local${RESET}      http://127.0.0.1:${s.port}/`,
      ` ${BAR} ${DIM}Workers${RESET}    ${s.workers}`,
      ` ${BAR} ${DIM}Watching${RESET}   ${s.watching.join(', ')}`,
      '',
      '',
    ]
    this.opts.write(lines.join('\n'))
  }

  /** Append one event. Scrolls below the banner (TTY) or prints a plain line
   * (non-TTY / CI). The in-memory ring buffer backs `eventsForTests`. */
  appendEvent(line: string): void {
    this.events.push(line)
    if (this.events.length > this.capacity) this.events.shift()

    if (!this.opts.isTty) {
      this.opts.write(line + '\n')
      return
    }
    this.opts.write(this.format(line) + '\n')
  }

  /** Called on shutdown. There is nothing to restore (we never altered the
   * terminal mode); the reset is belt-and-braces so a half-written colored
   * line can't bleed into the user's prompt. */
  stop(): void {
    if (this.opts.isTty) this.opts.write(RESET)
  }

  /** Colorize an event line in TTY mode: a dim timestamp prefix, with ok/error
   * markers tinted. The coordinator emits `  → ok (Nms)` and `  ✗ <msg>`. */
  private format(line: string): string {
    const ts = `${DIM}${timestamp()}${RESET} `
    const trimmed = line.trimStart()
    if (trimmed.startsWith('✗')) return ts + RED + line.trim() + RESET
    if (trimmed.startsWith('→ ok') || trimmed.startsWith('ok')) {
      return ts + GREEN + line.trim() + RESET
    }
    return ts + line
  }
}

function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
