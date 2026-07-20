import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { entryHasLiteralAiOptIn } from './ai-opt-in.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function entry(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'brust-ai-opt-in-'))
  dirs.push(dir)
  const file = join(dir, 'index.ts')
  writeFileSync(file, source)
  return file
}

test('detects literal ai: true on the imported brust run call', () => {
  const file = entry(`
    import { brust } from 'brustjs'
    await brust.run({ routes, entry: import.meta.url, ai: true })
  `)

  expect(entryHasLiteralAiOptIn(file)).toBe(true)
})

test('tracks a renamed brust import', () => {
  const file = entry(`
    import { brust as app } from 'brustjs'
    await app.run({ routes, entry: import.meta.url, ai: true })
  `)

  expect(entryHasLiteralAiOptIn(file)).toBe(true)
})

test('does not mistake a shadowing parameter for the imported brust binding', () => {
  const file = entry(`
    import { brust } from 'brustjs'
    function boot(brust: { run(options: unknown): void }) {
      brust.run({ ai: true })
    }
    void boot
  `)

  expect(entryHasLiteralAiOptIn(file)).toBe(false)
})

test('rejects an options object containing a spread even when ai: true is explicit', () => {
  const file = entry(`
    import { brust } from 'brustjs'
    const defaults = { workers: 1 }
    await brust.run({ ...defaults, ai: true })
  `)

  expect(entryHasLiteralAiOptIn(file)).toBe(false)
})

test('rejects unrelated calls and values that are not statically literal', () => {
  const sources = [
    `import { brust } from 'brustjs'; other.run({ ai: true })`,
    `import { brust } from './other'; brust.run({ ai: true })`,
    `import { brust } from 'brustjs'; const ai = true; brust.run({ ai })`,
    `import { brust } from 'brustjs'; const options = { ai: true }; brust.run(options)`,
    `import { brust } from 'brustjs'; brust.run({ ai: false })`,
    `import type { brust } from 'brustjs'; brust.run({ ai: true })`,
    `const text = "brust.run({ ai: true })"`,
  ]

  for (const source of sources) expect(entryHasLiteralAiOptIn(entry(source))).toBe(false)
})

test('uses the effective ai property instead of an earlier literal true', () => {
  const file = entry(`
    import { brust } from 'brustjs'
    await brust.run({ ai: true, ai: false })
  `)

  expect(entryHasLiteralAiOptIn(file)).toBe(false)
})
