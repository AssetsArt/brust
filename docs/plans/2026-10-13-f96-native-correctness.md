# f96-native-correctness: three native-tier bugs found porting the docs landing

**RULED by lead Detoro 2026-10-13.** Source: knock2's site-landing READY (@517eabe), filed as F96 in docs/plans/m1a-followups.md. These are bugs, not feature gaps: one runtime throw and two **silent** miscompiles, where the build is green and the page is wrong. They must be closed before beta.

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · base: v2 @21a1216 · flow: lane → PR → v2 → CI

## The bugs

| id | What happens | Expected |
|---|---|---|
| F96a | runtime-dom `bind.ts` sets `el.className` for `x-bind-class`. On an SVG element `className` is a getter-only `SVGAnimatedString`, so it throws `Cannot set property className …`. A native component cannot bind `class` on `<svg>`, `<g>` or `<circle>` | binding `class` works on HTML and SVG elements alike (`setAttribute('class', …)` for the SVG namespace, or always) |
| F96b | A helper function declared in a native component body that reads state (`const visible = () => items.filter(...)`, then called in JSX or a handler) compiles with **no diagnostic** and throws at runtime (`a is not iterable`) | either compiled correctly (the helper sees the reactive values) or refused at compile time with a fallback diagnostic that sends the component to react. Never green-and-broken |
| F96d | A static child inlined into a native parent, receiving a prop derived from the parent's state, does not update when that state changes (SignalLog in CatchCard). No diagnostic | the inlined child re-renders/binds reactively (its bindings read the parent's signals), or the compiler stops inlining it as static when its props are reactive (tier: native, or fallback with a diagnostic). Never stale-without-warning |

## Method (TDD, reproduction first)

1. **Reproduce each bug as a failing test before any fix**: a react-coverage battery row (compiler + manifest) and a browser or runtime test that observes the wrong behaviour (throw, wrong value, stale DOM). Post the three red tests as a task note with their names.
2. Fix F96a in runtime-dom, with a runtime test on an SVG element.
3. For F96b and F96d, first decide between **compile correctly** and **fail closed** per bug. Prefer compile-correctly when it is a contained change in the analysis or lowering. Otherwise fail closed with a named diagnostic. Post that decision with evidence (file:line of the analysis that misses the reactive read) as a task note, or as a `task challenge` to the lead if it changes the tier of existing battery rows.
4. Battery counts in docs/react-coverage.md updated, one row per bug.

## Acceptance

- The three reproduction tests are red on base v2 @21a1216 and green on the lane head. Paste both runs.
- No existing battery row changes tier unless the lead ruled it.
- Gates: mirror ci.yml exactly (cargo fmt/clippy/test, `bun run ci`, runtime-dom, server, battery, browser, cf). Rebuild the runtime addon from clean before the server/battery gates (stale `.node` trap). Then PR → v2 and CI green, reading conclusions.

## Tasks

| slug | tier | role | deps | review |
|---|---|---|---|---|
| `f96-native-correctness` | complex | Implementer | — | complex |

Boundary: `crates/brust-compiler/`, `packages/runtime-dom/`, `packages/brust/src/build/` (diagnostic plumbing only if needed), `docs/react-coverage.md`, `tests/`.
