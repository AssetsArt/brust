// React coverage — what each React API becomes in brust (native, static, island, partial), one table per group.
// Everything on this page is read from docs/react-coverage.json, the report the coverage battery regenerates; the page
// holds no number of its own. source: docs/react-coverage.json (summary, groups, entries), docs/react-coverage.md.
import coverage from '../../../docs/react-coverage.json'
import type { TocItem } from '../../lib/nav'
import Lead from '../../components/docs/Lead'
import TableWrap from '../../components/docs/TableWrap'

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
    .replace(/outside §[\d.]+/g, 'outside the supported hooks')
    .replace(/\b(spec §[\d.]+|F\d+)\b:?\s*/g, '')
    .replace(/\s*§[\d.]+/g, '')
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
      <Lead>
        Each React API, and what brust does with it: lowered to native code, rendered once as static markup, or left to React as an island. Every row is a case the test battery builds and checks.
      </Lead>

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

      <h2 id="control-flow">Early returns and switch</h2>
      {/* source: crates/brust-compiler/src/analyze/hooks.rs:4484 (read_switch_chain: stacked cases, default last, a literal-message throw as the default, the refusals);
          crates/brust-compiler/tests/hooks_reader.rs:919 (accepted forms and each refusal); tests/server/switch-return.chromium.test.ts:59-74 (static page equals React's markup, strict ===, native on state). */}
      <p>
        A component body may choose what it returns with an early-return chain, <code>if (a) return A</code> and so on down to a last return, or with a <code>switch</code> on a prop, a state value or a member path such as <code>item.type</code>, when every case
        ends in <code>return</code>. Stacked cases (<code>case 'a': case 'b':</code>) and a <code>default</code> are fine, and a <code>default</code> may throw <code>new Error</code> with a literal message. Cases compare with <code>===</code>, so the string <code>'1'</code> does not
        match the number <code>1</code>. The tier follows the discriminant like any condition: props only keeps the page static, state makes the choice follow the clicks.
      </p>
      <p>
        A <code>switch</code> that could fall through, leave with <code>break</code>, declare a <code>const</code> outside braces, or test something that is not a literal stays a React island, and the build names it <code>switch-fallthrough</code>. End every case with <code>return</code> to keep it native or static.
      </p>
      {/* source: crates/brust-compiler/src/lower/template.rs (Printer::if_chain: one branch per case; Printer::twice: TWICE_BUDGET, reactive-if-depth);
          crates/brust-compiler/tests/if_chain.rs; tests/server/if-chain.chromium.test.ts (a 38-case switch in the rows of a store-reactive list). */}
      <p>
        However long the chain, each case is printed once. Conditionals nested inside one another are different: a level that follows state, a store or a list row
        prints both of its branches, so what sits under it doubles. A component whose nested conditionals and lists print more than 8 MiB of such copies stops the
        build with <code>reactive-if-depth</code>, naming the component and the depth. Turn the nesting into one <code>if / else if</code> chain or{' '}
        <code>switch</code>, or compute the choice into one value first.
      </p>

      {groups.map((g) => (
        <section style={{ display: 'contents' }} key={g.id}>
          <h2 id={g.id}>{g.title}</h2>
          <TableWrap>
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
          </TableWrap>
        </section>
      ))}
    </section>
  )
}
