# Client-only Island server fallback
<!-- conclave-plan:v1
{
"owner":"0ddb11d0-954b-4710-90ce-8191a46fe3c3","authority":"in-loop",
"planPath":"docs/superpowers/plans/2026-07-18-client-only-island-fallback.md","baseSha":"1710d89d4ba08304851dfdff6635073d84623300","escalation":"0ddb11d0-954b-4710-90ce-8191a46fe3c3",
"readingOrder":["docs/superpowers/plans/2026-07-18-client-only-island-fallback.md","runtime/islands/island.tsx","crates/jsx-rust-compiler/src/lower.rs","runtime/islands/bootstrap.ts"],
"boundary":["crates/jsx-rust-compiler/src/emit_factory.rs","crates/jsx-rust-compiler/src/emit_jinja.rs","crates/jsx-rust-compiler/src/ir.rs","crates/jsx-rust-compiler/src/lib.rs","crates/jsx-rust-compiler/src/lower.rs","docs/superpowers/plans/2026-07-18-client-only-island-fallback.md","runtime/islands/bootstrap.test.ts","runtime/islands/bootstrap.ts","runtime/islands/island.test.ts","runtime/islands/island.tsx","tests/fixtures/app/NativeIslandPage.tsx","tests/fixtures/app/components/MenuSkeleton.tsx","tests/native-island.test.ts"],
"consumes":["runtime/islands/island.tsx#IslandProps","crates/jsx-rust-compiler/src/lower.rs#lower_island"],
"produces":["runtime/islands/island.tsx#IslandProps","docs/superpowers/plans/2026-07-18-client-only-island-fallback.md#Done When"],"gates":["cargo fmt --all --check","cargo clippy --workspace --all-targets --locked -- -D warnings","cargo test -p jsx-rust-compiler --locked","bun test runtime/islands/island.test.ts runtime/islands/bootstrap.test.ts","bun test tests/native-island.test.ts","bun test runtime/","bun run ci"]
} -->

## Goal

Allow a client-only island on a native/Jinja route to ship useful server-rendered placeholder HTML until its client chunk is ready, using `fallback={<MenuSkeleton />}`. Preserve the existing `createRoot` client takeover rather than hydrating placeholder markup as the real island.

## Non-goals

- No ISR caching for the fallback itself beyond behavior already available when its lowered SSR component explicitly uses ISR.
- No error-boundary or Suspense semantics; this is server placeholder markup before client takeover.
- No change to the real island component, its props, hydration trigger vocabulary, or chunk identity.
- No nested `<Island>` inside a fallback in v1.

## Decisions

1. The public interface is `fallback?: ReactElement`, called as `fallback={<MenuSkeleton />}`. A JSX element carries its own props and children, avoiding a second `fallbackProps` interface.
2. The feature applies to client-only islands on native/Jinja routes. The outer mount remains `data-brust-csr`, so the browser uses `createRoot`, not `hydrateRoot`.
3. The fallback JSX is lowered through the existing native-component path. Pure components inline into Jinja; components that cannot inline degrade to the existing SSR `comp_N_html` slot and generated factory.
4. `ssr + fallback` is valid but emits a build warning that fallback is ignored. The compiler must not lower or render the ignored fallback; the real island SSR markup remains authoritative.
5. On React routes, `<Island>` continues to render the real component during SSR and ignores fallback without changing markup.
6. The client keeps placeholder children visible while resolving the island chunk. After a valid component module loads, it removes placeholder children immediately before `createRoot(...).render(...)`. A failed import or invalid chunk preserves the placeholder.
7. Fallback JSX containing another `<Island>` is rejected. Allowing it would create an independently scheduled nested root that the parent takeover could detach before it mounts or unmounts.

## Interface

```tsx
<Island
  component={MobileMenu}
  fallback={<MenuSkeleton label={data.menuLabel} />}
/>
```

`fallback` accepts one JSX element or fragment (`ReactElement` at the TypeScript seam). Component references such as `fallback={MenuSkeleton}` are intentionally rejected because they require implicit prop forwarding or a shallow companion `fallbackProps` interface.

## Ordered edits

1. Extend the public `IslandProps` interface and pin React-path ignore behavior with a runtime unit test.
2. Add the fallback subtree to compiler IR, parse/lower it after `ssr` is known, and add precise warning/error diagnostics.
3. Thread fallback through component numbering, collection, factory generation, and Jinja emission while keeping no-fallback and SSR marker output unchanged.
4. Update CSR takeover to retain placeholder DOM through chunk loading and clear it only immediately before a successful `createRoot` mount.
5. Add compiler, bootstrap, and native-server regression coverage for native-inline fallback, SSR-slot fallback, warn-and-ignore, failure preservation, and compatibility.
6. Run every verification gate at the final implementation SHA and submit the commit for read-only review.

## Implementation

### Compiler IR and lowering

- Add `fallback: Option<Box<JsxNode>>` to `JsxNode::Island` and update every exhaustive constructor/match.
- In `lower_island`, capture the raw `fallback` attribute during the attribute scan. After all attributes are known:
  - when `ssr` is true, append one precise warning such as `fallback ignored on ssr island \"MobileMenu\"` through the existing compile warning environment and leave the IR fallback empty;
  - otherwise require a JSX element or JSX fragment expression, lower it with the existing element/fragment path and current scope, and store the resulting node;
  - reject other expression shapes with a dedicated diagnostic;
  - reject a lowered fallback subtree containing `JsxNode::Island` with a dedicated diagnostic.
- Do not change `isr` validation: client-only `isr` remains invalid, while `ssr + isr + fallback` warns only about ignored fallback and continues with ISR SSR markup.

### Compiler walks and emission

- Number and collect top-level fallback `SsrComponent` nodes exactly as if the fallback appeared at the island call site. `collect_components` and `emit_factory::collect_factories` must traverse the stored fallback in identical source order.
- Do not collect or number the real island twice. The fallback prohibition keeps nested island manifests out of the placeholder subtree.
- For a client-only island, emit the lowered fallback between the opening and closing `data-brust-csr` mount tags. With no fallback, preserve the current empty marker byte-for-byte.
- For an SSR island, preserve the existing `island_N_html` slot byte-for-byte even when a source fallback attribute was present.

### Runtime takeover

- Add `fallback?: ReactElement` and its contract to `IslandProps`; the React implementation ignores it and renders the real component exactly as today.
- In `hydrateOne`, retain placeholder children during chunk-map lookup and dynamic import. In the `data-brust-csr` branch only, remove all children after validating the imported component and immediately before `createRoot`.
- Do not remove placeholder children from the `hydrateRoot` branch. Import/validation failure must leave the DOM unchanged.

### Tests

- Compiler lowering: JSX fallback accepted; component-reference fallback rejected; nested island fallback rejected; `ssr + fallback` warns and produces no fallback node; `ssr + isr + fallback` retains ISR fields.
- Compiler emission: native-inline fallback appears inside `data-brust-csr`; non-inlinable fallback produces and fills a `comp_N_html` slot; no-fallback and SSR-island outputs remain unchanged.
- Runtime type/render: React-path `<Island>` accepts fallback but renders only the real component.
- Bootstrap: CSR placeholder exists during a deferred import, is cleared before `createRoot`, and survives failed import; SSR markers retain server children and still use `hydrateRoot`.
- Native integration: `/ _test/native-island` fixture (without the space in the actual route) returns a client-only marker containing `MenuSkeleton`, still includes `data-brust-csr`, and retains normal bootstrap/chunk behavior.

## Risks

- Every `JsxNode::Island` exhaustive match must be audited; treating Island as a leaf in component numbering/collection would leave SSR fallbacks unresolved.
- Clearing before a chunk is validated would turn recoverable load failure into blank UI.
- A nested island fallback can leave a React root attached to detached DOM; v1 rejects it rather than adding cross-root scheduling and cancellation.
- `hydrate=\"interaction\"` triggers mounting but does not replay the triggering event; this is existing trigger behavior and remains unchanged.
- Fallback SSR components add server React work on every request unless they inline or use their own supported cache semantics.

## Rejected alternatives

- `fallback={MenuSkeleton}`: rejected because fallback props and children become implicit or require another public prop.
- `fallbackProps={...}`: rejected as a shallow parallel interface duplicating the JSX element model.
- Hydrating fallback markup as `MobileMenu`: rejected because different trees cause React hydration mismatch.
- Silently using fallback together with `ssr`: rejected because callers need to know the supplied fallback is dead configuration; warning is the human-approved behavior.
- Nested fallback islands: deferred until takeover can cancel or unmount every scheduled nested root safely.

## Authority and Roles

- Aoki owns interface/spec decisions, plan changes, integration, and final acceptance.
- Dabin implements within this boundary and owns implementation judgment consistent with the plan.
- Armin performs read-only spec and standards review before integration.
- Authority is in-loop. The human settled `ssr + fallback` as warn-and-ignore rather than a build error.

## Escalation

Aoki rules interface and plan conflicts with authority in-loop. Dabin records implementation judgment as task notes and files any contradiction between the fallback contract and current compiler/runtime behavior as a task challenge with evidence. Armin files review findings on the task. Any expansion to error fallback, nested islands, event replay, or non-native route behavior is outside this task and requires a recorded plan amendment before implementation.

## Verification

Run the header gates in order. Record each gate at the implementation SHA. The integration test may reuse the existing native-island fixture server; it must prove the response contains placeholder HTML before any browser JavaScript runs. The bootstrap unit tests must prove ordering at the `createRoot` call, not merely final DOM.

## Done When

- `fallback={<MenuSkeleton />}` produces server placeholder HTML inside a client-only native island marker.
- Native-inlinable and SSR-slot fallback components both compile and render through their established paths.
- The placeholder stays visible through chunk loading, is cleared only for successful CSR takeover, and survives load failure.
- `ssr + fallback` builds with a precise warning and renders only the real SSR island markup.
- Existing islands without fallback remain byte-for-byte compatible at the compiler marker seam and all gates pass.
