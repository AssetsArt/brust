const ESC = '\x1b['
const HIDE_CURSOR = ESC + '?25l'
const SHOW_CURSOR = ESC + '?25h'
const CLEAR_SCREEN = ESC + '2J' + ESC + 'H'
const RESET = ESC + '0m'
const DIM = ESC + '2m'
const BRAND = ESC + '38;2;138;51;36m'
const GREEN = ESC + '32m'
const RED = ESC + '31m'
const YELLOW = ESC + '33m'

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

export class Tui {
  private events: string[] = []
  private status: Status | null = null
  private capacity: number
  private state: 'idle' | 'building' | 'failed' = 'idle'

  constructor(private opts: TuiOptions) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY
  }

  eventsForTests(): string[] {
    return [...this.events]
  }

  updateStatus(s: Status): void {
    this.status = s
    this.render()
  }

  setState(s: 'idle' | 'building' | 'failed'): void {
    this.state = s
    this.render()
  }

  appendEvent(line: string): void {
    this.events.push(line)
    if (this.events.length > this.capacity) this.events.shift()
    this.render()
  }

  stop(): void {
    if (this.opts.isTty) this.opts.write(SHOW_CURSOR + RESET)
  }

  private render(): void {
    if (!this.opts.isTty) {
      const latest = this.events[this.events.length - 1]
      if (latest) this.opts.write(latest + '\n')
      return
    }
    let out = HIDE_CURSOR + CLEAR_SCREEN
    out += this.renderHeader()
    out += this.renderEvents()
    out += this.renderStatusBar()
    this.opts.write(out)
  }

  private renderHeader(): string {
    if (!this.status) return BRAND + 'brust 0.1.0 · dev mode' + RESET + '\n\n'
    return (
      BRAND +
      'brust 0.1.0 · dev mode' +
      RESET +
      '\n' +
      DIM +
      'port:     ' +
      RESET +
      this.status.port +
      '\n' +
      DIM +
      'workers:  ' +
      RESET +
      this.status.workers +
      '\n' +
      DIM +
      'watching: ' +
      RESET +
      this.status.watching.join(', ') +
      '\n\n'
    )
  }

  private renderEvents(): string {
    let out = ''
    for (const ev of this.events) out += ev + '\n'
    return out + '\n'
  }

  private renderStatusBar(): string {
    if (this.state === 'building') return YELLOW + '◉ Building…' + RESET + '\n'
    if (this.state === 'failed') return RED + '✗ Build failed' + RESET + '\n'
    return GREEN + '◉ Serving' + RESET + '\n'
  }
}
