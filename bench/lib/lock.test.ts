import { expect, test } from 'bun:test'
import { isStale, parseLock } from './lock'

test('parseLock reads "<slug> <agent> <ISO>" and rejects anything else', () => {
  expect(parseLock('m3b-bench-suite knock2 2026-10-10T01:20:00.000Z')).toEqual({ owner: 'm3b-bench-suite knock2', at: '2026-10-10T01:20:00.000Z' })
  expect(parseLock(null)).toBeNull()
  expect(parseLock('garbage')).toBeNull()
})
test('a lock older than 20 minutes is stale, a fresh one is not', () => {
  const now = Date.parse('2026-10-10T02:00:00Z')
  expect(isStale({ owner: 'a b', at: '2026-10-10T01:30:00Z' }, now)).toBe(true)
  expect(isStale({ owner: 'a b', at: '2026-10-10T01:50:00Z' }, now)).toBe(false)
  expect(isStale({ owner: 'a b', at: 'not-a-date' }, now)).toBe(true)
})

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tryFileLock } from './lock'

const lockPath = () => join(mkdtempSync(join(tmpdir(), 'benchlock-')), 'l')

test('the lock file is exclusive: the second taker is refused and sees the holder; release frees it', () => {
  const p = lockPath()
  const a = tryFileLock(p, 'a x')
  expect(a.ok).toBe(true)
  const b = tryFileLock(p, 'b y')
  expect(b.ok).toBe(false)
  expect((b as { holder: string }).holder).toContain('a x')
  if (a.ok) a.release()
  expect(tryFileLock(p, 'b y').ok).toBe(true)
})
test('a lock whose holder pid is dead is stale and replaced; a foreign live holder is left alone', () => {
  const p = lockPath()
  writeFileSync(p, `999999 ${new Date().toISOString()} ghost agent`)
  const a = tryFileLock(p, 'a x')
  expect(a.ok).toBe(true)
  expect(readFileSync(p, 'utf8')).toContain('a x')
  const live = lockPath()
  writeFileSync(live, `${process.ppid} ${new Date().toISOString()} other lane`)
  expect(tryFileLock(live, 'a x').ok).toBe(false)
})
test('release removes only our own lock file content', () => {
  const p = lockPath()
  const a = tryFileLock(p, 'a x')
  writeFileSync(p, `${process.ppid} ${new Date().toISOString()} someone else`)
  if (a.ok) a.release()
  expect(readFileSync(p, 'utf8')).toContain('someone else')
})
