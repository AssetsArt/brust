import { describe, test, expect } from 'bun:test'
import { Tui } from './tui.ts'

describe('Tui (non-TTY mode)', () => {
  test('updateStatus prints a plain banner with the URL; appendEvent a plain line', () => {
    const writes: string[] = []
    const tui = new Tui({ isTty: false, write: (s) => writes.push(s) })
    tui.updateStatus({ port: 3000, workers: 4, watching: ['/proj'] })
    tui.appendEvent('▶ rebuilt islands')
    const all = writes.join('')
    expect(all).toContain('http://127.0.0.1:3000/')
    expect(all).toContain('rebuilt islands')
    expect(all).not.toContain('\x1b[') // no ANSI in CI/non-TTY output
  })

  test('event log evicts oldest when exceeding capacity (3)', () => {
    const tui = new Tui({ isTty: false, write: () => {}, capacity: 3 })
    tui.appendEvent('a')
    tui.appendEvent('b')
    tui.appendEvent('c')
    tui.appendEvent('d')
    expect(tui.eventsForTests()).toEqual(['b', 'c', 'd'])
  })
})

describe('Tui (TTY mode)', () => {
  test('renders ANSI sequences on appendEvent', () => {
    const writes: string[] = []
    const tui = new Tui({ isTty: true, write: (s) => writes.push(s) })
    tui.updateStatus({ port: 3000, workers: 4, watching: ['/proj'] })
    tui.appendEvent('boot')
    expect(writes.join('')).toContain('\x1b[')
  })

  // Regression guard for the "terminal cursor vanishes after dev exits" bug:
  // the TUI must never hide the cursor (?25l) or take over the screen (2J),
  // so there is nothing to leave un-restored on exit.
  test('never emits cursor-hide or clear-screen across its whole lifecycle', () => {
    const writes: string[] = []
    const tui = new Tui({ isTty: true, write: (s) => writes.push(s) })
    tui.updateStatus({ port: 3000, workers: 8, watching: ['pages', 'components'] })
    tui.appendEvent('  → ok (48ms)')
    tui.appendEvent('  ✗ build failed: boom')
    tui.stop()
    const all = writes.join('')
    expect(all).not.toContain('\x1b[?25l') // hide cursor
    expect(all).not.toContain('\x1b[?25h') // show cursor — not needed, never hidden
    expect(all).not.toContain('\x1b[2J') // clear screen
  })

  test('updateStatus is idempotent — the banner prints only once', () => {
    const writes: string[] = []
    const tui = new Tui({ isTty: true, write: (s) => writes.push(s) })
    tui.updateStatus({ port: 3000, workers: 4, watching: ['/proj'] })
    tui.updateStatus({ port: 3000, workers: 4, watching: ['/proj'] })
    const bannerCount = writes.filter((w) => w.includes('Workers')).length
    expect(bannerCount).toBe(1)
  })
})
