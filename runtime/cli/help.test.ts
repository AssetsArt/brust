import { test, expect } from 'bun:test'
import { readVersion, renderVersion, renderRootHelp, renderCommandHelp } from './help.ts'
import pkg from '../../package.json'

test('readVersion matches package.json', () => {
  expect(readVersion()).toBe(pkg.version)
})

test('renderVersion contains the version', () => {
  expect(renderVersion()).toContain(pkg.version)
  expect(renderVersion()).toContain('brustjs')
})

test('renderRootHelp lists usage + all commands', () => {
  const h = renderRootHelp()
  expect(h).toContain('Usage')
  for (const name of ['build', 'dev', 'new']) expect(h).toContain(name)
  expect(h).toContain('--help')
  expect(h).toContain('--version')
})

test('renderCommandHelp(build) documents --target and --out-dir', () => {
  const h = renderCommandHelp('build')!
  expect(h).toContain('--target')
  expect(h).toContain('--out-dir')
})

test('renderCommandHelp(build) documents --ssg and --ssg-out', () => {
  const h = renderCommandHelp('build')!
  expect(h).toContain('--ssg')
  expect(h).toContain('--ssg-out')
})

test('renderCommandHelp(build) mentions markdown pages (mdRoutes)', () => {
  const h = renderCommandHelp('build')!
  expect(h).toContain('mdRoutes')
  expect(h).toContain('md-manifest.json')
})

test('renderCommandHelp(unknown) is null', () => {
  expect(renderCommandHelp('bogus')).toBeNull()
})

test('no ANSI escapes when not a TTY (test default)', () => {
  expect(renderRootHelp()).not.toContain('\x1b[')
  expect(renderCommandHelp('build')!).not.toContain('\x1b[')
})

test('root help aligns command + global descriptions in one column', () => {
  // Every "  <label>  <desc>" row must start its description at the same column.
  // Regression guard: the Global flags (e.g. "-v, --version") are wider than the
  // command names, so the shared pad width must accommodate them.
  const rows = renderRootHelp()
    .split('\n')
    .filter((l) => /^ {2}(build|dev|new|-h|-v)\b/.test(l))
  expect(rows.length).toBe(5) // 3 commands + 2 global flags
  // Strip "  <label><padding>  " and measure where the description begins.
  const descCols = rows.map((l) => l.length - l.replace(/^ {2}(?:\S.*?\S|\S) {2,}/, '').length)
  for (const col of descCols) expect(col).toBe(descCols[0])
})
