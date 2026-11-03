// F485: Windows path spelling, fed with backslashed inputs on any OS (the Windows run itself is the CI leg).
import { expect, test } from 'bun:test'
import { escapes, inServerOnlyPrefix, nativeOf, posixOf, relPosix } from '../src/build/posix'
import { openCommand } from '../src/dev/open'
import { type SwapOps, RENAME_TRIES, renameRetry } from '../src/build/swap'
import { BuildError } from '../src/build/errors'

const W = '\\'

test('posixOf / nativeOf: Windows separators become `/` and back; POSIX is a byte-identical no-op', () => {
  expect(posixOf('pages\\blog\\Post.tsx', W)).toBe('pages/blog/Post.tsx')
  expect(nativeOf('C:\\app/pages/X.tsx', W)).toBe('C:\\app\\pages\\X.tsx')
  expect(posixOf('a\\b/c', '/')).toBe('a\\b/c')
  expect(nativeOf('a/b', '/')).toBe('a/b')
})

test('relPosix on this platform never contains the platform separator', () => {
  expect(relPosix('/app', '/app/pages/X.tsx')).toBe('pages/X.tsx')
})

test('escapes: `..\\x`, a bare `..`, another drive and an absolute path are outside; a child is inside', () => {
  expect(escapes('..\\shared\\x.ts', W)).toBe(true)
  expect(escapes('..', W)).toBe(true)
  expect(escapes('D:\\other\\x.ts', W)).toBe(true)
  expect(escapes('../x', '/')).toBe(true)
  expect(escapes('lib\\x.ts', W)).toBe(false)
  expect(escapes('lib/x.ts', '/')).toBe(false)
  expect(escapes('..foo/x.ts', '/')).toBe(false) // a dir named `..foo` is inside
  expect(escapes('c:x/y.ts', '/')).toBe(false) // a drive-looking dir name is legal on POSIX
  expect(escapes('c:x\\y.ts', W)).toBe(true)
})

test('P3 (security): a backslashed server-only path is refused, a sibling and an outside path are not matched', () => {
  const serverOnly = ['lib/server', 'secrets.ts']
  expect(inServerOnlyPrefix('lib\\server\\db.ts', serverOnly, W)).toBe(true)
  expect(inServerOnlyPrefix('secrets.ts', serverOnly, W)).toBe(true)
  expect(inServerOnlyPrefix('lib\\client\\ui.ts', serverOnly, W)).toBe(false)
  expect(inServerOnlyPrefix('..\\lib\\server\\db.ts', serverOnly, W)).toBe(false)
  expect(inServerOnlyPrefix('lib/server/db.ts', serverOnly, '/')).toBe(true) // POSIX unchanged
  expect(inServerOnlyPrefix('c:x/k.ts', ['c:x'], '/')).toBe(true)
})

test('P7: the open-browser command per platform', () => {
  expect(openCommand('http://localhost:3000', 'darwin')).toEqual(['open', 'http://localhost:3000'])
  expect(openCommand('http://localhost:3000', 'linux')).toEqual(['xdg-open', 'http://localhost:3000'])
  expect(openCommand('http://localhost:3000', 'win32')).toEqual(['cmd', '/c', 'start', '', 'http://localhost:3000'])
})

function ops(failures: Array<string | undefined>): SwapOps & { calls: number; slept: number[] } {
  const o = {
    calls: 0,
    slept: [] as number[],
    rename: () => {
      const code = failures[o.calls++]
      if (code) throw Object.assign(new Error(code), { code })
    },
    sleep: (ms: number) => void o.slept.push(ms),
  }
  return o
}

test('P8: a held-handle rename is retried and then succeeds', () => {
  const o = ops(['EBUSY', 'EPERM', undefined])
  renameRetry('a', 'b', 'dist', o)
  expect(o.calls).toBe(3)
  expect(o.slept).toEqual([100, 100])
})

test('P8: still held after the last try -> a BuildError naming the dist dir and what to stop', () => {
  const o = ops(Array(RENAME_TRIES + 2).fill('EACCES'))
  let err: unknown
  try {
    renameRetry('a', 'b', 'C:\\app\\dist', o)
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(BuildError)
  expect((err as BuildError).message).toContain('C:\\app\\dist')
  expect((err as BuildError).message).toContain('brust start')
  expect(o.calls).toBe(RENAME_TRIES)
})

test('P8: any other error (ENOENT) is not retried', () => {
  const o = ops(['ENOENT'])
  expect(() => renameRetry('a', 'b', 'dist', o)).toThrow('ENOENT')
  expect(o.calls).toBe(1)
})
