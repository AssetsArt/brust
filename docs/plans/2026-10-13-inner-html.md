# inner-html: support `dangerouslySetInnerHTML` on every tier

**RULED by lead Detoro 2026-10-13. Human: "เพิ่ม support dangerouslySetInnerHTML ด้วย" (add `dangerouslySetInnerHTML` support).** This reverses the M1b ruling "`dangerouslySetInnerHTML` → `Diagnostic::error("no-innerhtml")`, spec: `x-html` deliberately absent" (docs/plans/2026-10-08-m1b1-ir-readers.md:402). The human's word supersedes it; this file is now the record.

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: v2 @9ac4885 · flow: lane → PR → v2 → CI (code rule)

## Why

Today the JSX reader (`crates/brust-compiler/src/analyze/jsx.rs:212`) raises an Error diagnostic, and `lower()` refuses any IR that carries an Error. As a result, a component with `dangerouslySetInnerHTML` fails the build on **every** tier, react included, even though React itself renders it. That breaks React compatibility (an existing React component cannot be dropped in). It also blocks the docs site: `CodeBlock` needs to emit server-highlighted HTML.

## Semantics (React's, exactly)

- `<el dangerouslySetInnerHTML={{ __html: v }} />` puts the string `v` as the element's raw inner HTML, with no escaping. That is the contract the name warns about.
- `v` null/undefined → empty inner HTML. Non-string → `String(v)` (React stringifies).
- The prop on an element that also has children is an **Error** (`innerhtml-children`). React throws "Can only set one of `children` or `props.dangerouslySetInnerHTML`". Children here include JSX children and an explicit `children=` prop.
- The value must be an object with `__html`. Accept an object literal `{ __html: expr }` (lower to `expr`) and any other expression `o` (lower to `o.__html`, with a null-safe read). An object literal without `__html`, or with extra keys only → Error (`innerhtml-shape`). React throws on a missing `__html`.
- The prop works on host elements only. On a component, `dangerouslySetInnerHTML` is an ordinary prop passed through. A void element (`img`, `input`, `br`…) with it → Error (React throws).

## Per tier

| Tier | SSR (both targets: Bun/Rust and Cloudflare core-cf) | Client |
|---|---|---|
| static | template emits the value **unescaped** inside the element (`{{ … | html_raw }}`, a dedicated filter, not `| safe` on arbitrary output, so the reviewer can grep every raw sink) | none |
| native, value not reactive | same as static | none |
| native, value reactive (reads state/signals/store) | same SSR, plus `x-html="_cN"` on the element | new runtime-dom directive `x-html`: an effect sets `el.innerHTML = next` (null → `''`). On first run, compare with the server's `innerHTML`; on mismatch, report through the existing `mismatch()` path and write. Mirror `directives/text.ts` |
| react | the React SSR renders it (nothing to lower); only the reader's Error must go | React hydrates it |

The reader stops raising `no-innerhtml`. It records a new attr variant (e.g. `Attr::InnerHtml { value: Expr }`) so the template printer, the client chunk and the tier analysis all see it explicitly. It must not surface as a generic `Attr::Dynamic` that would print `dangerouslySetInnerHTML="[object Object]"` as an attribute.

## Security (non-negotiable)

- Autoescape stays None, and every other dynamic output keeps `| e` (memory: brust-jinja-autoescape-none, a past real XSS). The **only** unescaped sink added is the InnerHtml one, through one named filter.
- `x-html` is reached **only** through a compiled `dangerouslySetInnerHTML`. A hand-written `x-html` attribute in source JSX is not special (React would print it as a plain attribute). The runtime binds directives from compiler output only, as today. Confirm that is how runtime-dom scopes binding, and add a test that a literal `x-html="…"` string attribute in user JSX is escaped/printed and not executed.
- **Raw subtrees are opaque to the runtime (ruled 2026-10-13, Mellow F1 on round 1).** Markup inside a `dangerouslySetInnerHTML` element is never bound or mounted, as in React. The compiler marks every InnerHtml element: `x-html` when reactive, `x-raw` otherwise. runtime-dom's `walkChildren` does not descend into `[x-html]` or `[x-raw]`. `mountTree` and the MutationObserver skip `[x-data]` hosts and islands whose closest `[x-html],[x-raw]` lies inside the root. `x-raw` is refused in user JSX, like `x-html`. Tests: an SSR body `<button x-on-click=…>` inside a raw element does not fire, and an `x-html` update to `<div x-data=…>` mounts nothing.
- Docs: one paragraph in the react-coverage / authoring docs. Say that it is raw HTML, that the author is responsible for sanitising, and that it is the same contract as React.

## Tasks

| slug | tier | role | deps | review |
|---|---|---|---|---|
| `inner-html` | complex | Implementer | — | complex |

Single lane. File boundary: `crates/brust-compiler/**` (analyze/jsx.rs, ir, lower/template.rs, lower/client.rs, the tier analysis), `crates/brust-jinja/**` (the `html_raw` filter, registered wherever the other filters are, on both the Rust server and core-cf), `packages/runtime-dom/src/directives/**` + its tests + README, `docs/react-coverage.md` (new battery rows), tests.

### Acceptance

1. Reader: the old test `member_tags_and_inner_html_are_diagnosed` is rewritten. member-tag stays a Fallback. InnerHtml produces the new attr, with no Error. New reader tests cover: literal shape, identifier shape, children+innerHTML → `innerhtml-children` Error, void element → Error, missing `__html` literal → `innerhtml-shape` Error, and a prop on a component passes through.
2. Tier: a static component using it stays **static**. A native component whose `__html` depends on `useState` stays **native**, with `x-html`. A component that is react for another reason stays react and builds. Add these as react-coverage battery rows (update the counts in docs/react-coverage.md).
3. SSR golden tests on the Rust server **and** core-cf (the CF integration suite the cf CI job runs): `<div dangerouslySetInnerHTML={{__html: '<b>x</b>'}}/>` renders `<div><b>x</b></div>`. null → `<div></div>`. A number → its string.
4. Escaping guard: a test proves the neighbouring `{text}` / attributes are still `| e`-escaped in the same template, and that `html_raw` appears only at InnerHtml sinks (grep test over the printer output of the battery).
5. Runtime: an `x-html` directive test in runtime-dom covers update, null, and first-run mismatch reporting. A browser test (tests/browser or the existing e2e harness) runs a native counter that swaps `<b>`/`<i>` markup on click.
6. Gates (mirror ci.yml exactly): cargo fmt --check, clippy -D warnings, cargo test --workspace --locked, `bun run ci`, the runtime-dom tests, the server, battery, browser and cf jobs locally where feasible. Then PR → v2. CI green (all 6 jobs), conclusions read, not exit codes.

## Follow-on (lead)

After merge, `docs-site` takes v2 (`git merge origin/v2`, then `bun install`). The site's `CodeBlock` (Task A1.4 of docs/plans/2026-10-13-docs-site-port.md) renders server-highlighted HTML through `dangerouslySetInnerHTML`, and that plan's risk line on highlighting is closed by this lane.
