import { describe, test, expect } from 'bun:test'
import { Tui } from './tui.ts'

describe('Tui (non-TTY mode)', () => {
  test('appendEvent writes a plain line when stdout is not a TTY', () => {
    const writes: string[] = []
    const tui = new Tui({
      isTty: false,
      write: (s: string) => { writes.push(s) },
    })
    tui.updateStatus({ port: 3000, workers: 4, watching: ['/proj'] })
    tui.appendEvent('▶ serving on http://127.0.0.1:3000')
    expect(writes.some((w) => w.includes('serving on http://127.0.0.1:3000'))).toBe(true)
    expect(writes.join('')).not.toContain('\x1b[')
  })

  test('event log evicts oldest when exceeding capacity (3)', () => {
    const writes: string[] = []
    const tui = new Tui({
      isTty: false,
      write: (s: string) => { writes.push(s) },
      capacity: 3,
    })
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
    const tui = new Tui({
      isTty: true,
      write: (s: string) => { writes.push(s) },
    })
    tui.updateStatus({ port: 3000, workers: 4, watching: ['/proj'] })
    tui.appendEvent('boot')
    expect(writes.join('')).toContain('\x1b[')
  })
})
