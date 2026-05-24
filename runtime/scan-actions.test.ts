import { test, expect } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripLeadingTrivia, hasUseServerDirective } from './scan-actions.ts'

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
