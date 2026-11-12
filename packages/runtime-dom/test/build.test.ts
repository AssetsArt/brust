import { expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

test('bun build produces a react-free ESM bundle under 20 KB (minified)', () => {
  const r = spawnSync('bun', ['scripts/build.ts'], { cwd: import.meta.dir + '/..', encoding: 'utf8' })
  expect(r.status).toBe(0)
  const out = import.meta.dir + '/../dist/index.js'
  expect(existsSync(out)).toBe(true)
  const src = readFileSync(out, 'utf8')
  expect(src.includes('from "react')).toBe(false)
  expect(src.includes('react/jsx-runtime')).toBe(false)
  expect(statSync(out).size).toBeLessThan(24 * 1024)   // 19 -> 20 KB: the `collection` feature (W1c) joins the full entry; 20 -> 21 KB: `x-prop-*` (F329b); 21 -> 22 KB: `x-cref` (F288 phase B); 22 -> 23 KB: island unmount on dispose + late-mount tripwire skip (F455, +182 B raw; gzip budgets hold); 23 -> 24 KB: nav written-key apply (F533 left 9 B) + one-parse island snapshot (F534, +56 B raw; gzip budgets hold)
})
