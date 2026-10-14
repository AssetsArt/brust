// shadcn/ui and React libraries — what compiles today, what stays a React island and why, and how to read the scoreboard.
// Nothing numeric is typed here: every count, tier and size comes from docs/shadcn-coverage.json, the file `bun run shadcn`
// regenerates (CI fails on a stale copy), the way ReactCoverage reads docs/react-coverage.json.
// source: docs/shadcn-coverage.json (summary, blockers, rows), docs/shadcn-coverage.md, scripts/shadcn/json.ts.
import coverage from '../../../docs/shadcn-coverage.json'
import CodeBlock from '../../components/CodeBlock'
import Lead from '../../components/docs/Lead'
import Note from '../../components/docs/Note'
import TableWrap from '../../components/docs/TableWrap'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'

interface Row {
  id: string
  basis: string
  tier: string
  islands?: number
  jsGzipKb?: number
  codes: string[]
}

export type ShadcnSummary = typeof coverage.summary

export interface ShadcnData {
  toc: TocItem[]
  summary: ShadcnSummary
  pinned: typeof coverage.pinned
  blockers: { name: string; measuredRows: number; meaning: string }[]
  rows: Row[]
  blocks: Record<'aschild' | 'member', CodeBlockData>
}

const ASCHILD = `// components/ui/button.tsx, as shadcn writes it
function Button({ className, variant, size, asChild = false, ...props }) {
  const Comp = asChild ? Slot.Root : 'button'
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

// pages/Home.tsx
<Button>Save</Button>                              // a <button>, static markup
<Button asChild><a href="/login">Login</a></Button>  // the <a>, with the button's props`

const MEMBER = `import { Dialog as DialogPrimitive } from 'radix-ui'

function Dialog({ ...props }) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />   // the package export, one island
}`

/** What a blocker means, in the words of this page. A code the table does not know is shown as its raw name. */
const MEANING: Record<string, string> = {
  'fallback:external-component': 'The component comes from a package. Radix primitives are compiled by React, so they render as an island of the package export.',
  'fallback:spread-props': 'Props are spread onto something that is not a plain element: a React island, or a value whose shape is not known when you build.',
  'fallback:island-children': 'An island receives children that are not constant (they read state, hold a handler, or call a function).',
  'fallback:local-component': 'A tag that is a local value (`const Comp = …`) of a shape brust does not resolve.',
  'fallback:member-tag': 'A member tag of a local object, such as a context provider, or deeper than one level.',
  'fallback:hook-unsupported': 'A React hook brust does not lower yet, such as `useContext` or `useReducer`.',
  'fallback:jsx-expression': 'A JSX expression the compiler cannot lower, such as a render function.',
  'fallback:prop-pattern': 'A props pattern with a nested or computed destructuring.',
  'fallback:child-component': 'A child component brust cannot resolve, such as a `forwardRef` constant.',
  'fallback:control-flow': 'Control flow in the component body that is not a single return.',
  'fallback:body-shape': 'A statement in the component body that brust does not read.',
  'fallback:island-prop': 'A function or a state value passed as a prop to a React island: the component that passes it renders with React, since it cannot be handed over as JSON.',
  'fallback:instance-list-path': 'A component with its own server computation inside a list whose rows depend on the row.',
}

const pretty = (k: string): string => k.replace(/^(fallback|error):/, '')

export async function shadcnLoader(): Promise<ShadcnData> {
  return {
    toc: [
      { id: 'compiles', title: 'What compiles' },
      { id: 'islands', title: 'What stays an island' },
      { id: 'numbers', title: 'The numbers' },
      { id: 'blockers', title: 'What blocks most pages' },
      { id: 'pages', title: 'Page by page' },
      { id: 'read', title: 'Read it yourself' },
    ],
    summary: coverage.summary,
    pinned: coverage.pinned,
    blockers: coverage.blockers
      .filter((b) => b.kind !== 'construct' && b.measuredRows > 0)
      .slice(0, 8)
      .map((b) => ({ name: b.blocker, measuredRows: b.measuredRows, meaning: MEANING[b.blocker] ?? '' })),
    rows: coverage.rows as Row[],
    blocks: {
      aschild: codeBlock({ lang: 'tsx', file: 'asChild at the call site', code: ASCHILD }),
      member: codeBlock({ lang: 'tsx', file: 'components/ui/dialog.tsx', code: MEMBER }),
    },
  }
}

export default function Shadcn({ summary, pinned, blockers, rows, blocks }: ShadcnData) {
  const s = summary
  return (
    <section style={{ display: 'contents' }}>
      <h1>shadcn/ui and React libraries</h1>
      <Lead>
        shadcn/ui copies its components into your project, so brust compiles them like your own code. Most of the markup becomes static or native; what needs Radix&rsquo;s behaviour stays a React island, and the build says which.
      </Lead>

      <h2 id="compiles">What compiles</h2>
      {/* source: docs/plans/2026-10-13-shadcn.md R34.14–R34.19 (rest props, spread), R34.21–R34.27 (constant children), R34.28–R34.34 (asChild), R34.35–R34.41 (member tags), R34.49–R34.55 (constant lists and conditions), R34.63–R34.64 (forwardRef); the release notes list the pull requests */}
      <ul>
        <li><strong>Rest props and spread.</strong> <code>{'{'} className, ...props {'}'}</code> in the signature and <code>{'{'}...props{'}'}</code> on an element, with handlers that come through the spread.</li>
        <li><strong><code>asChild</code> and <code>Slot</code>.</strong> Decided where the component is used, as below.</li>
        <li><strong>Constant children.</strong> Markup between the tags of a React island, when it is constant, travels into the island as data, so the page around it stays static. That includes a constant list (<code>[1, 2, 3].map(…)</code>, <code>Array.from({'{'} length: 4 {'}'})</code>), a constant condition and an element passed as a prop.</li>
        <li><strong><code>forwardRef</code>.</strong> A component wrapped in <code>forwardRef</code> compiles; a forwarded <code>ref</code> on an HTML element is dropped, and any other use of it keeps the component on React.</li>
        <li><strong>Member tags.</strong> <code>&lt;DialogPrimitive.Root&gt;</code> resolves to the package export.</li>
        <li><strong>Components exported by name.</strong> A file with many components (<code>Card</code>, <code>CardHeader</code>, …) is fine; any of them may be an island.</li>
      </ul>
      <CodeBlock code={blocks.aschild.code} lang={blocks.aschild.lang} cwd={blocks.aschild.cwd} html={blocks.aschild.html} />
      <CodeBlock code={blocks.member.code} lang={blocks.member.lang} cwd={blocks.member.cwd} html={blocks.member.html} />

      <h2 id="islands">What stays an island</h2>
      {/* source: docs/shadcn-coverage.json blockers (external-component, island-children, hook-unsupported, island-prop), docs/plans/2026-10-13-shadcn.md R34.5 */}
      <p>
        The Radix primitives themselves (dialogs, menus, tabs, selects) use React context, refs, portals and focus management, which brust does not lower yet, so each one is a React island of the package&rsquo;s own export. Components that wrap a React library
        (a chart, a calendar, a carousel, a command palette) are islands too. A function or a value that changes with state passed to an island makes the component that passes it render with React, and the build reports it as <code>island-prop</code>.
      </p>
      <Note>
        An island is not an error. The component works as it does in React; the page keeps its tier for everything around it.
      </Note>

      <h2 id="numbers">The numbers</h2>
      {/* source: docs/shadcn-coverage.json summary, pinned */}
      <p>
        The fixture app builds each of <strong data-testid="count-pages">{s.pages}</strong> pages alone, one per component of shadcn/ui ({pinned.shadcnCli}, registry {pinned.registry.split('/').pop()}, {pinned.items} components, radix-ui {pinned.radixUi}, React {pinned.react}).{' '}
        <strong data-testid="count-measured">{s.measured}</strong> build: <strong data-testid="count-static">{s.tier.static}</strong> are static, <strong data-testid="count-native">{s.tier.native}</strong> native and <strong data-testid="count-react">{s.tier.react}</strong> React.
        {s.analysisOnly > 0 ? (
          <>
            {' '}
            <strong data-testid="count-refused">{s.analysisOnly}</strong> are refused by the build.
          </>
        ) : (
          <> Every page builds.</>
        )}{' '}
        Together they hold <strong data-testid="count-islands">{s.islands}</strong> React islands; <strong data-testid="count-nojs">{s.pagesWithNoJs}</strong> pages load no JavaScript at all. The JavaScript a page loads, gzipped, is {s.jsGzipKb.min} KB at the
        least, {s.jsGzipKb.median} KB in the middle and {s.jsGzipKb.max} KB at the most.
      </p>
      <p>
        Across the libraries behind them ({s.libraries.packages} packages, {s.libraries.components} components) the compiler reads {s.libraries.static + s.libraries.native} as static or native today; the rest are the work still ahead.
      </p>

      <h2 id="blockers">What blocks most pages</h2>
      {/* source: docs/shadcn-coverage.json blockers (measuredRows: pages that built and show the code); the wording is this page's, keyed by code */}
      <TableWrap label="Blockers">
        <table data-testid="table-blockers">
          <thead>
            <tr>
              <th>Code</th>
              <th>Pages</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            {blockers.map((b) => (
              <tr key={b.name}>
                <td><code>{pretty(b.name)}</code></td>
                <td>{b.measuredRows}</td>
                <td>{b.meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>

      <h2 id="pages">Page by page</h2>
      {/* source: docs/shadcn-coverage.json rows (basis, tier, islands, jsGzipKb) */}
      <TableWrap label="Pages">
        <table data-testid="table-pages">
          <thead>
            <tr>
              <th>Page</th>
              <th>Tier</th>
              <th>Islands</th>
              <th>JavaScript (gzip)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><code>{r.id}</code></td>
                <td>{r.basis === 'measured' ? r.tier : `${r.tier} (refused by the build)`}</td>
                <td>{r.islands ?? '—'}</td>
                <td>{r.jsGzipKb === undefined ? '—' : r.jsGzipKb === 0 ? '0' : `${r.jsGzipKb} KB`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>

      <h2 id="read">Read it yourself</h2>
      {/* source: scripts/shadcn/README.md, docs/shadcn-coverage.md */}
      <p>
        The same data, with the full list of blockers and the library analysis, is in <code>docs/shadcn-coverage.md</code>. <code>bun run shadcn</code> in the brust repository regenerates both files; a pull request with a stale copy fails CI. Sizes are
        gzipped and rounded to 1 KB; a page that loads no JavaScript shows <code>0</code>. To see where your own app stands, run <code>brust build</code>: it prints a rule and a line for every component that falls back, and <code>dist/manifest.json</code> has each component&rsquo;s tier.
      </p>
    </section>
  )
}
