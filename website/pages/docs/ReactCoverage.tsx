// React coverage — what each React API becomes in brust (native, static, island, partial), one table per group.
// Everything on this page is read from docs/react-coverage.json, the report the coverage battery regenerates; the page
// holds no number of its own. source: docs/react-coverage.json (summary, groups, entries), docs/react-coverage.md.
import coverage from '../../../docs/react-coverage.json'
import type { TocItem } from '../../lib/nav'

type Status = 'native' | 'static' | 'island' | 'partial' | 'n/a'

interface Entry {
  name: string
  url: string
  status: Status
  note: string
  diagnostics: string[]
}

interface Group {
  id: string
  title: string
  entries: Entry[]
}

export interface ReactCoverageData {
  toc: TocItem[]
  reference: string
  summary: Record<'entries' | 'native' | 'static' | 'island' | 'partial' | 'n/a', number>
  groups: Group[]
}

const TIER: Record<Status, string> = {
  native: 'Native',
  static: 'Static',
  island: 'React island',
  partial: 'Partial',
  'n/a': 'Not applicable',
}

/** The report's note without its internal spec reference ("spec §4.3 useRef" → "useRef"); empty when nothing is left. */
function plainNote(e: Entry): string {
  const n = e.note
    .replace(/^spec §[\d.]+(?: react tier)?:?\s*/, '')
    .replace(/\b(spec §[\d.]+|F\d+)\b:?\s*/g, '')
    .trim()
  return n === e.name || n === `<${e.name}>` ? '' : n
}

export async function reactCoverageLoader(): Promise<ReactCoverageData> {
  const groups: Group[] = Object.entries(coverage.groups).map(([id, title]) => ({
    id,
    title: title as string,
    entries: (coverage.entries as Entry[]).filter((e) => (e as Entry & { group: string }).group === id),
  }))
  return {
    toc: [{ id: 'summary', title: 'Summary' }, ...groups.map((g) => ({ id: g.id, title: g.title }))],
    reference: `react.dev, fetched ${coverage.reference.fetched}`,
    summary: coverage.summary as ReactCoverageData['summary'],
    groups,
  }
}

export default function ReactCoverage({ reference, summary, groups }: ReactCoverageData) {
  return (
    <section style={{ display: 'contents' }}>
      <h1>React coverage</h1>
      <p className="lead">
        Each React API, and what brust does with it: lowered to native code, rendered once as static markup, or left to React as an island. Every row is a case the test battery builds and checks.
      </p>

      <h2 id="summary">Summary</h2>
      <p>
        {summary.entries} entries from the React reference ({reference}): <strong data-testid="count-native">{summary.native}</strong> native,{' '}
        <strong data-testid="count-static">{summary.static}</strong> static, <strong data-testid="count-island">{summary.island}</strong> island,{' '}
        <strong data-testid="count-partial">{summary.partial}</strong> partial, <strong data-testid="count-na">{summary['n/a']}</strong> not applicable.
      </p>
      <ul>
        <li>
          <strong>Native</strong>: compiled to a template the server fills and a binding the browser updates; no React in the browser.
        </li>
        <li>
          <strong>Static</strong>: rendered once; the page ships the markup and nothing else.
        </li>
        <li>
          <strong>React island</strong>: the component runs in React, rendered by the worker and hydrated in the browser. The rest of the page keeps its tier.
        </li>
        <li>
          <strong>Partial</strong>: some shapes of the API are native or static and others are islands; the note says which.
        </li>
        <li>
          <strong>Not applicable</strong>: the API has no meaning in brust (there is no Server Components runtime).
        </li>
      </ul>

      {groups.map((g) => (
        <section style={{ display: 'contents' }} key={g.id}>
          <h2 id={g.id}>{g.title}</h2>
          <div className="table-wrap">
            <table data-testid={`table-${g.id}`}>
              <thead>
                <tr>
                  <th>Entry</th>
                  <th>Tier</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {g.entries.map((e) => (
                  <tr key={e.name}>
                    <td>
                      <a href={e.url}>
                        <code>{e.name}</code>
                      </a>
                    </td>
                    <td>{TIER[e.status]}</td>
                    <td>
                      {plainNote(e)}
                      {e.diagnostics.length > 0 ? (
                        <>
                          {plainNote(e) ? ' ' : ''}
                          {e.diagnostics.map((d) => (
                            <code key={d}>{d.replace(/^\w+:/, '')} </code>
                          ))}
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </section>
  )
}
