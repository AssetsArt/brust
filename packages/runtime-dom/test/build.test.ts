import { expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

test('bun build produces a react-free ESM bundle under 12 KB (minified)', () => {
  const r = spawnSync('bun', ['scripts/build.ts'], { cwd: import.meta.dir + '/..', encoding: 'utf8' })
  expect(r.status).toBe(0)
  const out = import.meta.dir + '/../dist/index.js'
  expect(existsSync(out)).toBe(true)
  const src = readFileSync(out, 'utf8')
  expect(src.includes('from "react')).toBe(false)
  expect(src.includes('react/jsx-runtime')).toBe(false)
  expect(statSync(out).size).toBeLessThan(12 * 1024)
})
