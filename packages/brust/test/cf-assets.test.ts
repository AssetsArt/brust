import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { headersFile, isHashed, layoutAssets } from '../src/build/cf-assets'

const dirs: string[] = []
function tmp(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'brust-cfa-'))
  dirs.push(d)
  for (const [k, v] of Object.entries(files)) {
    mkdirSync(dirname(join(d, k)), { recursive: true })
    writeFileSync(join(d, k), v)
  }
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('L19: the fonts and images a stylesheet references are copied from client/, other types are not', () => {
  const out = tmp({ 'client/inter-1a2b3c4d5e.woff2': 'x', 'client/bg-0a1b2c3d4e.png': 'x', 'client/x.html': 'x', 'client/x.wasm': 'x' })
  const cf = tmp({})
  expect(layoutAssets(out, cf, '2.0.0').files.sort()).toEqual(['_brust/client/bg-0a1b2c3d4e.png', '_brust/client/inter-1a2b3c4d5e.woff2'])
})

test('inadmissible files are not copied; hashed gets immutable, plain gets 3600', () => {
  const out = tmp({
    'client/runtime-1a2b3c4d.js': 'x',
    'client/app.css': 'x',
    'client/manifest.json': '{}',
    'public/.env': 'secret',
    'public/a b.png': 'x',
    'public/img/logo-1a2b3c.png': 'x',
    'public/robots.txt': 'x',
  })
  const cf = tmp({})
  const { files } = layoutAssets(out, cf, '2.0.0')
  expect(files.sort()).toEqual(['_brust/client/app.css', '_brust/client/runtime-1a2b3c4d.js', 'public/img/logo-1a2b3c.png', 'public/robots.txt'])
  expect(existsSync(join(cf, 'assets/public/.env'))).toBe(false)
  const h = readFileSync(join(cf, 'assets/_headers'), 'utf8')
  expect(h).toContain('/*\n  X-Content-Type-Options: nosniff\n  X-Powered-By: brust/2.0.0')
  expect(h).toContain('/_brust/client/*\n  Cache-Control: public, max-age=31536000, immutable')
  expect(h).toContain('/public/img/logo-1a2b3c.png\n  Cache-Control: public, max-age=31536000, immutable')
  expect(h).toContain('/public/robots.txt\n  Cache-Control: public, max-age=3600')
})

test('more than 97 public files fall back to one splat rule with a warning', () => {
  const files = Array.from({ length: 120 }, (_, i) => `public/f${i}.txt`)
  const { text, warnings } = headersFile(files, '2.0.0')
  expect(text).toContain('/public/*\n  Cache-Control: public, max-age=3600')
  expect(text).not.toContain('/public/f1.txt')
  expect(warnings).toHaveLength(1)
  expect(text.split('\n\n').length).toBeLessThanOrEqual(100)
})

test('isHashed agrees with static_rules.rs', () => {
  expect(isHashed('client/detailPage_c3-1a2b3c.js')).toBe(true)
  expect(isHashed('client/runtime-8b1c.js')).toBe(false)
  expect(isHashed('client/x-1A2B3C.js')).toBe(false)
  expect(isHashed('client/react-19.2.0.js')).toBe(false)
  expect(isHashed('public/brand-facade.css')).toBe(false)
  expect(isHashed('public/decade-abcdef.css')).toBe(false)
  expect(isHashed('public/logo-abcde1.svg')).toBe(true)
})
