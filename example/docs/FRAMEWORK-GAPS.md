# Framework gaps found while building the docs site

This file is the docs site's job as a dogfood: every time a page needs something
brust can't do cleanly, it's logged here (not silently worked around). Format:
**what we wanted → what blocked it → workaround now → clean fix**.

> Seeded from the spec review (2026-06-06). Status updated as the build progresses.

## G1 — No ergonomic code-block authoring (CONFIRMED, highest impact)
- **Wanted:** paste real code samples into `<pre><code>` verbatim.
- **Blocked by:** native compiler rejects template literals in page bodies
  (`crates/jsx-rust-compiler/src/lower.rs` ~4088, "template literals not supported in
  Phase A1"); raw multi-line JSX text is whitespace-collapsed by `normalize_jsx_text`
  (`lower.rs` ~3946), destroying code formatting.
- **Workaround now:** author code as a single string-literal child/prop
  `code={"line1\nline2"}` — `\n` survives, `<` auto-escapes via `| e`, `<pre>` honors it.
- **Clean fix:** a verbatim text mode (e.g. preserve JSXText whitespace inside
  `<pre>`, or a `whitespace="pre"` marker), OR allow template literals in native text
  position. This is the #1 thing to add for a great docs/authoring experience.

## G2 — `<Example>` hosting interactive native children — RESOLVED (works!)
- **Wanted:** `<Example native><Counter native/></Example>` — a native card wrapping a
  live interactive child.
- **Result (T0 browser-verified):** WORKS. The Counter mounts inside Example with its
  own `x-data="counter_…"`, `+` increments to 2, and Example's own `x-show` source
  toggle (separate `x-data`) flips independently. The splice path
  (`lower.rs` ~2149-2169) preserves the child's x-data exactly as designed. No gap.
- **Bonus finding:** a code-sample string passed as a **member-path prop**
  (`code={counterCode}` where `counterCode` comes from the LOADER) DOES inline; an
  **imported const** (`code={importedString}`) does NOT (subst_err → SSR fallback,
  `lower.rs:2041`). So reusable native components can take loader-var props — route
  code samples through the loader, not module imports.

## G3 — Mobile sidebar collapse (deferred)
- **Wanted:** a hamburger toggling the sidebar on mobile.
- **Blocked by:** the directive runtime's `bindTree` doesn't cross `x-data`
  boundaries, so the toggle button and the sidebar must live under one `x-data` root.
- **Workaround now:** sidebar is `hidden md:block` (desktop-only this round).
- **Clean fix:** a cross-component/global directive scope, or a documented pattern for
  app-shell-level toggles.

## G5 — Directive discovery false-positives on code samples (CONFIRMED, build-breaking)
- **Wanted:** show a real code sample containing the text `export const behavior` in a
  doc PAGE (a page has no behavior of its own).
- **Blocked by:** `scanDirectiveComponents` (`runtime/native/build.ts:6,39`) is a naive
  text regex `/export\s+const\s+behavior\b/` over each source file. A page whose
  `code={"…export const behavior…"}` string literal contains that phrase is mistaken
  for a directive component → the build emits `<page>.directive.entry.ts` importing a
  non-existent `behavior` export → **build fails**.
- **Workaround now:** co-locate every code-sample string in the actual behavior
  component file (e.g. `Counter.tsx` `export const source`) and import it into the
  page, so the page source never contains the literal phrase. Tree-shaken from the chunk.
- **Clean fix:** discover behaviors by parsing real top-level exports (AST), not a text
  regex — or at minimum ignore string-literal contents. Important for a docs site,
  which by definition shows framework source in code blocks.

## G4 — Hyphenated SSR-component props emit invalid JS (avoided)
- **Note:** `emit_factory` writes hyphenated props on non-inlined capitalized
  components as bare keys (invalid JS). We AVOID hyphenated props on any such
  component. Logged for awareness; not hit yet.

## G6 — Component-with-behavior inside a `.map()` in an inlined layout (active-nav)
- **Wanted:** a sidebar `<NavLink native href={link.href}/>` (a behavior component for
  active-link state) rendered inside the layout's `nav.map(...)`.
- **Blocked by:** inlining a nested component whose prop is a **map-local binding**
  (`link.href`, not a loader var) fails → "unsupported prop", and the whole Layout
  soft-falls to an SSR component (losing the <html> shell). Loader-var member-path
  props inline fine; map-local ones do not.
- **Workaround now:** static `<a>` sidebar links (no JS active highlight this round).
- **Clean fix:** support map-local bindings as substituted props on nested inlined
  components, OR a documented client-only active-link directive.

---

## Full-site build (2026-06-06) — new findings

Extending the tracer to the full 15-page design surfaced three more native-inlining
constraints. All were worked around; none required a framework change to ship.

## G7 — `<Island props={{ ... }}>` with an inline object literal breaks host inlining
- **Wanted:** pass server data to a React island in a native layout —
  `<Island component={MobileNav} props={{ nav }} />`.
- **Blocked by:** the inline object-literal prop makes `lower_component_inline`
  emit "unsupported prop", so the WHOLE native host (`Layout`) soft-falls to an SSR
  React component — losing the zero-JS shell for every page under it
  (`crates/jsx-rust-compiler/src/lower.rs` ~2127).
- **Workaround now:** the island self-imports its data instead of receiving it via
  props (`MobileNav` imports `NAV` directly; it's a client module, so the static
  import is free). `<Island>` with only scalar/literal props (`hydrate="load"`)
  inlines fine.
- **Clean fix:** support serializable object-literal props on `<Island>` inside a
  native host (serialize to the hydration marker like the loader-var path does).

## G8 — body-level ternary returning elements isn't inlinable
- **Wanted:** a prev/next pager that omits a card at the ends —
  `{hasPrev ? <a/> : <span/>}` in the native Layout body.
- **Blocked by:** the element-returning ternary trips the same soft "unsupported
  prop" fallback (whole Layout → SSR React). Inline ternaries in *attribute* and
  *text* position work (S8); a ternary whose branches are full elements at body
  position does not inline.
- **Workaround now:** precompute the full class string server-side
  (`prevNextFor` returns `prevCls`/`nextCls` with a `b-pager__hide` modifier) and
  render both cards unconditionally, hiding the empty one via CSS `visibility`.
  This is the same pattern used for the active-nav highlight (`navFor` bakes the
  active class into each link's `cls`) — branch on the server, render flat markup.
- **Clean fix:** lower element-returning ternaries/`&&` at body position to jinja
  `{% if %}` blocks.

## G9 — no per-item dynamic icon in a native `.map()`
- **Wanted:** a lucide icon per sidebar link, chosen by a map-local `link.icon`.
- **Blocked by:** native lucide icons are resolved to static inline SVG at COMPILE
  time by component identity; a runtime string can't select one. A
  `<DynamicIcon name={link.icon}/>` has nothing to resolve.
- **Workaround now:** the sidebar renders text links with a server-computed active
  rail; per-item icons are dropped (the design's icons were decorative).
- **Clean fix:** a native icon-by-name component backed by a compile-time sprite of
  the referenced set, or an inline-SVG `<use href="#icon-...">` sprite.

## Positive pattern — server-computed per-item classes
The active-nav highlight, the pager, and the theme-stable code surface all use the
same idea: **the native template never branches per item; the branch happens in the
loader and ships as a class string.** `navFor(active)`/`prevNextFor(active)` return
view-models whose `cls` fields the template renders as plain member-paths. This is
the idiomatic way to get conditional presentation out of a zero-JS native route.
