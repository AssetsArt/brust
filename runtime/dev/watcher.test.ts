import { describe, test, expect } from 'bun:test'
import { classifyPath, _testCoalesce, _testDispatchChanges, type ChangeKind } from './watcher.ts'

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
    // …ignored dirs stay ignored, same as every other kind.
    ['/proj/node_modules/pkg/README.md', null],
    ['/proj/.brust/jinja/notes.md', null],
    ['/proj/dist/CHANGELOG.md', null],
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

describe('runtime/dev/watcher classifyPath — md gating (S4)', () => {
  // md pages (task 2.9): a project .md is a content edit ONLY when the app has
  // md routes. An md-free app must not restart its workers because README.md
  // (or any stray .md) was saved — those classify as null (zero overhead).
  const mdPaths = ['/proj/README.md', '/proj/content/docs/guide.md']
  for (const p of mdPaths) {
    test(`hasMdRoutes=true → classifyPath(${p}) = 'md'`, () => {
      expect(classifyPath(p, '/proj', true)).toBe('md')
    })
    test(`hasMdRoutes=false → classifyPath(${p}) = null`, () => {
      expect(classifyPath(p, '/proj', false)).toBe(null)
    })
    test(`default (omitted) stays 'md' — back-compat`, () => {
      expect(classifyPath(p, '/proj')).toBe('md')
    })
  }
  test('hasMdRoutes=false leaves every other kind untouched', () => {
    expect(classifyPath('/proj/pages/Home.tsx', '/proj', false)).toBe('ts')
    expect(classifyPath('/proj/app.css', '/proj', false)).toBe('css')
    expect(classifyPath('/proj/index.html', '/proj', false)).toBe('html')
  })
  test('ignored dirs stay ignored regardless of the flag', () => {
    expect(classifyPath('/proj/node_modules/pkg/README.md', '/proj', true)).toBe(null)
  })
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

  test('one debounce window emits every distinct change kind in priority order', () => {
    const calls: Array<{ paths: string[]; kind: ChangeKind }> = []
    const tsPath = '/proj/Page.tsx'
    const appCssPath = '/proj/app.css'
    const modulePath = '/proj/Page.module.css'
    _testDispatchChanges([modulePath, tsPath, appCssPath, tsPath], {
      root: '/proj',
      onChange: (event) => calls.push(event),
    })

    expect(calls).toEqual([
      { paths: [tsPath], kind: 'ts' },
      { paths: [appCssPath], kind: 'css' },
      { paths: [modulePath], kind: 'component-css' },
    ])
  })
})
