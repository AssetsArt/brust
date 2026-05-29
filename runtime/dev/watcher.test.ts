import { describe, test, expect } from 'bun:test'
import { classifyPath, _testCoalesce, type ChangeKind } from './watcher.ts'

describe('runtime/dev/watcher classifyPath', () => {
  const cases: [string, ChangeKind | null][] = [
    ['/proj/pages/Home.tsx', 'ts'],
    ['/proj/components/Counter.tsx', 'ts'],
    ['/proj/util.ts', 'ts'],
    ['/proj/util.js', 'ts'],
    ['/proj/util.jsx', 'ts'],
    ['/proj/app.css', 'css'],
    ['/proj/index.html', 'html'],
    ['/proj/node_modules/foo/index.js', null],
    ['/proj/.git/HEAD', null],
    ['/proj/.brust/css/app.css', null],
    ['/proj/dist/index.js', null],
    ['/proj/foo.test.ts', null],
    ['/proj/foo.test.tsx', null],
    ['/proj/README.md', null],
    ['/proj/components/Button.module.css', 'component-css'],
    ['/proj/components/styles.css', 'component-css'],
    ['/proj/components/Button.module.css.d.ts', null],
  ]
  for (const [path, expected] of cases) {
    test(`classifyPath(${path}) = ${expected ?? 'null'}`, () => {
      expect(classifyPath(path, '/proj')).toBe(expected)
    })
  }
})

describe('runtime/dev/watcher coalesce', () => {
  test('multiple events within debounce window collapse to one callback', async () => {
    const calls: string[][] = []
    const c = _testCoalesce(50, (paths) => {
      calls.push(paths)
    })
    c.add('/a.ts')
    c.add('/b.ts')
    c.add('/a.ts')
    await new Promise((r) => setTimeout(r, 80))
    expect(calls).toEqual([['/a.ts', '/b.ts']])
  })

  test('events outside the window produce separate callbacks', async () => {
    const calls: string[][] = []
    const c = _testCoalesce(50, (paths) => {
      calls.push(paths)
    })
    c.add('/a.ts')
    await new Promise((r) => setTimeout(r, 80))
    c.add('/b.ts')
    await new Promise((r) => setTimeout(r, 80))
    expect(calls).toEqual([['/a.ts'], ['/b.ts']])
  })
})
