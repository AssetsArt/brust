# shadcn S1 — spread into an island (F148a follow-up), read-only spike (draft for the lead's ruling)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · author: knock2 · reviewer: Afrojack (data path) + Mellow (security gate, as for F148a) · gates: Illenium · flow: lane → PR → CI → lead merges · ledger rows: F148a (follow-up), next free F176 · governed by `docs/plans/2026-10-14-react-parity-north-star.md`

Status: **DRAFT, spike only.** No compiler or runtime code was changed. Base: origin/main 89d7da7d (after #230, F148a). R-numbers are proposals (R34.126–R34.134); the lead renumbers. Every number was measured with the napi addon built from that commit; probes are in the session scratchpad (§9). `placement.rs` is not touched by anything proposed here (context-lowering owns it).

## 0. Short answer

1. **What the rule refuses today:** `check_spread` (`children.rs`) refuses `<Island {...x}/>` with `spread-props` ("props are spread into the React island"), so the wrapper that writes it becomes React. It is the shape of every shadcn Radix wrapper: `<DialogPrimitive.Content className={cn(…)} {...props}>`.
2. **How many sites:** **130 of the 309 app components** in the shadcn fixture carry `spread-props` after F148a. Of those, **39 have no other blocker** (`Dialog`, `DialogTrigger`, `Popover`, `Collapsible`, `Select`, `Sheet`…: one-line forwarders); **66 more are blocked also by `className={cn(base, className)}`** (`island-prop`: "an expression over props", measured 106 sites), 16 also by `island-children` with the same `cn`, and 9 by a lane that is not this one (`member-tag`, `jsx-expression`, `hook-*`, `slot-child-component`, `prop-pattern`, `nested-instance`).
3. **What it unblocks on the scoreboard: no page and no bytes**, as for F148a. Every one of these wrappers already sits inside the children registry of a Radix island (`Dialog` > `DialogContent`), or is itself the island root; pages are static with 1 island today and stay so. Client JS is flat (react + react-dom + the Radix tree stay). Making the 39 forwarders static removes about one wrapper's code per page from the island chunk (not measurable without the implementation; I estimate under 1 KB per page).
4. **The security finding is the point** (§4): a spread is the one place request data can pick the **key** of an island prop. Measured against the real revive: a `children` key becomes a live `<script>`, `dangerouslySetInnerHTML` becomes live HTML on any component that forwards it, `$x` re-aims the revive, `style` is applied. F158 and F148a closed every other door; a runtime spread would reopen them all.
5. **The design that is safe by construction: bind the rest at the call site, at compile time** (§5): the keys and values of `rest` are the explicit attributes of the wrapper's call site, which the compiler reads; only JSON literals qualify; request data never names a key. Option A flips the 39 forwarders. The other 105 need **computed island props** (`cn(...)` over a `className` prop) as well; that is a separate lane (F176 proposal), not part of A.
6. **Recommendation:** A now (small, certain, the same shape as `__ch`), then decide on the computed-props lane, which is where the shadcn wrappers actually flip. Do not build C (runtime rest with a key filter).

## 1. What a Radix wrapper is (measured, 130 sites)

Blockers per app component that carries `spread-props` (after F148a, codes without the child-only `external-component`):

| Remaining blockers | Components | Examples |
|---|---|---|
| `spread-props` only | **39** | `Dialog`, `DialogTrigger`, `DialogClose`, `DialogPortal`, `Popover`, `PopoverTrigger`, `Collapsible*`, `Select`, `SelectGroup`, `SelectValue`, `Sheet*`, `Drawer*` (non-Content), `ContextMenu`, `HoverCard`, `Tooltip`, `TooltipProvider`, `Spinner`, `ResizablePanel`, `CommandEmpty`, `AlertDialog`, `Accordion` |
| + `island-prop` (`className={cn(…)}`, an expression over props) | **66** | `DialogOverlay/Title/Description`, `SheetOverlay`, `SelectItem`, `TabsList/Trigger/Content`, `Avatar*`, `Checkbox`, `Toggle`, `Command*`, `MenuItem`s |
| + `island-children` (a `cn` or a computed attribute in the tree) + `island-prop` | 16 | `DialogContent`, `PopoverContent`, `SheetContent`, `SelectContent`, `TooltipContent`, `Progress`, `Switch`, `AccordionTrigger` |
| not this lane | 9 | `ToggleGroup` (member tag), `Slider` (nested instance), `MessageScrollerButton` (jsx-expression), `Form`, `Calendar`… |

The 106 `island-prop` sites are one shape: `className={cn("…base…", className)}`. A spread rule alone leaves them; the call is not a plain props path (R34.123 of F148a refused it for the same reason).

## 2. What the call sites pass (the key fact for the design)

`tests/fixtures/shadcn/pages/*.tsx`, every opening tag of the wrappers above (regex census, balanced braces): the attributes that would land in `rest` are few and **all literals**: `className="…"` (named by the wrapper, so not in `rest`), `align="center"`, `value={66}`, `defaultValue={[50]}`, `max={100}`, `step={1}`, `placeholder="…"`, `type="single"`, `id="…"`, `defaultValue="…"`, `collapsible`. **No function, no spread, no prop-path value** at any of these call sites. So the keys of `rest` are known to the compiler at the call site, and in the fixture their values are JSON constants.

## 3. Measured effect

| | Today | Option A (rest bound at the call site) | A + computed props (separate lane) |
|---|---|---|---|
| Components with `spread-props` that flip | 0 | **39** | up to **105** (39 + 66) |
| + those that also need children `cn` | — | — | +16 |
| Pages that change tier or island count | 0 | **0** | **0** |
| Client JS (gzip, any page) | flat | flat (≲ 1 KB less per page, estimate) | flat |
| Scoreboard `spread-props` row count | 40 measured rows | unchanged (a row lists it while any wrapper still carries it) | falls, with `island-prop` |

I will not claim a size win: the Radix tree and React are the floor (70–118 KB gzip per page), and the wrappers are inside it either way.

## 4. Security: spread keys reaching an island (measured)

One hostile key at a time through the real `reviveSource` / `__mk` (React 19.3), a spread of request data modelled as the island's props, host with no declared holes:

| Key in the spread | Result |
|---|---|
| `children: {"$brust":"el","t":"script",…}` | a live **`<script>`**: `children` is revived by design |
| `children: {"$brust":"cmp","id":"danger",…}` | a registry component instantiated with attacker props (its raw-HTML prop is stripped by `__props`) |
| `dangerouslySetInnerHTML` | live **HTML** on the host (the Radix component forwards it to its element) |
| `$x: ["children"]` + `children` | re-aims the revive at the request's own list |
| `style: {background:"url(//evil…)"}` | applied |
| `$c0` / `$p0` (a hole name) | `$c0` throws (a 500); an attacker could also set a declared `$p` |
| `__ch` | passes through as an unknown prop (harmless on its own; it is the wrapper's job input, §5 R34.131) |
| `onClick: "alert(1)"` (string) | dropped by React; `__proto__` payload: no pollution |

So request data must **never** choose a key. The F148a rules already keep request data to leaves; this lane adds the one construct that lets data into the key set, which is why the design binds keys at compile time.

## 5. Proposed rules

- **R34.126 The rest of a wrapper is bound at its call site.** A wrapper whose island call writes `{...rest}`, where `rest` is the wrapper's own rest of its destructured props (the shape `spread_carries` already proves), reads the island's extra props from the reserved job input `__rest` (like `__ch`). Each call site of the wrapper binds `__rest` to the **object of its own explicit attributes that the wrapper does not name**, as a compile-time constant in the instance record. The spread is not a runtime union of unknown keys.
- **R34.127 Literals only.** Every value in the bound object folds to a JSON literal at the call site (`FoldEnv`, the module consts). A call-site attribute that is a prop path, a state read, a function, or an element makes the call site a fallback with a named reason (`spread-props`: "the prop `k` of <W> is not a constant, and <W> spreads its props into a React island"), so the caller keeps today's behaviour.
- **R34.128 Reserved keys are refused at the call site, and dropped again in the revive.** `children`, `ref`, `key`, `dangerouslySetInnerHTML` (the ruling "fewer raw sinks"), `style` with a non-literal value (a literal object is allowed, as for a direct island prop), any `$…` key, `__proto__`, `__rest`, `__ch`. `__mk` filters the same list when it merges the object into the host's props (defence in depth; it never reads into the values).
- **R34.129 No runtime spread into the wrapper.** A call site that itself spreads (`<W {...x}/>`) into a wrapper whose job reads `__rest` falls back with the named reason, exactly as `__ch` (F148a F2); route components and route files never take a bound rest (their props are request data, R34.69).
- **R34.130 One merge order, no collisions.** React applies later entries over earlier ones. v1: a rest key that the wrapper also writes explicitly on the island (`data-slot`) is a fallback at the call site (named); then the merge is a union and order does not matter. Position-aware merging is the alternative (Q3).
- **R34.131 The revive takes the bound object by name.** `ChildRef.holes` gains `$r` (one per island; the host's props carry the object under it), `__mk(C, props, X, H)` merges `props.$r` into the props the component sees after the R34.128 filter and before `$x` handling. `__rest` is never a user prop: an explicit `__rest=` at a call site is `island-prop` (like `__ch`).
- **R34.132 Hostile-input proof.** The §4 table becomes a test set: each key sent through a loader in a **runtime spread into the wrapper** (refused: R34.129) and through a **bound literal at the call site** (refused or filtered: R34.128); the served page matches React's own render for the allowed cases (`align="center"`, `placeholder`, `value`, `defaultValue`).
- **R34.133 Fallback is never a build error.** Everything this lane cannot lower stays `spread-props` at analysis with a named reason (R34.97). A test pins that no fixture page turns into a build error (the F60 lesson of F148a).
- **R34.134 Proof and docs.** `docs/shadcn-coverage.md` regenerated with the before/after of the 39; the PR says plainly that tier, islands and client JS are flat, and lists the 66 + 16 that wait for computed props.

## 6. Battery rows (each served and compared with React's render)

1. A forwarder (`Dialog`-shaped) with literal attributes: static wrapper + island, HTML equals React's.
2. A wrapper that names `className` and spreads the rest: both reach the island.
3. Collision: the call site passes a key the wrapper writes (`data-slot`): fallback, named.
4. Call site passes a prop path, a state read, a handler: fallback, named (`spread-props`).
5. Call site spreads (`<W {...p}/>`): fallback, named (R34.129); with and without children.
6. Reserved keys at a call site (`children`, `dangerouslySetInnerHTML`, `$x`, `__ch`, `__rest`): fallback / `island-prop`.
7. Hostile loader through a runtime spread: no `<script>`, no `window.__pwned`, page renders as React.
8. Wrapper inside a wrapper (`nested-instance` stays a fallback, R34.97).

## 7. Boundary and gates

Boundary: `crates/brust-compiler/src/analyze/passes/children.rs` (`check_spread`, the island branch, the call-site binding of `__rest`), `packages/brust/src/build/bundle.ts` (`__mk`, `holesOf`, the filter), tests, fixtures, battery rows, generated docs. **Not** `placement.rs`, not the manifest or brust-core (the instance record already carries `literals`; `__ch` proved the shape). Gates: the F148a set (fmt, CI-exact clippy, `cargo test -p brust-compiler`, `packages/brust` bun tests including the revive hostile file, battery, shadcn scoreboard, the island Chromium files), plus the new served hostile test. Cold builds per `host:build-slots`.

## 8. Risks

1. **The list in R34.128 is the whole defence.** Mitigation: the compile-time refusal is the primary rule and the revive filter is the second; the hostile set pins both, and Mellow signs off the list.
2. **A rest that reaches the island through another path** (a rest of a rest, `props` forwarded whole, a renamed destructure). `spread_carries` already encodes own-props/rest; anything it cannot prove stays the refusal.
3. **Bundle size**: as in F148a, a wrapper whose call sites bind objects does not enlarge the island; only the existing `nestedOf` union applies.
4. **Value without the computed-props lane is small** (39 forwarders, zero pages). It is an enabler, and the plan says so.

## 9. Spike method

- Addon: napi build of main 89d7da7d in this lane (warm clone of the main worktree's `target/`, `nice -n 10`, `CARGO_BUILD_JOBS=4`; 11 minutes under load; no other agent's build was touched).
- `flip2.ts` (blockers per component), `ip.ts` (messages of `island-prop` / `island-children`), `census.ts` (attributes at the wrappers' call sites), `spreadkeys.ts` (§4, the real `reviveSource` with React 19.3), all in the session scratchpad; nothing but this document is in the tree.

## 10. Options and questions for the lead

- **A. Rest bound at the call site, literals only (recommended).** R34.126–R34.134. Flips 39 components, 0 pages, ~0 KB. Small, the same shape as `__ch`.
- **B. A plus computed island props** (`className={cn(base, className)}` evaluated per instance with the F149 build-time job where the inputs are constants). A separate lane with its own plan (F176): flips up to 105 components (+16 with the children `cn`). Still 0 pages / ~0 KB; it is what makes the shadcn wrappers static.
- **C. Runtime rest with a key filter.** Not recommended: the §4 table is the reason; a filter would have to be a complete list of what a Radix component reads as a sink.
- **Q1** A, B, or A now and B after? (My order: A, then B.)
- **Q2** `dangerouslySetInnerHTML` as a literal at a call site: refuse (recommended, the ruling on raw sinks) or allow when it is a literal?
- **Q3** Collisions: refuse (v1, simple) or merge by position?
- **Q4** Reviewers: Afrojack data path + Mellow security gate, as for F148a?

## 11. Lead ruling (2026-10-14)

owner: Detoro · authority: in-loop. **Accepted as a record; parked, not built now.**

- **Q1: neither A nor B now.** Both options flip components inside islands, but no page and no measurable bytes. The scoreboard rule is that only removing a page's last island saves bytes (about 69% of a page's JS is the React floor). Lanes go first to work that removes islands from pages: context lowering (wave A, 1a/1c/1b) and wave B (roving focus and collections).
- The plan stays the design of record. Option A is ledger **F176** and the computed island props (B) are ledger **F177**. Pick them up when a page or real app code needs them.
- **Q2–Q4, so the record is complete when it is picked up:** `dangerouslySetInnerHTML` is refused even as a literal (fewer raw sinks). Collisions are refused in v1. Reviewers are Afrojack (data path) and Mellow (security gate). Option C is never built: §4 is the reason.
