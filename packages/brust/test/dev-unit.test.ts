// `brust dev` pieces that need no browser: the status block render, the TUI's plain mode, the shared watch loop
// (an edit during a run is not dropped), build-output parsing, script injection and the ignore rules.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseBuildError, parseWarnings } from '../src/dev/diag'
import { contrast, tierCounts } from '../src/dev/devtools-data'
import { allowedHosts, inject, sameOriginOrNone } from '../src/dev/proxy'
import { HOTKEYS, MAX_STATUS_LINES, renderStatus, rowsFor, Tui, tuiMode } from '../src/dev/tui'
import { broadRootWarnings, countFiles, defaultIgnored, watchLoop } from '../src/dev/watch'

const base = { url: 'http://localhost:1337', gen: 3, buildMs: 412, warnings: [] as string[] }

test('renderStatus: ready, with the last request and the hotkeys (snapshot)', () => {
  const lines = renderStatus({ ...base, state: 'ready', last: { method: 'GET', path: '/pokemon/pikachu', status: 200 } }, 100)
  expect(lines).toEqual([
    '● ready  http://localhost:1337  gen 3 · built in 412ms',
    '  last: GET /pokemon/pikachu → 200',
    `  ${HOTKEYS}`,
  ])
})

test('renderStatus: building, an error line, the warnings count with the first warning', () => {
  expect(renderStatus({ ...base, state: 'building', buildMs: undefined }, 100)[0]).toBe('◌ building  http://localhost:1337  gen 3')
  const e = renderStatus({ ...base, state: 'error', error: 'jsx-unsupported pages/A.tsx:3 no spread' , warnings: ['hook-unsupported a.tsx:1:1 x', 'b']}, 100)
  expect(e).toEqual([
    '✖ error  http://localhost:1337  gen 3 · built in 412ms',
    '  error: jsx-unsupported pages/A.tsx:3 no spread',
    '  warnings: 2 — hook-unsupported a.tsx:1:1 x',
    `  ${HOTKEYS}`,
  ])
})

test('renderStatus: never more than 6 lines and never wider than the terminal (a narrow one truncates with …)', () => {
  const s = renderStatus({ ...base, state: 'error', error: 'x'.repeat(300), warnings: ['w'.repeat(300)], last: { method: 'GET', path: `/${'p'.repeat(200)}`, status: 500 } }, 40)
  expect(s.length).toBeLessThanOrEqual(MAX_STATUS_LINES)
  for (const l of s) expect([...l].length).toBeLessThanOrEqual(39)
  expect(s.some((l) => l.endsWith('…'))).toBe(true)
})

test('rowsFor counts wrapped lines at the current width', () => {
  expect(rowsFor(['a'.repeat(10), 'b'], 80)).toBe(2)
  expect(rowsFor(['a'.repeat(100), 'b'], 40)).toBe(4)
  expect(rowsFor([''], 40)).toBe(1)
})

const sink = () => {
  const w: string[] = []
  return { out: { write: (s: string) => w.push(s), columns: 60, isTTY: false }, w }
}

test('tuiMode: a TTY outside CI/NO_COLOR is interactive; everything else is plain', () => {
  const tty = { write: () => {}, isTTY: true, columns: 80 }
  expect(tuiMode(tty, {}).interactive).toBe(true)
  expect(tuiMode(tty, { CI: '1' }).interactive).toBe(false)
  expect(tuiMode(tty, { NO_COLOR: '1' }).interactive).toBe(false)
  expect(tuiMode({ write: () => {}, isTTY: false }, {}).interactive).toBe(false)
})

test('Tui plain mode: line logs only, no escape codes, a status line only when it changes', () => {
  const { out, w } = sink()
  const t = new Tui(out, false)
  t.log('GET / 200 3ms HIT')
  t.setStatus({ ...base, state: 'building', buildMs: undefined })
  t.setStatus({ ...base, state: 'building', buildMs: undefined, last: { method: 'GET', path: '/', status: 200 } })
  t.setStatus({ ...base, state: 'ready' })
  const all = w.join('')
  expect(all).toBe('GET / 200 3ms HIT\n[brust] building http://localhost:1337 gen 3\n[brust] ready http://localhost:1337 gen 3 (412ms)\n')
  expect(all).not.toContain('\x1b')
})

test('Tui interactive: a log line is printed above the block, the old block is erased by cursor-up (never the alternate screen)', () => {
  const { out, w } = sink()
  const t = new Tui({ ...out, isTTY: true }, true, false)
  t.setStatus({ ...base, state: 'ready' })
  const first = w.join('')
  expect(first.split('\n').length - 1).toBe(3)
  w.length = 0
  t.log('GET / 200 1ms')
  const redraw = w.join('')
  expect(redraw.startsWith('\r\x1b[3A\x1b[J')).toBe(true)
  expect(redraw).toContain('GET / 200 1ms\n')
  expect(redraw).not.toContain('\x1b[?1049h')
})

test('Tui resize: the rows the block took are recounted at the new width', () => {
  const o = { write: (s: string) => void w.push(s), columns: 100, isTTY: true }
  const w: string[] = []
  const t = new Tui(o, true, false)
  t.setStatus({ ...base, state: 'ready' })
  w.length = 0
  o.columns = 30
  t.resize()
  // the first line is 53 columns wide: at 30 columns it wrapped to 2 rows, so 2 + 1 + 1 rows are erased.
  expect(w.join('')).toMatch(/^\r\x1b\[\d+A\x1b\[J/)
  const n = Number(/\x1b\[(\d+)A/.exec(w.join(''))?.[1])
  expect(n).toBeGreaterThanOrEqual(4)
})

test('watchLoop: an edit that arrives while a run is in flight triggers another run; none is dropped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brust-watch-'))
  try {
    const runs: string[][] = []
    let release: () => void = () => {}
    const loop = watchLoop({
      root: dir,
      ignored: () => false,
      debounceMs: 20,
      async run(changed) {
        runs.push([...changed].sort())
        if (runs.length === 1) await new Promise<void>((r) => (release = r))
      },
    })
    // The watcher arms asynchronously (FSEvents): a single write right after `watchLoop` can fall before it, and the
    // test then waits for a run that never starts. Re-write until the first run is seen (F200 family).
    for (let i = 0; runs.length < 1; i++) {
      writeFileSync(join(dir, 'a.txt'), String(i))
      await Bun.sleep(50)
    }
    writeFileSync(join(dir, 'b.txt'), '2') // during the first run
    await Bun.sleep(120)
    expect(runs.length).toBe(1) // still the first run: single-flight
    release()
    await loop.idle()
    expect(runs.flat()).toContain('a.txt')
    expect(runs.flat()).toContain('b.txt')
    expect(runs.length).toBe(2)
    loop.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('defaultIgnored: dependency dirs, brust output, editor temp files and databases', () => {
  for (const r of ['node_modules/x/y.js', '.git/HEAD', '.brust/dev/g1/manifest.json', 'dist/manifest.json', 'dist', 'a/b.swp', 'x.tsx~', 'data/team.sqlite', 'data/team.sqlite-wal', '.DS_Store']) expect(defaultIgnored(r, 'dist')).toBe(true)
  for (const r of ['routes.tsx', 'pages/Home.tsx', 'public/app.css', 'brust.toml', 'distillery/x.ts']) expect(defaultIgnored(r, 'dist')).toBe(false)
})

test('parseBuildError / parseWarnings read the CLI output', () => {
  const out = 'warning hook-unsupported a.tsx:1:2 nope\nerror jsx-unsupported pages/Home.tsx:4:7 spread is not supported\n  at foo\n'
  expect(parseBuildError(out)).toEqual({ rule: 'jsx-unsupported', file: 'pages/Home.tsx', line: 4, col: 7, message: 'spread is not supported', raw: 'error jsx-unsupported pages/Home.tsx:4:7 spread is not supported\n  at foo' })
  expect(parseBuildError('error route-dup message without a location')).toMatchObject({ rule: 'route-dup', message: 'message without a location' })
  expect(parseBuildError('all fine')).toBeNull()
  expect(parseWarnings(out)).toEqual(['hook-unsupported a.tsx:1:2 nope'])
})

test('inject puts the dev client before </head>, else at the end', () => {
  expect(inject('<html><head><title>x</title></head><body></body></html>', 7)).toBe('<html><head><title>x</title><script type="module" src="/_brust/dev/client.js?g=7"></script><script type="module" src="/_brust/dev/devtools.js"></script></head><body></body></html>')
  expect(inject('<p>hi</p>', 2)).toBe('<p>hi</p><script type="module" src="/_brust/dev/client.js?g=2"></script><script type="module" src="/_brust/dev/devtools.js"></script>')
})

test('watchLoop: reading a directory (atime) is not a change; a file written in it is', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brust-watch-'))
  try {
    mkdirSync(join(dir, 'public'))
    writeFileSync(join(dir, 'public', 'a.css'), 'a')
    let seen: string[] = []
    const loop = watchLoop({ root: dir, ignored: () => false, debounceMs: 20, run: async (changed) => void seen.push(...changed) })
    const until = async (what: string, f: () => boolean) => {
      for (const t0 = Date.now(); !f(); ) {
        if (Date.now() - t0 > 30_000) throw new Error(`timed out: ${what}`)
        await Bun.sleep(10)
      }
    }
    // The watcher arms asynchronously and FSEvents may still deliver the setup writes late. A sentinel written after
    // the setup is seen only once the watcher is armed, and events arrive in order, so the setup noise is behind it.
    for (let i = 0; !seen.includes('public/arm.txt'); i++) {
      writeFileSync(join(dir, 'public', 'arm.txt'), String(i))
      await Bun.sleep(50)
    }
    await loop.idle()
    // The sentinel's own late events are noise from here on: only other files count.
    const real = () => [...new Set(seen)].filter((f) => f !== 'public/arm.txt')
    seen = []
    readdirSync(join(dir, 'public'))
    readFileSync(join(dir, 'public', 'a.css'))
    await Bun.sleep(300) // an absence check: a longer wait only makes it stricter
    expect(real()).toEqual([])
    writeFileSync(join(dir, 'public', 'a.css'), 'b')
    await until('the write to be seen', () => seen.includes('public/a.css'))
    await loop.idle()
    expect(real()).toEqual(['public/a.css'])
    loop.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('allowedHosts / sameOriginOrNone: the DNS-rebinding and cross-site WebSocket guards', () => {
  const a = allowedHosts('localhost', 'dev.test, tunnel.example')
  for (const h of ['localhost', '127.0.0.1', '[::1]', 'dev.test', 'tunnel.example']) expect(a.has(h)).toBe(true)
  expect(a.has('evil.example')).toBe(false)
  expect(sameOriginOrNone(null, 'localhost:1337')).toBe(true)
  expect(sameOriginOrNone('http://localhost:1337', 'localhost:1337')).toBe(true)
  expect(sameOriginOrNone('https://evil.example', 'localhost:1337')).toBe(false)
  expect(sameOriginOrNone('null', 'localhost:1337')).toBe(false)
})

test('the status block shows the last page\'s tier counts from its trace', () => {
  const lines = renderStatus({ ...base, state: 'ready', last: { method: 'GET', path: '/x', status: 200, tiers: { static: 2, native: 1, react: 0 } } }, 100)
  expect(lines[1]).toBe('  last: GET /x → 200  ·  2 static 1 native 0 react')
})

test('devtools data: tierCounts reads dev.json tiers (unknown ids are not counted), contrast is WCAG', () => {
  const meta = { components: { a: { tier: 'static' as const }, b: { tier: 'native' as const }, c: { tier: 'react' as const } } }
  expect(tierCounts(['a', 'b', 'b', 'c', 'zzz'], meta)).toEqual({ static: 1, native: 2, react: 1 })
  expect(tierCounts(['a'], null)).toEqual({ static: 0, native: 0, react: 0 })
  expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5)
  expect(contrast([119, 119, 119], [255, 255, 255])).toBeCloseTo(4.48, 1)
  expect(contrast([255, 255, 255], [255, 255, 255])).toBe(1)
})

test('F273: watchLoop also watches a source root outside the app; its change is reported app-relative', async () => {
  const base = mkdtempSync(join(tmpdir(), 'brust-roots-'))
  try {
    const app = join(base, 'app')
    const shared = join(base, 'shared')
    mkdirSync(app)
    mkdirSync(shared)
    const seen = new Set<string>()
    const loop = watchLoop({ root: app, extraRoots: [shared], ignored: (r) => defaultIgnored(r, 'dist'), debounceMs: 20, run: async (c) => void c.forEach((x) => seen.add(x)) })
    // the watchers arm asynchronously: re-write until the edit is seen
    for (let i = 0; !seen.has('../shared/util.ts') && i < 60; i++) {
      writeFileSync(join(shared, 'util.ts'), String(i))
      await Bun.sleep(50)
    }
    expect(seen.has('../shared/util.ts')).toBe(true)
    // dependency dirs inside a root stay ignored
    mkdirSync(join(shared, 'node_modules'))
    writeFileSync(join(shared, 'node_modules', 'x.js'), '1')
    await Bun.sleep(200)
    await loop.idle()
    expect([...seen].some((x) => x.includes('node_modules'))).toBe(false)
    loop.close()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('F273: without extraRoots a file outside the app is not seen (control)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'brust-roots-'))
  try {
    mkdirSync(join(base, 'app'))
    mkdirSync(join(base, 'shared'))
    const seen: string[] = []
    const loop = watchLoop({ root: join(base, 'app'), ignored: () => false, debounceMs: 20, run: async (c) => void seen.push(...c) })
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(base, 'shared', 'util.ts'), String(i))
      await Bun.sleep(50)
    }
    await loop.idle()
    expect(seen).toEqual([])
    loop.close()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('F273: a source root with more than the limit of files is warned about; a small one and node_modules are not counted', () => {
  const base = mkdtempSync(join(tmpdir(), 'brust-roots-'))
  try {
    const big = join(base, 'big')
    mkdirSync(join(big, 'sub'), { recursive: true })
    mkdirSync(join(big, 'node_modules'))
    for (let i = 0; i < 8; i++) writeFileSync(join(big, i % 2 ? 'sub' : '.', `f${i}.ts`), '')
    for (let i = 0; i < 20; i++) writeFileSync(join(big, 'node_modules', `n${i}.js`), '')
    expect(countFiles(big, 100)).toBe(8)
    const warn = broadRootWarnings([big], base, 5)
    expect(warn.length).toBe(1)
    expect(warn[0]).toContain('big')
    expect(warn[0]).toContain('more than 5 files')
    expect(broadRootWarnings([big], base, 8)).toEqual([])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
