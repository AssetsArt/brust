import { test, expect } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripLeadingTrivia, hasUseServerDirective, collectExports, scanActions } from './scan-actions.ts'

test('stripLeadingTrivia: empty', () => {
  expect(stripLeadingTrivia('')).toBe('')
})

test('stripLeadingTrivia: pure whitespace', () => {
  expect(stripLeadingTrivia('   \n\t\r\n')).toBe('')
})

test('stripLeadingTrivia: line comment', () => {
  expect(stripLeadingTrivia('// hi\nexport')).toBe('export')
})

test('stripLeadingTrivia: block comment', () => {
  expect(stripLeadingTrivia('/* a\n b */export')).toBe('export')
})

test('stripLeadingTrivia: chained comments + whitespace', () => {
  const src = '  // a\n /* b */\n\n  // c\nexport'
  expect(stripLeadingTrivia(src)).toBe('export')
})

test('stripLeadingTrivia: unterminated block comment', () => {
  // Defensive: if a comment never closes, return empty so caller skips file.
  expect(stripLeadingTrivia('/* never closed')).toBe('')
})

async function writeFixture(dir: string, name: string, content: string): Promise<string> {
  const p = join(dir, name)
  await writeFile(p, content)
  return p
}

test('hasUseServerDirective: directive at top (single quotes)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const p = await writeFixture(dir, 'a.ts', `'use server'\nexport async function x() {}\n`)
    expect(await hasUseServerDirective(p)).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hasUseServerDirective: directive at top (double quotes)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const p = await writeFixture(dir, 'a.ts', `"use server"\nexport async function x() {}\n`)
    expect(await hasUseServerDirective(p)).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hasUseServerDirective: directive after comments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const src = `// header\n/* block */\n'use server'\nexport async function x() {}\n`
    const p = await writeFixture(dir, 'a.ts', src)
    expect(await hasUseServerDirective(p)).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hasUseServerDirective: directive after import is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const src = `import x from 'y'\n'use server'\nexport async function x() {}\n`
    const p = await writeFixture(dir, 'a.ts', src)
    expect(await hasUseServerDirective(p)).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hasUseServerDirective: missing directive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const p = await writeFixture(dir, 'a.ts', `export async function x() {}\n`)
    expect(await hasUseServerDirective(p)).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hasUseServerDirective: string as value not statement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const p = await writeFixture(dir, 'a.ts', `export const x = 'use server'\n`)
    expect(await hasUseServerDirective(p)).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectExports: happy path, two named function exports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const src = `'use server'\n` +
      `export async function foo(_req) { return 'foo' }\n` +
      `export async function bar(_req) { return 'bar' }\n`
    const p = await writeFixture(dir, 'a.ts', src)
    const defs = await collectExports(p)
    expect(defs.map((d) => d.id).sort()).toEqual(['bar', 'foo'])
    expect(defs.every((d) => typeof d.fn === 'function')).toBe(true)
    expect(defs.every((d) => d.middleware === undefined)).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectExports: skips non-function exports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const src = `'use server'\n` +
      `export const NAME = 'app'\n` +
      `export async function foo(_req) { return 'foo' }\n`
    const p = await writeFixture(dir, 'b.ts', src)
    const defs = await collectExports(p)
    expect(defs.map((d) => d.id)).toEqual(['foo'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectExports: rejects default export', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const src = `'use server'\n` +
      `export default async function () { return 'x' }\n`
    const p = await writeFixture(dir, 'c.ts', src)
    expect(collectExports(p)).rejects.toThrow(/default exports are not action-eligible/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectExports: rejects class exports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const src = `'use server'\n` +
      `export class Foo { static bar() {} }\n`
    const p = await writeFixture(dir, 'd.ts', src)
    expect(collectExports(p)).rejects.toThrow(/is a class/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectExports: rejects invalid id charset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    // The function is named "x.y" via Object.defineProperty after const decl,
    // since TS doesn't allow exotic identifiers directly. We bypass with a
    // computed export name via re-export rename.
    const src = `'use server'\n` +
      `async function _impl(_req) { return 'x' }\n` +
      `export { _impl as 'bad.id' }\n`
    const p = await writeFixture(dir, 'e.ts', src)
    expect(collectExports(p)).rejects.toThrow(/invalid id/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectExports: zero functions → throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const src = `'use server'\nexport const NAME = 'app'\n`
    const p = await writeFixture(dir, 'f.ts', src)
    expect(collectExports(p)).rejects.toThrow(/exports no functions/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectExports: picks up middleware from withMiddleware', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    // Inline withMiddleware-equivalent: write the metadata directly so the
    // fixture doesn't depend on the actions module path resolution.
    const src = `'use server'\n` +
      `async function _impl(_req) { return 'ok' }\n` +
      `Object.defineProperty(_impl, '__brustMiddleware', { value: Object.freeze([() => {}]) })\n` +
      `export { _impl as foo }\n`
    const p = await writeFixture(dir, 'g.ts', src)
    const defs = await collectExports(p)
    expect(defs).toHaveLength(1)
    expect(defs[0].middleware).toHaveLength(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanActions: finds one server file with two exports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    await writeFixture(dir, 'actions.ts',
      `'use server'\n` +
      `export async function a(_req) {}\n` +
      `export async function b(_req) {}\n`,
    )
    await writeFixture(dir, 'plain.ts',
      `export async function notAnAction() {}\n`,
    )
    const defs = await scanActions({ roots: [dir] })
    expect(defs.map((d) => d.id)).toEqual(['a', 'b'])  // alphabetical sort
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanActions: ignores node_modules by default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    await writeFixture(dir, 'actions.ts',
      `'use server'\nexport async function a(_req) {}\n`,
    )
    // Place a second 'use server' file under node_modules.
    const nm = join(dir, 'node_modules', 'pkg')
    await Bun.write(join(nm, 'evil.ts'),
      `'use server'\nexport async function evil(_req) {}\n`,
    )
    const defs = await scanActions({ roots: [dir] })
    expect(defs.map((d) => d.id)).toEqual(['a'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanActions: ignores test patterns by default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    await writeFixture(dir, 'actions.ts',
      `'use server'\nexport async function a(_req) {}\n`,
    )
    await writeFixture(dir, 'actions.test.ts',
      `'use server'\nexport async function shouldNotAppear(_req) {}\n`,
    )
    const subTests = join(dir, 'tests')
    await Bun.write(join(subTests, 'fixture.ts'),
      `'use server'\nexport async function alsoSkipped(_req) {}\n`,
    )
    const defs = await scanActions({ roots: [dir] })
    expect(defs.map((d) => d.id)).toEqual(['a'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanActions: custom ignore replaces defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    await writeFixture(dir, 'actions.ts',
      `'use server'\nexport async function a(_req) {}\n`,
    )
    await writeFixture(dir, 'actions.test.ts',
      `'use server'\nexport async function fromTest(_req) {}\n`,
    )
    // Custom ignore omits the test pattern → test file IS scanned.
    const defs = await scanActions({ roots: [dir], ignore: ['node_modules/**'] })
    expect(defs.map((d) => d.id).sort()).toEqual(['a', 'fromTest'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanActions: duplicate id across files throws with both paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const pathA = await writeFixture(dir, 'one.ts',
      `'use server'\nexport async function dupe(_req) {}\n`,
    )
    const pathB = await writeFixture(dir, 'two.ts',
      `'use server'\nexport async function dupe(_req) {}\n`,
    )
    await expect(scanActions({ roots: [dir] })).rejects.toThrow(
      new RegExp(`Duplicate action "dupe".*${pathA}.*${pathB}|Duplicate action "dupe".*${pathB}.*${pathA}`),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanActions: sorted alphabetical for deterministic boot logs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    await writeFixture(dir, 'z.ts',
      `'use server'\nexport async function zebra(_req) {}\nexport async function apple(_req) {}\n`,
    )
    const defs = await scanActions({ roots: [dir] })
    expect(defs.map((d) => d.id)).toEqual(['apple', 'zebra'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
