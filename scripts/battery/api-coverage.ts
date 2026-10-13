// Coverage per react.dev reference entry: derived from the battery results, never claimed without a row (R18.2).
// Feeds `docs/react-coverage.json` and the "By React API" section of `docs/react-coverage.md`.
import { API_GROUPS, type ApiEntry, type ApiGroup, FETCHED, REACT_API } from './react-api.ts'
import type { Expect } from './rows.ts'
import type { Result } from './run.ts'

/** `native`: compiles to the native tier, no React shipped. `static`: no client code at all. `island`: works, rendered as a React
 * island. `partial`: some shapes native/static, others island or refused (the note says which). `unsupported`: every shape is a
 * build/compile error. `n/a`: no meaning in brust. */
export type ApiStatus = 'native' | 'static' | 'island' | 'partial' | 'unsupported' | 'n/a'

/** Entries with no meaning in brust, and brust's answer (the one-line note). Everything else is derived from rows. */
export const NOT_APPLICABLE: Record<string, string> = {
  "'use client'": 'No directives: every component is classified by the compiler. The directive is ignored with a warning.',
  "'use server'": "No directives: server work is an Elysia app under `[actions]`, or a loader/job. A `'use server'` function is not a server function here.",
  'Server Components': 'No Server Components: a loader and the compiled jobs are the server half, components render to HTML on the Rust server.',
  'Server Functions': 'No Server Functions: call an `[actions]` route (`@brust/core/actions`) instead.',
  act: 'A test helper; it has no runtime meaning in a brust page. Importing it changes nothing about a component.',
}

export interface ApiShape {
  row: string
  authoring: string
  expected: Expect
  observed: Expect
  diagnostics: string[]
}

export interface ApiCoverage {
  name: string
  group: ApiGroup
  url: string
  status: ApiStatus
  /** Battery row ids, in battery order. */
  rows: string[]
  /** Distinct observed tiers across the rows. */
  tiers: Expect[]
  /** Distinct diagnostics (`class:rule`) across the rows. */
  diagnostics: string[]
  shapes: ApiShape[]
  /** One line. */
  note: string
}

export function statusOf(tiers: Expect[]): ApiStatus {
  const t = new Set(tiers)
  const good = t.has('static') || t.has('native')
  const bad = t.has('error') || t.has('compile-error')
  if (good && (t.has('react') || bad)) return 'partial'
  if (t.has('react') && bad) return 'partial'
  if (bad && !t.has('react') && !good) return 'unsupported'
  if (t.has('react')) return 'island'
  if (t.has('native')) return 'native'
  return 'static'
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

export function apiCoverage(results: Result[], entries: ApiEntry[] = REACT_API): ApiCoverage[] {
  return entries.map((entry) => {
    const rs = results.filter((r) => r.row.api?.includes(entry.name))
    const shapes: ApiShape[] = rs.map((r) => ({ row: r.row.id, authoring: r.row.authoring, expected: r.row.expect, observed: r.observed, diagnostics: r.diagnostics }))
    const tiers = [...new Set(rs.map((r) => r.observed))]
    const na = NOT_APPLICABLE[entry.name]
    const status: ApiStatus = na ? 'n/a' : statusOf(tiers)
    let note = na
    if (!note) {
      const by = (t: (x: Expect) => boolean) => rs.filter((r) => t(r.observed)).map((r) => r.row.id)
      const nat = by((o) => o === 'native' || o === 'static')
      const isl = by((o) => o === 'react')
      const err = by((o) => o === 'error' || o === 'compile-error')
      if (status === 'partial') note = [nat.length ? `native/static: ${nat.join(', ')}` : '', isl.length ? `island: ${isl.join(', ')}` : '', err.length ? `refused: ${err.join(', ')}` : ''].filter(Boolean).join('; ')
      else note = rs.find((r) => r.row.note)?.row.note ?? rs[0]?.row.authoring ?? ''
      const gap = rs.find((r) => r.row.knownGap)?.row.knownGap
      if (gap) note += `${note ? '; ' : ''}known gap: ${gap}`
    }
    return {
      name: entry.name,
      group: entry.group,
      url: entry.url,
      status,
      rows: rs.map((r) => r.row.id),
      tiers,
      diagnostics: [...new Set(rs.flatMap((r) => r.diagnostics))],
      shapes,
      note: oneLine(note),
    }
  })
}

export interface CoverageJson {
  generated: string
  reference: { fetched: string; sources: string[] }
  summary: Record<ApiStatus, number> & { entries: number }
  groups: Record<string, string>
  entries: ApiCoverage[]
}

export function coverageJson(results: Result[]): CoverageJson {
  const entries = apiCoverage(results)
  const summary = { entries: entries.length, native: 0, static: 0, island: 0, partial: 0, unsupported: 0, 'n/a': 0 } as CoverageJson['summary']
  for (const e of entries) summary[e.status]++
  return {
    generated: 'by `bun run battery`; do not edit',
    reference: { fetched: FETCHED, sources: ['https://react.dev/reference/react', 'https://react.dev/reference/react-dom', 'https://react.dev/reference/rsc'] },
    summary,
    groups: API_GROUPS,
    entries,
  }
}

const cell = (s: string) => s.replaceAll('|', '\\|')

/** The "By React API" markdown section (appended to `docs/react-coverage.md`). */
export function renderApiSection(results: Result[]): string {
  const j = coverageJson(results)
  const L: string[] = []
  L.push('## By React API', '')
  L.push(`Every entry of the React reference (react.dev, fetched ${j.reference.fetched}; the list is \`scripts/battery/react-api.ts\`), each backed by at least one row above. Generated with \`docs/react-coverage.json\`.`)
  L.push('`native`: compiles to the native tier, no React shipped. `static`: no client code. `island`: works, rendered as a React island. `partial`: some shapes native/static, others island or refused. `unsupported`: a build error. `n/a`: no meaning in brust. Legacy APIs are out of scope.', '')
  L.push('| Status | Entries |', '|---|---|')
  for (const s of ['native', 'static', 'partial', 'island', 'unsupported', 'n/a'] as const) L.push(`| ${s} | ${j.summary[s]} |`)
  L.push(`| **Total** | ${j.summary.entries} |`, '')
  for (const [g, title] of Object.entries(API_GROUPS)) {
    L.push(`### ${title}`, '', '| Entry | Status | Rows | Note |', '|---|---|---|---|')
    for (const e of j.entries.filter((x) => x.group === g)) L.push(`| [\`${e.name}\`](${e.url}) | ${e.status} | ${e.rows.join(', ')} | ${cell(e.note)} |`)
    L.push('')
  }
  return L.join('\n')
}
