#!/usr/bin/env bun
/**
 * React authoring coverage for brust's NATIVE pipeline.
 *
 * Compiles a battery of ordinary React 18/19 constructs through the REAL
 * compiler — the same `compileJsx` napi entry point `runtime/cli/
 * native-routes-emit.ts` drives for every `native: true` route, seeded with the
 * same `gatherComponentSources` import walk — and classifies each construct as
 *
 *   INLINE              compiled to jinja, zero React SSR, zero JS
 *   FALLBACK-BY-DESIGN  not inlined, and that is the intended brust model
 *                       (hooks/effects/async belong to islands or `behavior`)
 *   GAP                 not inlined (or inlined with different semantics) even
 *                       though a static lowering is plausible → backlog
 *
 * Every row is compiled TWICE, because the two authoring positions are not the
 * same language: once as an imported component (`<Subject/>` mounted by a
 * trivial route) and once written directly in the route file. See the report's
 * Method section.
 *
 * Output: `docs/react-coverage.md` (committed). Deterministic — no wall clock,
 * stable row order, temp paths scrubbed — so re-runs diff cleanly.
 *
 *   bun scripts/react-coverage.ts
 *
 * TRAP: rebuild the addon first (`cd runtime && bun run build:debug`) or you are
 * measuring the coverage of whatever compiler was built last.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gatherComponentSources } from '../runtime/cli/native-routes-emit.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')
const REPORT_PATH = resolve(REPO_ROOT, 'docs/react-coverage.md')

/** Mirrors NATIVE_INLINE_FALLBACK_WARNING in runtime/cli/native-routes-emit.ts
 * — the shape the CLI itself parses to build its fallback guidance. The
 * `warning shape matches the CLI's own parser` case in
 * tests/react-coverage.test.ts fails if the two ever drift. */
const NOT_INLINED = /^native component "([^"\r\n]+)" not inlined: ([\s\S]+)$/

// ---------------------------------------------------------------------------
// Battery
// ---------------------------------------------------------------------------

/** Verdict for the component position — what we believe is honest today.
 * `expected` is documentation, not a gate: a disagreement with the actual run
 * renders as ⚠ so a regression (or a newly closed gap) shows up in the diff. */
type Verdict = 'inline' | 'fallback-by-design' | 'gap'

/** What the compiler actually did. */
type Observed = 'inlined' | 'fallback' | 'error' | 'no-marker'

/** The two authoring positions a construct can be written in. */
type Position = 'component' | 'route'

interface Entry {
  /** Stable id — also the row anchor used by the Gaps backlog. */
  id: string
  title: string
  /** Short authoring excerpt for the table (kept to one line). */
  excerpt: string
  /** Must appear in the emitted jinja for the row to count as inlined. */
  marker: string
  /** Module source whose DEFAULT EXPORT is the construct under test. Mounted as
   * `<Subject/>` for the component run, and used verbatim as the route file for
   * the route run. */
  subject: string
  /** Extra files the subject imports (relative, same dir). */
  extraFiles?: Record<string, string>
  /** How the wrapper route imports the subject in the component run. */
  importForm?: 'default' | 'named'
  /** Call-site attributes for the component run (`name={name}`). */
  callProps?: string
  /** Params of the wrapper route in the component run. */
  pageParams?: string
  expected: Verdict
  /** Expected result of writing the same code directly in the route file. */
  expectedRoute?: 'ok' | 'broken'
  /** Skip the component run (the construct only exists at route level). */
  componentPosition?: false
  /** Skip the route run. */
  routePosition?: false
  /** One line: why this status is acceptable, or why it is a gap. */
  note: string
  /** Set when the construct DOES inline but the React semantics differ — the
   * row is a GAP even though nothing fell back. */
  semanticGap?: string
}

interface Category {
  key: string
  title: string
  blurb: string
  entries: Entry[]
}

const CATEGORY_A: Category = {
  key: 'A',
  title: 'JSX basics',
  blurb:
    'Plain JSX and the expressions around it. This is the core of the native pipeline: everything here should become plain HTML with no React and no JS on the page.',
  entries: [
    {
      id: 'a-element-text',
      title: 'element + literal text',
      excerpt: '<p className="…">hello</p>',
      marker: 'class="a-element-text"',
      subject:
        'export default function Subject() {\n  return <p className="a-element-text">hello</p>\n}\n',
      expected: 'inline',
      note: 'Baseline — elements and literal text lower straight to markup.',
    },
    {
      id: 'a-expression-interpolation',
      title: 'expression interpolation',
      excerpt: '<p>{name}</p>',
      marker: '{{ (name)',
      subject:
        'export default function Subject({ name }: { name: string }) {\n  return <p className="a-expression-interpolation">{name}</p>\n}\n',
      callProps: 'name={name}',
      pageParams: '{ name }: { name: string }',
      expected: 'inline',
      note: 'Props become jinja variables, auto-escaped with `| e`.',
    },
    {
      id: 'a-attributes',
      title: 'literal / expression / data / aria attributes',
      excerpt: '<a href="/docs" title={name} data-count={3} aria-label="docs">',
      marker: 'href="/docs"',
      subject:
        'export default function Subject({ name }: { name: string }) {\n  return (\n    <a className="a-attributes" href="/docs" title={name} data-count={3} aria-label="docs">\n      docs\n    </a>\n  )\n}\n',
      callProps: 'name={name}',
      pageParams: '{ name }: { name: string }',
      expected: 'inline',
      note: 'Literal, expression, `data-*` and `aria-*` attributes all lower.',
    },
    {
      id: 'a-classname-template-literal',
      title: 'className from a template literal',
      excerpt: 'className={`box ${kind}`}',
      marker: 'a-classname-template-literal',
      subject:
        'export default function Subject({ kind }: { kind: string }) {\n  return <p className={`a-classname-template-literal ${kind}`}>x</p>\n}\n',
      callProps: 'kind={kind}',
      pageParams: '{ kind }: { kind: string }',
      expected: 'inline',
      expectedRoute: 'broken',
      note: 'Template literals are how every real component builds a class list.',
    },
    {
      id: 'a-style-object',
      title: 'style object',
      excerpt: "style={{ color: 'red', fontSize: 12 }}",
      marker: 'style="',
      subject:
        'export default function Subject() {\n  return (\n    <p className="a-style-object" style={{ color: \'red\', fontSize: 12 }}>\n      x\n    </p>\n  )\n}\n',
      expected: 'inline',
      note: 'Object styles are serialized to a CSS string at compile time.',
    },
    {
      id: 'a-conditional-and',
      title: 'conditional `&&`',
      excerpt: '{show && <b>y</b>}',
      marker: '{% if ',
      subject:
        'export default function Subject({ show }: { show: boolean }) {\n  return <div className="a-conditional-and">{show && <b>y</b>}</div>\n}\n',
      callProps: 'show={show}',
      pageParams: '{ show }: { show: boolean }',
      expected: 'inline',
      note: 'Short-circuit conditionals lower to `{% if %}` — no client JS.',
    },
    {
      id: 'a-ternary',
      title: 'ternary',
      excerpt: '{show ? <b/> : <i/>}',
      marker: '{% else %}',
      subject:
        'export default function Subject({ show }: { show: boolean }) {\n  return <div className="a-ternary">{show ? <b>y</b> : <i>n</i>}</div>\n}\n',
      callProps: 'show={show}',
      pageParams: '{ show }: { show: boolean }',
      expected: 'inline',
      note: 'Ternaries lower to `{% if %}` / `{% else %}`.',
    },
    {
      id: 'a-fragment-shorthand',
      title: 'fragment shorthand `<>…</>`',
      excerpt: '<><p/><p/></>',
      marker: 'class="a-fragment-shorthand-b"',
      subject:
        'export default function Subject() {\n  return (\n    <div className="a-fragment-shorthand">\n      <>\n        <p className="a-fragment-shorthand-a">one</p>\n        <p className="a-fragment-shorthand-b">two</p>\n      </>\n    </div>\n  )\n}\n',
      expected: 'inline',
      note: 'Fragments are transparent in the emitted markup.',
    },
    {
      id: 'a-fragment-explicit',
      title: 'explicit `<Fragment>` import',
      excerpt: '<Fragment><p/></Fragment>',
      marker: 'class="a-fragment-explicit"',
      subject:
        'import { Fragment } from \'react\'\nexport default function Subject() {\n  return (\n    <div>\n      <Fragment>\n        <p className="a-fragment-explicit">x</p>\n      </Fragment>\n    </div>\n  )\n}\n',
      expected: 'gap',
      expectedRoute: 'broken',
      note: 'The shorthand `<>…</>` inlines but the named `<Fragment>` import does not — the same JSX written two equivalent ways gives two different results, and `<Fragment key={…}>` is the only way to key a fragment in a list.',
    },
    {
      id: 'a-map-static-list',
      title: '`.map` over a module-level const',
      excerpt: '{ITEMS.map((i) => <li key={i}>{i}</li>)}',
      marker: 'a-map-static-two',
      subject:
        "const ITEMS = ['a-map-static-one', 'a-map-static-two']\nexport default function Subject() {\n  return (\n    <ul className=\"a-map-static-list\">\n      {ITEMS.map((item) => (\n        <li key={item}>{item}</li>\n      ))}\n    </ul>\n  )\n}\n",
      expected: 'inline',
      expectedRoute: 'broken',
      note: 'Bounded static data (nav links, feature lists) is unrolled at compile time — no runtime loop.',
    },
    {
      id: 'a-map-prop-list',
      title: '`.map` over a prop array (keyed)',
      excerpt: '{items.map((i) => <li key={i.id}>{i.label}</li>)}',
      marker: '{% for ',
      subject:
        'export default function Subject({ items }: { items: { id: string; label: string }[] }) {\n  return (\n    <ul className="a-map-prop-list">\n      {items.map((item) => (\n        <li key={item.id}>{item.label}</li>\n      ))}\n    </ul>\n  )\n}\n',
      callProps: 'items={items}',
      pageParams: '{ items }: { items: { id: string; label: string }[] }',
      expected: 'inline',
      note: 'Runtime-sized lists lower to a jinja `{% for %}` loop.',
    },
    {
      id: 'a-nested-elements',
      title: 'deeply nested elements',
      excerpt: '<section><div><ul><li>…',
      marker: 'class="a-nested-leaf"',
      subject:
        'export default function Subject() {\n  return (\n    <section className="a-nested-elements">\n      <div>\n        <ul>\n          <li className="a-nested-leaf">x</li>\n        </ul>\n      </div>\n    </section>\n  )\n}\n',
      expected: 'inline',
      note: 'Nesting depth is not a limit.',
    },
    {
      id: 'a-jsx-comment',
      title: 'JSX comment `{/* … */}`',
      excerpt: '{/* hidden */}',
      marker: 'class="a-jsx-comment"',
      subject:
        'export default function Subject() {\n  return (\n    <div>\n      {/* hidden-comment */}\n      <p className="a-jsx-comment">x</p>\n    </div>\n  )\n}\n',
      expected: 'inline',
      note: 'Comments are dropped, not emitted into the HTML.',
    },
    {
      id: 'a-falsy-children',
      title: 'null / undefined / false children dropped',
      excerpt: '{null}{undefined}{false}',
      marker: 'class="a-falsy-children"',
      subject:
        'export default function Subject() {\n  return (\n    <div>\n      {null}\n      {undefined}\n      {false}\n      <p className="a-falsy-children">x</p>\n    </div>\n  )\n}\n',
      expected: 'inline',
      expectedRoute: 'broken',
      note: 'React drops falsy children; the emitted markup must match.',
    },
    {
      id: 'a-void-elements',
      title: 'void elements (img / br / input)',
      excerpt: '<img src="/x.png" alt="" /><br />',
      marker: '<br/>',
      subject:
        'export default function Subject() {\n  return (\n    <div className="a-void-elements">\n      <img src="/x.png" alt="" />\n      <br />\n      <input type="text" name="q" />\n    </div>\n  )\n}\n',
      expected: 'inline',
      note: 'Self-closing elements emit valid void tags.',
    },
    {
      id: 'a-boolean-attributes',
      title: 'boolean attributes',
      excerpt: '<input disabled required />',
      marker: 'class="a-boolean-attributes"',
      subject:
        'export default function Subject() {\n  return <input className="a-boolean-attributes" type="text" disabled required />\n}\n',
      expected: 'inline',
      note: 'Bare boolean JSX attributes lower to HTML boolean attributes.',
    },
    {
      id: 'a-dangerously-set-inner-html',
      title: 'dangerouslySetInnerHTML',
      excerpt: 'dangerouslySetInnerHTML={{ __html: html }}',
      marker: 'class="a-dangerously-set-inner-html"',
      subject:
        'export default function Subject({ html }: { html: string }) {\n  return <div className="a-dangerously-set-inner-html" dangerouslySetInnerHTML={{ __html: html }} />\n}\n',
      callProps: 'html={html}',
      pageParams: '{ html }: { html: string }',
      expected: 'inline',
      note: 'The escape hatch for pre-rendered HTML (markdown bodies, CMS content) — must reach the template unescaped.',
    },
    {
      id: 'a-local-const',
      title: 'local `const` before `return`',
      excerpt: "const label = name + '!'; return <p>{label}</p>",
      marker: 'class="a-local-const"',
      subject:
        'export default function Subject({ name }: { name: string }) {\n  const label = name + \'!\'\n  return <p className="a-local-const">{label}</p>\n}\n',
      callProps: 'name={name}',
      pageParams: '{ name }: { name: string }',
      expected: 'inline',
      expectedRoute: 'broken',
      note: 'Deriving a value before returning JSX is the most ordinary thing in React.',
    },
  ],
}

const CATEGORY_B: Category = {
  key: 'B',
  title: 'Composition',
  blurb:
    'Splitting a page into components — what every real React codebase does. Same-file helpers and imported components are both inline candidates; the compiler walks the import graph through the CLI’s `gatherComponentSources`.',
  entries: [
    {
      id: 'b-same-file-helper',
      title: 'same-file helper with props',
      excerpt: 'function Badge({ label }) {…}   <Badge label="x" />',
      marker: 'class="b-same-file-helper"',
      subject:
        'function Badge({ label }: { label: string }) {\n  return <strong className="b-same-file-helper">{label}</strong>\n}\nexport default function Subject() {\n  return (\n    <div>\n      <Badge label="badge-label" />\n    </div>\n  )\n}\n',
      expected: 'inline',
      expectedRoute: 'broken',
      note: 'Private helpers are substituted at their call site — no SSR slot, no factory entry.',
    },
    {
      id: 'b-helper-children-element',
      title: 'helper with JSX element children',
      excerpt: '<Card><em/></Card>',
      marker: 'class="b-helper-children-element"',
      subject:
        'import type { ReactNode } from \'react\'\nfunction Card({ children }: { children: ReactNode }) {\n  return <article className="b-card">{children}</article>\n}\nexport default function Subject() {\n  return (\n    <div>\n      <Card>\n        <em className="b-helper-children-element">x</em>\n      </Card>\n    </div>\n  )\n}\n',
      expected: 'inline',
      expectedRoute: 'broken',
      note: 'Shipped in 0.1.69-alpha — `{children}` splices the caller’s JSX into the helper.',
    },
    {
      id: 'b-helper-children-fragment',
      title: 'helper with fragment children',
      excerpt: '<Card><><p/><p/></></Card>',
      marker: 'class="b-helper-children-fragment"',
      subject:
        'import type { ReactNode } from \'react\'\nfunction Card({ children }: { children: ReactNode }) {\n  return <article className="b-card">{children}</article>\n}\nexport default function Subject() {\n  return (\n    <div>\n      <Card>\n        <>\n          <p className="b-helper-children-fragment-a">one</p>\n          <p className="b-helper-children-fragment">two</p>\n        </>\n      </Card>\n    </div>\n  )\n}\n',
      expected: 'inline',
      expectedRoute: 'broken',
      note: 'Multi-root children must splice as a unit.',
    },
    {
      id: 'b-helper-children-nested-helper',
      title: 'helper children containing another helper call',
      excerpt: '<Card><Badge label="x" /></Card>',
      marker: 'class="b-helper-children-nested-helper"',
      subject:
        'import type { ReactNode } from \'react\'\nfunction Badge({ label }: { label: string }) {\n  return <strong className="b-helper-children-nested-helper">{label}</strong>\n}\nfunction Card({ children }: { children: ReactNode }) {\n  return <article className="b-card">{children}</article>\n}\nexport default function Subject() {\n  return (\n    <div>\n      <Card>\n        <Badge label="nested-label" />\n      </Card>\n    </div>\n  )\n}\n',
      expected: 'inline',
      expectedRoute: 'broken',
      note: 'The children splice must recurse into further inline candidates.',
    },
    {
      id: 'b-imported-component',
      title: 'imported component with the `native` attribute',
      excerpt: 'import Badge from \'./Badge\'   <Badge native label="x" />',
      marker: 'class="b-imported-component"',
      extraFiles: {
        'Badge.tsx':
          'export default function Badge({ label }: { label: string }) {\n  return <strong className="b-imported-component">{label}</strong>\n}\n',
      },
      subject:
        'import Badge from \'./Badge\'\nexport default function Subject() {\n  return (\n    <div>\n      <Badge native label="badge-label" />\n    </div>\n  )\n}\n',
      expected: 'inline',
      note: 'The import graph is walked transitively; imported components inline like local helpers.',
    },
    {
      id: 'b-imported-component-implicit',
      title: 'imported component WITHOUT the `native` attribute',
      excerpt: '<Badge label="x" />',
      marker: 'class="b-imported-component-implicit"',
      extraFiles: {
        'Badge.tsx':
          'export default function Badge({ label }: { label: string }) {\n  return <strong className="b-imported-component-implicit">{label}</strong>\n}\n',
      },
      subject:
        'import Badge from \'./Badge\'\nexport default function Subject() {\n  return (\n    <div>\n      <Badge label="badge-label" />\n    </div>\n  )\n}\n',
      expected: 'inline',
      note: 'Inlining is attempted implicitly — `native` only selects the explicit mode (cycle + ISR semantics), it is not required to inline.',
    },
    {
      id: 'b-arrow-component',
      title: 'arrow-function component',
      excerpt: 'const Subject = ({ label }) => <span/>; export default Subject',
      marker: 'class="b-arrow-component"',
      subject:
        'const Subject = ({ label }: { label: string }) => <span className="b-arrow-component">{label}</span>\nexport default Subject\n',
      callProps: 'label={label}',
      pageParams: '{ label }: { label: string }',
      expected: 'gap',
      expectedRoute: 'broken',
      note: 'Arrow components are half of all React code in the wild. The inliner only recognises `export default function Name(…)`, so every arrow component falls back to React SSR — and the warning says “parse error”, which is misleading: the file parses fine.',
    },
    {
      id: 'b-declaration-then-default-export',
      title: 'function declared, then default-exported separately',
      excerpt: 'function Subject() {…}   export default Subject',
      marker: 'class="b-declaration-then-default-export"',
      subject:
        'function Subject({ label }: { label: string }) {\n  return <span className="b-declaration-then-default-export">{label}</span>\n}\nexport default Subject\n',
      callProps: 'label={label}',
      pageParams: '{ label }: { label: string }',
      expected: 'gap',
      expectedRoute: 'broken',
      note: 'The same function, exported on its own line instead of inline, stops inlining. Nothing about the component changed — only where the `export default` keyword sits.',
    },
    {
      id: 'b-named-export-component',
      title: 'named export (`export function Subject`)',
      excerpt: "export function Subject() {…}   import { Subject } from './Subject'",
      marker: 'class="b-named-export-component"',
      importForm: 'named',
      subject:
        'export function Subject({ label }: { label: string }) {\n  return <span className="b-named-export-component">{label}</span>\n}\n',
      callProps: 'label={label}',
      pageParams: '{ label }: { label: string }',
      expected: 'gap',
      expectedRoute: 'broken',
      note: 'A file exporting several components by name (the usual shape for a UI kit) cannot inline any of them — only the default export is looked at.',
    },
    {
      id: 'b-same-file-arrow-helper',
      title: 'same-file ARROW helper',
      excerpt: 'const Badge = ({ label }) => <strong/>',
      marker: 'class="b-same-file-arrow-helper"',
      subject:
        'const Badge = ({ label }: { label: string }) => (\n  <strong className="b-same-file-arrow-helper">{label}</strong>\n)\nexport default function Subject() {\n  return (\n    <div>\n      <Badge label="badge-label" />\n    </div>\n  )\n}\n',
      expected: 'gap',
      expectedRoute: 'broken',
      note: 'The `function` form of the identical helper inlines (see b-same-file-helper); the arrow form is not found at all.',
    },
    {
      id: 'b-component-as-prop',
      title: 'component passed as a prop (`icon={Star}` → `<Icon/>`)',
      excerpt: '<Row icon={Star} />   →   <Icon />',
      marker: 'class="b-component-as-prop"',
      subject:
        'function Star() {\n  return <svg className="b-component-as-prop" viewBox="0 0 24 24" />\n}\nfunction Row({ icon: Icon, label }: { icon: () => JSX.Element; label: string }) {\n  return (\n    <p className="b-row">\n      <Icon />\n      {label}\n    </p>\n  )\n}\nexport default function Subject() {\n  return (\n    <div>\n      <Row icon={Star} label="row-label" />\n    </div>\n  )\n}\n',
      expected: 'gap',
      expectedRoute: 'broken',
      note: 'The render-prop idiom every icon set uses. `lucide-react` icons are special-cased by the compiler, but the general form — a component handed through a prop and rendered as `<Icon/>` — is not resolved, so any component that takes an `icon` prop falls back.',
    },
    {
      id: 'b-jsx-valued-prop',
      title: 'JSX-valued prop (`content={<p/>}`)',
      excerpt: '<Slot content={<p/>} />',
      marker: 'class="b-jsx-valued-prop"',
      subject:
        'import type { ReactNode } from \'react\'\nfunction Slot({ content }: { content: ReactNode }) {\n  return <div className="b-slot">{content}</div>\n}\nexport default function Subject() {\n  return (\n    <div>\n      <Slot content={<p className="b-jsx-valued-prop">x</p>} />\n    </div>\n  )\n}\n',
      expected: 'inline',
      expectedRoute: 'broken',
      note: 'Passing elements through named props (not `children`) is the standard slot/layout idiom.',
    },
    {
      id: 'b-spread-props',
      title: 'spread props (`{...badge}`)',
      excerpt: '<Badge {...badge} />',
      marker: 'class="b-spread-props"',
      subject:
        'function Badge({ label, tone }: { label: string; tone: string }) {\n  return (\n    <strong className="b-spread-props" data-tone={tone}>\n      {label}\n    </strong>\n  )\n}\nexport default function Subject({ badge }: { badge: { label: string; tone: string } }) {\n  return (\n    <div>\n      <Badge {...badge} />\n    </div>\n  )\n}\n',
      callProps: 'badge={badge}',
      pageParams: '{ badge }: { badge: { label: string; tone: string } }',
      expected: 'gap',
      expectedRoute: 'broken',
      note: 'Forwarding a prop bag is everyday React (and unavoidable when wrapping a component). Today any spread at a helper call site drops the whole component to React SSR.',
    },
    {
      id: 'b-destructure-default',
      title: 'destructured prop default (`{ tone = "muted" }`)',
      excerpt: 'function Badge({ tone = "muted" })',
      marker: 'muted',
      subject:
        'function Badge({ tone = \'muted\' }: { tone?: string }) {\n  return <strong className="b-destructure-default" data-tone={tone} />\n}\nexport default function Subject() {\n  return (\n    <div>\n      <Badge />\n    </div>\n  )\n}\n',
      expected: 'inline',
      expectedRoute: 'broken',
      note: 'Default parameter values are resolved at inline time.',
    },
    {
      id: 'b-children-default-value',
      title: 'children with a DEFAULT value',
      excerpt: 'function Card({ children = <span/> })',
      marker: 'class="b-children-default-value"',
      subject:
        'import type { ReactNode } from \'react\'\nfunction Card({ children = <span className="b-children-default-value">none</span> }: { children?: ReactNode }) {\n  return <article className="b-card">{children}</article>\n}\nexport default function Subject() {\n  return (\n    <div>\n      <Card />\n    </div>\n  )\n}\n',
      expected: 'gap',
      expectedRoute: 'broken',
      note: 'A defaulted `children` param is ordinary React, but the inliner cannot express “caller children, else this fallback”, so the component drops to React SSR.',
    },
    {
      id: 'b-props-children-non-destructured',
      title: '`props.children` (not destructured)',
      excerpt: 'function Card(props) { return <div>{props.children}</div> }',
      marker: 'class="b-props-children-non-destructured"',
      subject:
        'import type { ReactNode } from \'react\'\nfunction Card(props: { children?: ReactNode }) {\n  return <article className="b-card">{props.children}</article>\n}\nexport default function Subject() {\n  return (\n    <div>\n      <Card>\n        <em className="b-props-children-non-destructured">x</em>\n      </Card>\n    </div>\n  )\n}\n',
      expected: 'gap',
      expectedRoute: 'broken',
      note: 'The non-destructured prop style is idiomatic React and common in published components; only destructured params are recognised today.',
    },
    {
      id: 'b-layout-chain',
      title: 'layout + leaf route chain',
      excerpt: '<Layout native><Leaf native/></Layout>',
      marker: 'class="b-layout-leaf"',
      componentPosition: false,
      extraFiles: {
        'Layout.tsx':
          'import type { ReactNode } from \'react\'\nexport default function Layout({ children }: { children?: ReactNode }) {\n  return (\n    <main className="b-layout">\n      <h1>chrome</h1>\n      {children}\n    </main>\n  )\n}\n',
        'Leaf.tsx':
          'export default function Leaf() {\n  return <p className="b-layout-leaf">leaf</p>\n}\n',
      },
      subject:
        "import Layout from './Layout'\nimport Leaf from './Leaf'\nexport default function Leaf__chain() { return <Layout native><Leaf native/></Layout>; }\n",
      expected: 'inline',
      note: 'Nested routes compile to ONE template through the CLI’s synthesized chain wrapper (`buildChainWrapperSource`); this row reproduces that wrapper byte-for-byte.',
    },
  ],
}

/** Hook rows share one shape: a component that calls the hook. */
function hookEntry(
  id: string,
  title: string,
  excerpt: string,
  imports: string,
  body: string,
  note: string,
): Entry {
  return {
    id,
    title,
    excerpt,
    marker: `class="${id}"`,
    subject: `${imports}\nexport default function Subject({ label }: { label: string }) {\n${body}\n}\n`,
    callProps: 'label={label}',
    pageParams: '{ label }: { label: string }',
    expected: 'fallback-by-design',
    expectedRoute: 'broken',
    note,
  }
}

const CATEGORY_C: Category = {
  key: 'C',
  title: 'Hooks',
  blurb:
    'Hooks imply a React runtime and client state. On a native route the component falls back to React SSR — markup renders, nothing hydrates. The brust answer is an `<Island>` (full React) or `export const behavior` (zero-React directives). These fallbacks are the model working as intended, not gaps.',
  entries: [
    hookEntry(
      'c-usestate',
      'useState',
      'const [n] = useState(0)',
      "import { useState } from 'react'",
      '  const [n] = useState(0)\n  return (\n    <span className="c-usestate">\n      {label}\n      {n}\n    </span>\n  )',
      'Client state — belongs in an Island or a `behavior` directive.',
    ),
    hookEntry(
      'c-useeffect',
      'useEffect',
      'useEffect(() => {}, [])',
      "import { useEffect } from 'react'",
      '  useEffect(() => {}, [])\n  return <span className="c-useeffect">{label}</span>',
      'Effects run only in a browser; a native route ships no React to run them.',
    ),
    hookEntry(
      'c-usememo',
      'useMemo',
      'const v = useMemo(() => label.toUpperCase(), [label])',
      "import { useMemo } from 'react'",
      '  const v = useMemo(() => label.toUpperCase(), [label])\n  return <span className="c-usememo">{v}</span>',
      'Memoisation has no meaning in a static template — though the derived value itself is often statically computable.',
    ),
    hookEntry(
      'c-usecallback',
      'useCallback',
      'const onClick = useCallback(() => {}, [])',
      "import { useCallback } from 'react'",
      '  const onClick = useCallback(() => {}, [])\n  return (\n    <span className="c-usecallback" onClick={onClick}>\n      {label}\n    </span>\n  )',
      'Event handlers are client behaviour — Island or `behavior`.',
    ),
    hookEntry(
      'c-useref',
      'useRef',
      'const ref = useRef(null)',
      "import { useRef } from 'react'",
      '  const ref = useRef<HTMLSpanElement>(null)\n  return (\n    <span className="c-useref" ref={ref}>\n      {label}\n    </span>\n  )',
      'A ref is a handle to a live DOM node owned by React.',
    ),
    hookEntry(
      'c-usecontext',
      'useContext',
      'const tone = useContext(ToneContext)',
      "import { createContext, useContext } from 'react'\nconst ToneContext = createContext('muted')",
      '  const tone = useContext(ToneContext)\n  return (\n    <span className="c-usecontext">\n      {tone}\n      {label}\n    </span>\n  )',
      'Context is resolved by the React renderer; a static template has no provider tree.',
    ),
    hookEntry(
      'c-custom-hook',
      'custom hook',
      'const tone = useTone()',
      "function useTone() {\n  return 'muted'\n}",
      '  const tone = useTone()\n  return (\n    <span className="c-custom-hook">\n      {tone}\n      {label}\n    </span>\n  )',
      'Detected by the `use*` naming convention — even a pure custom hook (no React hook inside) falls back.',
    ),
  ],
}

const CATEGORY_D: Category = {
  key: 'D',
  title: 'React API surface',
  blurb:
    'The wrappers and helpers a real component library reaches for. A construct whose *markup* is static is a fair inline candidate even when the React feature it wraps (memoisation, refs, laziness) has no native meaning.',
  entries: [
    {
      id: 'd-memo',
      title: 'memo(Component)',
      excerpt: 'export default memo(function Subject() {…})',
      marker: 'class="d-memo"',
      subject:
        'import { memo } from \'react\'\nexport default memo(function Subject({ label }: { label: string }) {\n  return <span className="d-memo">{label}</span>\n})\n',
      callProps: 'label={label}',
      pageParams: '{ label }: { label: string }',
      expected: 'gap',
      expectedRoute: 'broken',
      note: '`memo` is a pure render wrapper around ordinary static JSX — it could be unwrapped and inlined. Today every memoised component in a design system falls back to React SSR.',
    },
    {
      id: 'd-forwardref',
      title: 'forwardRef (React 18 idiom)',
      excerpt: 'export default forwardRef(function Subject(props, ref) {…})',
      marker: 'class="d-forwardref"',
      subject:
        'import { forwardRef } from \'react\'\nexport default forwardRef<HTMLSpanElement, { label: string }>(function Subject({ label }, ref) {\n  return (\n    <span className="d-forwardref" ref={ref}>\n      {label}\n    </span>\n  )\n})\n',
      callProps: 'label={label}',
      pageParams: '{ label }: { label: string }',
      expected: 'gap',
      expectedRoute: 'broken',
      note: 'The ref is client-only, but the markup is static: a forwardRef component whose ref is unused on a native route could inline with the ref dropped. Nearly every third-party component library ships forwardRef wrappers.',
    },
    {
      id: 'd-ref-as-prop',
      title: 'ref as a plain prop (React 19 idiom)',
      excerpt: 'function Subject({ ref, label })',
      marker: 'class="d-ref-as-prop"',
      subject:
        'export default function Subject({ label }: { label: string; ref?: unknown }) {\n  return <span className="d-ref-as-prop">{label}</span>\n}\n',
      callProps: 'label={label}',
      pageParams: '{ label }: { label: string }',
      expected: 'inline',
      note: 'React 19 dropped `forwardRef` in favour of a plain `ref` prop — a component that merely accepts one must not be penalised.',
    },
    {
      id: 'd-lazy-suspense',
      title: 'lazy() + `<Suspense>`',
      excerpt: '<Suspense fallback={…}><Lazy/></Suspense>',
      marker: 'class="d-lazy-suspense"',
      extraFiles: {
        'Widget.tsx':
          'export default function Widget() {\n  return <span className="d-lazy-suspense">x</span>\n}\n',
      },
      subject:
        "import { lazy, Suspense } from 'react'\nconst Lazy = lazy(() => import('./Widget'))\nexport default function Subject() {\n  return (\n    <div>\n      <Suspense fallback={<p>loading</p>}>\n        <Lazy />\n      </Suspense>\n    </div>\n  )\n}\n",
      expected: 'fallback-by-design',
      expectedRoute: 'broken',
      note: 'Code-splitting and streaming boundaries are React-runtime features; a native template is fully materialised at compile time.',
    },
    {
      id: 'd-context-provider',
      title: 'createContext + Provider',
      excerpt: '<ToneContext.Provider value="loud">…',
      marker: 'class="d-context-provider"',
      extraFiles: {
        'Widget.tsx':
          'export default function Widget() {\n  return <span className="d-context-provider">x</span>\n}\n',
      },
      subject:
        "import { createContext } from 'react'\nimport Widget from './Widget'\nconst ToneContext = createContext('muted')\nexport default function Subject() {\n  return (\n    <div>\n      <ToneContext.Provider value=\"loud\">\n        <Widget />\n      </ToneContext.Provider>\n    </div>\n  )\n}\n",
      expected: 'fallback-by-design',
      expectedRoute: 'broken',
      note: 'Provider/consumer resolution is a React render-tree mechanism. Static configuration on a native page travels as props or module consts instead.',
    },
    {
      id: 'd-use-context',
      title: 'use(Context) (React 19)',
      excerpt: 'const tone = use(ToneContext)',
      marker: 'class="d-use-context"',
      subject:
        "import { createContext, use } from 'react'\nconst ToneContext = createContext('muted')\nexport default function Subject({ label }: { label: string }) {\n  const tone = use(ToneContext)\n  return (\n    <span className=\"d-use-context\">\n      {tone}\n      {label}\n    </span>\n  )\n}\n",
      callProps: 'label={label}',
      pageParams: '{ label }: { label: string }',
      expected: 'fallback-by-design',
      expectedRoute: 'broken',
      note: '`use()` reads from the React runtime (context or a promise) — same reasoning as `useContext`.',
    },
    {
      id: 'd-cloneelement',
      title: 'cloneElement',
      excerpt: "cloneElement(child, { 'data-cloned': 'yes' })",
      marker: 'class="d-cloneelement"',
      subject:
        "import { cloneElement, type ReactElement } from 'react'\nfunction Wrapper({ child }: { child: ReactElement }) {\n  return <div className=\"d-wrapper\">{cloneElement(child, { 'data-cloned': 'yes' })}</div>\n}\nexport default function Subject() {\n  return (\n    <div>\n      <Wrapper child={<em className=\"d-cloneelement\">x</em>} />\n    </div>\n  )\n}\n",
      expected: 'gap',
      expectedRoute: 'broken',
      note: 'Cloning a literal element with literal props is statically resolvable, and it is how wrappers inject props into their children today.',
    },
    {
      id: 'd-children-map',
      title: 'Children.map',
      excerpt: 'Children.map(children, (c) => <li>{c}</li>)',
      marker: 'class="d-children-map"',
      subject:
        'import { Children, type ReactNode } from \'react\'\nfunction List({ children }: { children?: ReactNode }) {\n  return (\n    <ul className="d-list">\n      {Children.map(children, (child) => (\n        <li>{child}</li>\n      ))}\n    </ul>\n  )\n}\nexport default function Subject() {\n  return (\n    <div>\n      <List>\n        <em className="d-children-map">one</em>\n        <em>two</em>\n      </List>\n    </div>\n  )\n}\n',
      expected: 'gap',
      expectedRoute: 'broken',
      note: 'With children spliced at compile time the child list is known, so a literal `Children.map` could be unrolled exactly like `.map` over a static array.',
    },
  ],
}

const CATEGORY_E: Category = {
  key: 'E',
  title: 'React 19 specifics',
  blurb:
    'Features that only exist in React 19. Some are pure markup (document metadata); the rest are client/server-runtime features a zero-JS template cannot express.',
  entries: [
    {
      id: 'e-document-metadata',
      title: 'document metadata hoisting (`<title>` / `<meta>` inside a component)',
      excerpt: '<title>Docs</title><meta name="description" …/>',
      marker: '<title>',
      subject:
        'export default function Subject() {\n  return (\n    <div className="e-document-metadata">\n      <title>Docs</title>\n      <meta name="description" content="d" />\n      <p>x</p>\n    </div>\n  )\n}\n',
      expected: 'gap',
      semanticGap: 'the tags stay where they were written instead of being hoisted into `<head>`',
      note: 'React 19 hoists `<title>`/`<meta>`/`<link>` rendered anywhere in the tree into `<head>`. The native pipeline emits them in place, so the idiom silently produces metadata in the wrong position; brust’s own answer is the page `head` prop.',
    },
    {
      id: 'e-ref-cleanup',
      title: 'ref callback returning a cleanup fn',
      excerpt: 'ref={(el) => { …; return () => {} }}',
      marker: 'class="e-ref-cleanup"',
      subject:
        "export default function Subject({ label }: { label: string }) {\n  return (\n    <span\n      className=\"e-ref-cleanup\"\n      ref={(el) => {\n        el?.setAttribute('data-live', '1')\n        return () => {}\n      }}\n    >\n      {label}\n    </span>\n  )\n}\n",
      callProps: 'label={label}',
      pageParams: '{ label }: { label: string }',
      expected: 'fallback-by-design',
      expectedRoute: 'broken',
      note: 'A ref callback runs in the browser against a live node — client-only by construction; `behavior` is the zero-React equivalent.',
    },
    {
      id: 'e-use-action-state',
      title: 'useActionState',
      excerpt: 'const [state, action] = useActionState(fn, "")',
      marker: 'class="e-use-action-state"',
      subject:
        "import { useActionState } from 'react'\nexport default function Subject({ label }: { label: string }) {\n  const [state, action] = useActionState(async () => label, '')\n  return (\n    <form className=\"e-use-action-state\" action={action}>\n      {state}\n    </form>\n  )\n}\n",
      callProps: 'label={label}',
      pageParams: '{ label }: { label: string }',
      expected: 'fallback-by-design',
      expectedRoute: 'broken',
      note: 'React 19 form actions need the React runtime for the pending/optimistic transition; native routes use brust’s own `defineActions` + a plain form post.',
    },
    {
      id: 'e-use-optimistic',
      title: 'useOptimistic',
      excerpt: 'const [shown] = useOptimistic(label)',
      marker: 'class="e-use-optimistic"',
      subject:
        'import { useOptimistic } from \'react\'\nexport default function Subject({ label }: { label: string }) {\n  const [shown] = useOptimistic(label)\n  return <span className="e-use-optimistic">{shown}</span>\n}\n',
      callProps: 'label={label}',
      pageParams: '{ label }: { label: string }',
      expected: 'fallback-by-design',
      expectedRoute: 'broken',
      note: 'Optimistic UI is client state by definition.',
    },
    {
      id: 'e-form-action-fn',
      title: 'form `action={fn}` (server-action idiom)',
      excerpt: '<form action={submit}>',
      marker: 'class="e-form-action-fn"',
      subject:
        'export default function Subject({ submit }: { submit: () => void }) {\n  return (\n    <form className="e-form-action-fn" action={submit}>\n      <button type="submit">go</button>\n    </form>\n  )\n}\n',
      callProps: 'submit={submit}',
      pageParams: '{ submit }: { submit: () => void }',
      expected: 'gap',
      semanticGap:
        'the function is interpolated INTO the attribute (`action="{{ (submit) | e }}"`) with no warning, so the form posts to a stringified function instead of being bound',
      note: 'A function-valued `action` is bound by React on the client; the native equivalent is `action="/path"` posting to a brust action route. Emitting it as an attribute value silently produces a broken form — this one deserves a compiler diagnostic even if it is never inlinable.',
    },
    {
      id: 'e-use-promise',
      title: 'use(promise)',
      excerpt: 'const data = use(pending)',
      marker: 'class="e-use-promise"',
      subject:
        'import { use } from \'react\'\nexport default function Subject({ pending }: { pending: Promise<string> }) {\n  const data = use(pending)\n  return <span className="e-use-promise">{data}</span>\n}\n',
      callProps: 'pending={pending}',
      pageParams: '{ pending }: { pending: Promise<string> }',
      expected: 'fallback-by-design',
      expectedRoute: 'broken',
      note: 'Suspense-driven async reads need a streaming React renderer; a native route awaits in its loader instead.',
    },
  ],
}

const BATTERY: Category[] = [CATEGORY_A, CATEGORY_B, CATEGORY_C, CATEGORY_D, CATEGORY_E]

// ---------------------------------------------------------------------------
// Compile + classify
// ---------------------------------------------------------------------------

export interface CompileOutcome {
  observed: Observed
  /** Raw compiler reason (fallback) or error message (error) — temp paths scrubbed. */
  reason: string
}

type CompileJsxFn = (
  source: string,
  path: string,
  componentSources?: Record<string, string>,
  lucideIcons?: Record<string, string>,
  directiveNames?: Record<string, string>,
) => {
  template: string
  islandsJson: string
  componentsJson: string
  warnings?: string[]
}

/** Everything the report prints must be independent of the temp dir name. */
function scrub(text: string, dir: string): string {
  return text.split(`${dir}/`).join('').split(dir).join('').replace(/\r/g, '')
}

/** The files handed to the compiler for one position. `Page.tsx` is the route. */
export function filesFor(entry: Entry, position: Position): Record<string, string> {
  if (position === 'route') {
    return { ...(entry.extraFiles ?? {}), 'Page.tsx': entry.subject }
  }
  const page =
    (entry.importForm === 'named'
      ? "import { Subject } from './Subject'\n"
      : "import Subject from './Subject'\n") +
    `export default function Page(${entry.pageParams ?? ''}) {\n` +
    '  return (\n    <main>\n' +
    `      <Subject ${entry.callProps ? `${entry.callProps} ` : ''}/>\n` +
    '    </main>\n  )\n}\n'
  return { ...(entry.extraFiles ?? {}), 'Subject.tsx': entry.subject, 'Page.tsx': page }
}

export function runEntry(
  entry: Entry,
  position: Position,
  compileJsx: CompileJsxFn,
  root: string,
): CompileOutcome {
  const dir = mkdtempSync(join(root, 'rc-'))
  try {
    const files = filesFor(entry, position)
    for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source)
    const pagePath = join(dir, 'Page.tsx')
    const { sources } = gatherComponentSources(pagePath)
    const compiled = compileJsx(files['Page.tsx']!, pagePath, sources, {}, {})
    const fallbacks = (compiled.warnings ?? [])
      .map((w) => NOT_INLINED.exec(w))
      .filter((m): m is RegExpExecArray => m !== null)
    if (fallbacks.length > 0) {
      return {
        observed: 'fallback',
        reason: fallbacks.map((m) => `\`${m[1]}\`: ${m[2]}`).join('; '),
      }
    }
    if (!compiled.template.includes(entry.marker)) {
      return {
        observed: 'no-marker',
        reason: `compiled without a warning, but the template does not contain \`${entry.marker}\` — the construct was dropped or emitted differently`,
      }
    }
    return {
      observed: 'inlined',
      reason: (compiled.warnings ?? []).map((w) => scrub(w, dir)).join('; '),
    }
  } catch (e) {
    return { observed: 'error', reason: scrub(e instanceof Error ? e.message : String(e), dir) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export type Status = 'INLINE' | 'FALLBACK-BY-DESIGN' | 'GAP'

export interface Row {
  entry: Entry
  category: string
  /** Component position — the authoring position the pipeline is built around. */
  component: CompileOutcome | null
  /** Same construct written directly in the route file. */
  route: CompileOutcome | null
  status: Status
  /** The run disagrees with the expectation recorded in the battery. */
  mismatch: boolean
  routeMismatch: boolean
}

export function classify(
  entry: Entry,
  component: CompileOutcome | null,
  route: CompileOutcome | null,
): { status: Status; mismatch: boolean; routeMismatch: boolean } {
  // A route-only row (the chain wrapper) is judged on its route run.
  const primary = component ?? route
  let status: Status
  if (primary !== null && primary.observed === 'inlined') {
    // A construct can compile and still not MEAN what React means (metadata
    // hoisting) — that is a coverage gap even though nothing fell back.
    status = entry.semanticGap ? 'GAP' : 'INLINE'
  } else if (entry.expected === 'fallback-by-design') {
    status = 'FALLBACK-BY-DESIGN'
  } else {
    status = 'GAP'
  }
  const expectedStatus: Status =
    entry.expected === 'inline' ? 'INLINE' : entry.expected === 'gap' ? 'GAP' : 'FALLBACK-BY-DESIGN'
  const routeOk = route === null || route.observed === 'inlined'
  const routeMismatch = route !== null && routeOk !== ((entry.expectedRoute ?? 'ok') === 'ok')
  return { status, mismatch: status !== expectedStatus, routeMismatch }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const OBSERVED_LABEL: Record<Observed, string> = {
  inlined: 'inlined',
  fallback: 'React SSR fallback',
  error: 'compile error',
  'no-marker': 'compiled, marker missing',
}

/** Markdown table cells cannot hold a raw `|` or a newline. */
function cell(text: string): string {
  return text
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
}

function code(text: string): string {
  const flat = cell(text)
  if (!flat.includes('`')) return `\`${flat}\``
  // A backtick inside the excerpt (template literals) cannot survive a fenced
  // span — emit an HTML code element and escape what Markdown would eat.
  return `<code>${flat.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`
}

/** The route column: does the SAME code work written directly in the page? */
function routeCell(row: Row): string {
  if (row.route === null) return 'n/a'
  const flag = row.routeMismatch ? ' ⚠' : ''
  if (row.route.observed === 'inlined') return `✅ inlines${flag}`
  if (row.route.observed === 'error') return `❌ build error${flag}`
  if (row.route.observed === 'fallback') return `➖ falls back${flag}`
  return `❌ dropped${flag}`
}

export function renderReport(rows: Row[], version: string): string {
  const out: string[] = []
  const count = (status: Status, cat?: string) =>
    rows.filter((r) => r.status === status && (cat === undefined || r.category === cat)).length
  const routeBreaks = (cat?: string) =>
    rows.filter(
      (r) =>
        (cat === undefined || r.category === cat) &&
        r.route !== null &&
        r.route.observed !== 'inlined' &&
        r.status !== 'FALLBACK-BY-DESIGN',
    ).length

  out.push('# React authoring coverage — native pages')
  out.push('')
  out.push(
    'How much of ordinary React authoring the **native pipeline** (`native: true` routes) supports today, measured by compiling a battery of React 18/19 constructs through the real compiler.',
  )
  out.push('')
  out.push(
    `Generated by \`bun scripts/react-coverage.ts\` at brustjs \`${version}\`. Do not edit by hand — change the battery in the script and re-run.`,
  )
  out.push('')

  out.push('## Summary')
  out.push('')
  out.push('| Category | INLINE | FALLBACK-BY-DESIGN | GAP | Total | Breaks in a route file |')
  out.push('| --- | ---: | ---: | ---: | ---: | ---: |')
  for (const category of BATTERY) {
    const inCat = rows.filter((r) => r.category === category.key).length
    out.push(
      `| ${category.key}. ${category.title} | ${count('INLINE', category.key)} | ${count('FALLBACK-BY-DESIGN', category.key)} | ${count('GAP', category.key)} | ${inCat} | ${routeBreaks(category.key)} |`,
    )
  }
  out.push(
    `| **Total** | **${count('INLINE')}** | **${count('FALLBACK-BY-DESIGN')}** | **${count('GAP')}** | **${rows.length}** | **${routeBreaks()}** |`,
  )
  out.push('')

  const mismatches = rows.filter((r) => r.mismatch || r.routeMismatch)
  if (mismatches.length > 0) {
    out.push(
      `> ⚠ ${mismatches.length} row(s) disagree with the expectation recorded in the battery: ${mismatches
        .map((r) => `\`${r.entry.id}\``)
        .join(
          ', ',
        )}. Either the compiler regressed, or a gap closed and the battery needs updating.`,
    )
    out.push('')
  }

  out.push('## Method')
  out.push('')
  out.push(
    'Every row is a self-contained snippet compiled through `compileJsx` — the same napi entry point `runtime/cli/native-routes-emit.ts` uses for every native route — with component sources gathered by the CLI’s own `gatherComponentSources` import walk. Nothing is re-implemented or simulated.',
  )
  out.push('')
  out.push(
    'Each construct is compiled in **two positions**, because they are not the same language:',
  )
  out.push('')
  out.push(
    '1. **component file** — the construct is the default export of `Subject.tsx`, mounted by a trivial route (`<Subject/>`). This is the position the inliner is built around, and it is what the Status column measures.',
  )
  out.push(
    '2. **route file** — the exact same code written directly in the page component. The route function is lowered by a different path than an inlined component: its body must be a single `return <jsx>;`, and its module-level consts and same-file helpers are not resolved. The “Breaks in a route file” column reports that difference.',
  )
  out.push('')
  out.push('Status is read off the actual run:')
  out.push('')
  out.push(
    '- **INLINE** — no fallback warning and the row’s marker string is present in the emitted jinja. The construct becomes plain HTML: no React, no JS.',
  )
  out.push(
    '- **FALLBACK-BY-DESIGN** — the compiler declined to inline and that is the intended brust model. The component still renders (React SSR into a `comp_N` slot); it just does not hydrate. Interactivity is an `<Island>` or `export const behavior`.',
  )
  out.push(
    '- **GAP** — the construct does not inline (or inlines with different semantics) even though a static lowering is plausible. Every GAP is listed in the backlog at the bottom.',
  )
  out.push('')
  out.push(
    'The “Observed” column reports what actually happened in the component position (`inlined`, `React SSR fallback`, `compile error`, `compiled, marker missing`), so a status never hides a surprise. `⚠` marks a result that disagrees with the expectation recorded in the battery.',
  )
  out.push('')

  for (const category of BATTERY) {
    const catRows = rows.filter((r) => r.category === category.key)
    out.push(`## ${category.key}. ${category.title}`)
    out.push('')
    out.push(category.blurb)
    out.push('')
    out.push(
      '| Pattern | Authoring | Status | Observed | In a route file | Compiler reason / note |',
    )
    out.push('| --- | --- | --- | --- | --- | --- |')
    for (const row of catRows) {
      const primary = row.component ?? row.route
      const observed = primary
        ? `${OBSERVED_LABEL[primary.observed]}${row.mismatch ? ' ⚠' : ''}`
        : 'n/a'
      const detail =
        primary === null
          ? row.entry.note
          : primary.observed === 'inlined'
            ? row.entry.semanticGap
              ? `${row.entry.semanticGap} — ${row.entry.note}`
              : row.entry.note
            : `${primary.reason} — ${row.entry.note}`
      out.push(
        `| <a id="${row.entry.id}"></a>${cell(row.entry.title)} | ${code(row.entry.excerpt)} | ${row.status} | ${observed} | ${routeCell(row)} | ${cell(detail)} |`,
      )
    }
    out.push('')
  }

  out.push('## Gaps (backlog)')
  out.push('')
  const gaps = rows.filter((r) => r.status === 'GAP')
  if (gaps.length === 0) {
    out.push('None — every battery row either inlines or falls back by design.')
  } else {
    out.push(
      `${gaps.length} construct(s) that ordinary React authors write and the native pipeline does not support statically today.`,
    )
    out.push('')
    for (const row of gaps) {
      const primary = row.component ?? row.route
      const why =
        primary === null
          ? 'not measured'
          : primary.observed === 'inlined'
            ? `inlines, but ${row.entry.semanticGap}`
            : `${OBSERVED_LABEL[primary.observed]} — ${primary.reason}`
      out.push(
        `- **[${row.entry.id}](#${row.entry.id})** — ${cell(row.entry.title)} (${row.category})`,
      )
      out.push(`  - observed: ${cell(why)}`)
      out.push(`  - why it matters: ${cell(row.entry.note)}`)
    }
  }
  out.push('')

  const routeOnly = rows.filter(
    (r) =>
      r.status !== 'FALLBACK-BY-DESIGN' &&
      r.route !== null &&
      r.route.observed !== 'inlined' &&
      (r.component === null || r.component.observed === 'inlined'),
  )
  out.push('### Route-file-only gaps')
  out.push('')
  if (routeOnly.length === 0) {
    out.push('None — every construct that inlines from a component also works written in the page.')
  } else {
    out.push(
      `${routeOnly.length} construct(s) that inline perfectly from a component file but fail when written directly in the route component. This asymmetry is one gap class, not ${routeOnly.length}: the route function is lowered without the module-level const table, the same-file helper table, and the multi-statement body the inline path already supports. Closing it is the single highest-leverage item in this report — until then “move it into its own component” is the workaround for all of them.`,
    )
    out.push('')
    for (const row of routeOnly) {
      out.push(
        `- **[${row.entry.id}](#${row.entry.id})** — ${cell(row.entry.title)}: ${cell(row.route?.reason ?? '')}`,
      )
    }
  }
  out.push('')
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  let compileJsx: CompileJsxFn
  try {
    const native = (await import('../runtime/index.js')) as unknown as { compileJsx?: CompileJsxFn }
    if (typeof native.compileJsx !== 'function') throw new Error('compileJsx is not exported')
    compileJsx = native.compileJsx
  } catch (e) {
    // No addon = no report at all. Exiting 0 here would publish silence as
    // success; every OTHER failure mode (a snippet that errors, a gap) is data
    // the report is supposed to carry and exits 0.
    process.stderr.write(
      `react-coverage: cannot load the native addon (${e instanceof Error ? e.message : String(e)}).\n` +
        'Build it first: cd runtime && bun run build:debug\n',
    )
    process.exit(1)
  }

  const version = (
    JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
  ).version

  const root = mkdtempSync(join(tmpdir(), 'react-coverage-'))
  const rows: Row[] = []
  try {
    for (const category of BATTERY) {
      for (const entry of category.entries) {
        const component =
          entry.componentPosition === false ? null : runEntry(entry, 'component', compileJsx, root)
        const route =
          entry.routePosition === false ? null : runEntry(entry, 'route', compileJsx, root)
        rows.push({
          entry,
          category: category.key,
          component,
          route,
          ...classify(entry, component, route),
        })
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  mkdirSync(resolve(REPO_ROOT, 'docs'), { recursive: true })
  writeFileSync(REPORT_PATH, renderReport(rows, version))

  const count = (s: Status) => rows.filter((r) => r.status === s).length
  process.stdout.write(
    `react-coverage: ${rows.length} rows — ${count('INLINE')} INLINE, ${count('FALLBACK-BY-DESIGN')} FALLBACK-BY-DESIGN, ${count('GAP')} GAP\n`,
  )
  const mismatched = rows.filter((r) => r.mismatch || r.routeMismatch)
  if (mismatched.length > 0) {
    process.stdout.write(
      `react-coverage: ⚠ ${mismatched.length} row(s) differ from the recorded expectation: ${mismatched.map((r) => r.entry.id).join(', ')}\n`,
    )
  }
  process.stdout.write(`react-coverage: wrote ${REPORT_PATH.replace(`${REPO_ROOT}/`, '')}\n`)
}

export { BATTERY, NOT_INLINED }
export type { Entry, Category }

if (import.meta.main) {
  await main()
}
