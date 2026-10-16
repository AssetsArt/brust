import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPORT, classifyBuild, renderReport, runBattery, runtimeBytes, type Result } from './run.ts'
import { rows } from './rows.ts'

const results = runBattery()   // one cargo build + 60 brustc runs, shared by the tests below

test('a snippet that does not parse is a compile-error row and does not abort the battery', () => {
  const r = results.find((x) => x.row.id === 'e-parse-error')!
  expect(r.observed).toBe('compile-error')
  expect(r.message).toMatch(/^Syntax Error \(input\.tsx:1:\d+\)$/)
  expect(results.length).toBe(rows.length)
})

test('report rows are fixed strings built from the row name, not machine paths or ids', () => {
  const pick = (id: string) => results.find((x) => x.row.id === id) as Result
  const report = renderReport([pick('a-static-text'), pick('c-usetransition')])
  const lines = report.split('\n').filter((l) => l.startsWith('| a-static-text') || l.startsWith('| c-usetransition'))
  // F143: the Runtime column (KiB gzip) sits after Build: 0 for a page with no client JS, core + island for a react row
  expect(lines).toEqual([
    '| a-static-text | static text | static | static | 0 | ok | 0 | — | spec §3.1 static tier |',
    expect.stringMatching(/^\| c-usetransition \| useTransition \| react \| react \| ssr \| ok \| \d+\.\d \| fallback:hook-unsupported \| {2}\|$/),
  ])
  const full = renderReport(results)
  expect(full).not.toMatch(/\/Users\/|\/tmp\/|\/var\/|input_[0-9a-f]{8}|battery-/)
})

test('the committed report equals a fresh run (CI diffs it too)', () => {
  expect(readFileSync(REPORT, 'utf8')).toBe(renderReport(results))
})

test('classifyBuild: ok, refused by an Error diagnostic, and failed (no diagnostic, panic)', () => {
  expect(classifyBuild(0, '', false)).toBe('ok')
  expect(classifyBuild(1, 'error list-key input.tsx:1:82 list items need a `key`', true)).toBe('refused')
  expect(classifyBuild(1, '', true)).toBe('failed')
  expect(classifyBuild(1, 'thread main panicked at x', true)).toBe('failed')
  expect(classifyBuild(1, 'something broke', false)).toBe('failed')
  expect(classifyBuild(101, "thread 'main' panicked at src/x.rs:1:1", true)).toBe('failed')
  expect(classifyBuild(1, "thread 'main' panicked at src/x.rs:1:1", true)).toBe('failed')
  expect(classifyBuild(null, '', true)).toBe('failed')
})

test('every row lowers: non-error rows build ok, error rows are refused, nothing failed', () => {
  expect(results.filter((r) => r.built && r.build === 'failed').map((r) => r.row.id)).toEqual([])
  expect(results.filter((r) => r.built && r.build === 'refused').map((r) => r.row.id).sort()).toEqual(
    results.filter((r) => r.observed === 'error').map((r) => r.row.id).sort())
})

test('html_raw (the one unescaped sink) is printed only for dangerouslySetInnerHTML rows', () => {
  const built = results.filter((r) => r.built && r.build === 'ok')
  const withSink = built.filter((r) => r.rawSinks > 0).map((r) => r.row.id)
  // Only a static/native row prints a template with the sink; a react row's markup is React's.
  expect(withSink.sort()).toEqual(['a-inner-html', 'a-inner-html-state'])
  for (const r of built) {
    if (!r.row.snippet.includes('dangerouslySetInnerHTML')) expect(r.rawSinks).toBe(0)
  }
  expect(results.find((r) => r.row.id === 'a-inner-html-react')!.observed).toBe('react')
})

test('F143 runtimeBytes: core plus exactly the feature modules the printed templates need', () => {
  const sizes = { core: 1000, features: { basics: 100, if: 10, for: 20, model: 30, html: 40, island: 5 } }
  const out = mkdtempSync(join(tmpdir(), 'battery-rt-test-'))
  try {
    const put = (name: string, text: string) => (mkdirSync(out, { recursive: true }), writeFileSync(join(out, name), text))
    expect(runtimeBytes(out, 'static', sizes)).toBe(0) // nothing printed: no client JS
    put('a.jinja', '<p>hi</p>')
    expect(runtimeBytes(out, 'static', sizes)).toBe(0) // a static template with no directive loads no runtime
    put('b.jinja', '<button x-data="b" x-on-click="_h1" x-text="_c1">0</button>')
    put('b.client.js', 'export default 1')
    expect(runtimeBytes(out, 'native', sizes)).toBe(1100) // core + basics
    put('c.jinja', '<ul x-data="c"><template x-for="i in xs"></template><i x-if="ok"></i><input x-model="v"></ul>')
    expect(runtimeBytes(out, 'native', sizes)).toBe(1000 + 100 + 10 + 20 + 30)
    put('d.jinja', '<brust-island data-id="d"></brust-island>')
    expect(runtimeBytes(out, 'static', sizes)).toBe(1000 + 100 + 10 + 20 + 30 + 5)
    // a directive named in prose (outside a tag) binds nothing
    rmSync(out, { recursive: true, force: true })
    put('e.jinja', '<p>use x-for to loop</p>')
    expect(runtimeBytes(out, 'static', sizes)).toBe(0)
    // a react-tier row is an island even when no template shows one
    expect(runtimeBytes(out, 'react', sizes)).toBe(1005)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
