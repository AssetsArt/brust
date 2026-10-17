# F369: `asChild` of a NATIVE parent (design note; implementer, 2026-10-17)

Status: design only, no code. Ruling asked of Detoro after Mellow's review. Stacked on F363a (`lane/toggle-group-f363` @0da28319).

## 1. The problem, with evidence

toggle-group has two `asChild` parents, both Native: `RovingFocusGroup.Item` (useId record, context consumer, handlers hoisted from the roving state) and `RovingFocusGroup.Root` -> `RovingFocusGroupImpl` (a native Provider clone with the `currentTabStopId` state). Three independent walls stand between the page and native, in this order (probe `ToggleGroup.Item` / `ToggleGroup.Root` from the package source, F363a tip):

1. **Carried poly (Item, Root).** Neither parent is itself polymorphic: each spreads its rest props, which carry `asChild`, into `Primitive.span` / `Primitive.div` (poly). F153c records that as `absent_props = [asChild]`, so the call site's `asChild` (literal `true`) fails `require_absent` (`slot-dynamic`: "`asChild` of <RovingFocusGroup.Item> is not a literal `false` or absent"). `check_poly` never runs for the parent because `ir.poly` is not set for a carrier. (Measured: with the Native gate below switched off the refusal text does not change; this wall comes first.)
2. **Native parent gate (`slot-native`, children.rs `check_poly`).** Only a Static parent (or the Q5 owned consumer: a specialised clone fed `__ctx_` props with no state/refs/effects) may be resolved at its call site. Item and Impl are Native.
3. **Content owned by the parent (`slot-owner`, Root).** Root's `asChild` child is `<Primitive.div>` whose children are the Items; their handlers/live values would print inside Root's host (F307 territory), and `ToggleGroupImpl`'s two diagnostics (`slot-dynamic`, `slot-owner`) make `ToggleGroupImplSingle`/`Multiple` unspecialisable, which is the whole of F330 (`forwarded ref passed to ToggleGroupImplSingle` is a cascade, not a ref bug).

Beyond the walls, Item's child is `<ToggleGroupItemImpl>` -> `<Toggle>` (stateful): that is F329's live spread + function prop through a component child, not this note.

## 2. Size

- Scoreboard (shadcn pages): switching wall 2 off alone moves **0 pages** (64 rows identical: 56 static, 1 native, 7 react; 35 islands). F363a also moves 0 (the one `slot-child-component` row has a Radix island as its child). The census row "Slot / asChild" lists 58 library components using Slot/asChild; most are Static or Q5 consumers and already resolve. The Native-parent population is the Radix roving/collection family (RovingFocusGroup Item/Root, hence ToggleGroup, Toolbar, Tabs list, RadioGroup, Menubar/DropdownMenu items later), i.e. the same blocker for 5-6 shadcn pages once the rest of each page's chain is native. toggle-group is the only page this PR line targets; the rest are upside, not a gate.
- Code: S1 (carried poly) ~80 lines analysis + 2 tests; S2 (Native gate) ~120 lines analysis/lowering; S3 reuses `specialise_host` (F307) with one rule change.

## 3. The two lowering options

**Option A, in place (resolve at the call site, parent stays inlined).** The Native parent is already inlined in its caller (F328c). Its poly element becomes the call's child: a host element (R34.29 `as_child_of`, today for Static only) or, with F363a, a static component given the element's attributes as props. For a Native parent the replaced element also carries the parent's `x-data` and hoisted `x-on-*`; the child's attributes/body are printed in the caller's scope inside that element. Cheap, and no new component.
- Fail-closed rules (all must hold, else the caller keeps its fallback, new code `slot-native`): (R1) the poly element is the parent's ROOT element (so the parent's `x-data` host is the child); (R2) the child (host element or F363a component) and its subtree carry no directive of any kind, no `ref`, no handler, no live value, no collection marker: static markup only, because Alpine evaluates a directive in the scope of the nearest `x-data` and `x-collection-item`-style directives read ONLY that scope (hit in F328b ItemSlot); (R3) none of the child's attribute names collides with a parent member (instance-suffixed names make this the norm, asserted); (R4) the parent's own handlers keep composing with nothing from the child (a child handler stays `slot-handler`); (R5) the parent has no `children` slot printed elsewhere (its children come from the child).
- Weakness: wall 3 (Root) is not solved; Root's children print inside Impl's host and the existing `slot-owner` check stays authoritative.

**Option B, clone with content (host-specialise, F307).** Specialise the parent for this call site with the child spliced in at the poly element: the clone is its own component, so the child's directives and members are the clone's own and Alpine scoping holds by construction; this also fixes `slot-owner` (content moves into the clone, as `specialise_host` already does for children printed in a host). Heavier: one clone per call site, a new place where Slot's merge (class join, composed handlers) must be done at Node level inside `specialise`, and the clone cache key must include the child shape.
- Fail-closed rules: the existing `specialise_host` refusals plus (B1) the child is a host element or an F363a component, never a React island; (B2) the poly element is unique in the parent; (B3) a spread of unknown keys on the poly element together with a child `className` or `style` is `slot-merge` (as today).

## 4. Pick

Stage it, A first, B for Root:

- **F369a: carried-poly recognition (S1).** Set `ir.poly` on a component that spreads its rest props into a poly element whose flag it does not otherwise read; drop the flag from `absent_props` (the call site resolves it now); callers that themselves spread unknown props into it keep the old `require_absent` path (F153c), unchanged. Value: unblocks `check_poly` for carriers and for Static carriers too (Static parents like shadcn `Button`-over-`Primitive` wrappers), measurable by battery rows alone. Smallest, independent, no behaviour change for Native parents (still `slot-native`).
- **F369b: Option A for Native parents (S2),** rules R1-R5. toggle-group Item: still blocked behind F329 (Toggle is stateful), so F369b alone moves no page; its test is a Native Item-like parent with a static host child, served == React in Chromium.
- **F369c: Option B for Root (S3):** content-owned asChild parents via `specialise_host`, which also dissolves F330.

Order recommendation: F369a, then F329 (the live spread / function prop through a component child, needed for Item either way), then F369b, then F369c. Each step keeps the page React until the last, so each needs its own evidence from probe + battery + a Chromium served==React case; the 15 KB rule is checked when the page flips.

## 5. Questions for the ruling

1. Accept the split F369a/b/c and the order above (F329 before F369b)?
2. For Option A R2: static-only child body acceptable for the first cut (Item's child is a stateful component, so it waits for F329 anyway)?
3. Mellow: is "carrier recognition drops `asChild` from `absent_props`" sound given callers that spread unknown props into the carrier (rule above keeps F153c there)?

## 6. Lead ruling (Detoro, 2026-10-17, after Mellow's REVIEW-PASS f1afd534 with amendments F1-F3)

- **F369a = carried-poly recognition, accepted under ALL of Mellow's F2 rules (a)-(e):** a unique, unconditional poly element; the WHOLE rest spread; no later `asChild` override; transitive carriers; callers that spread unknown props keep F153c through `check_poly`'s `spreads_in` branch. One negative test each for (a)-(c) plus a two-level carrier. F3 is a required test: a carrier over an inlined `Primitive.span` with a host child renders == React, and `poly_element_attrs` must see the element after inlining. F369a needs no page to move; battery rows are its evidence. (Implemented: plan record 27 of `2026-10-14-shadcn-roving-collection.md`.)
- **Option A is DROPPED** (this overrides the a/b/c split of section 4). Its R2 limits it to a static-only child body, and Item's child is `ToggleGroupItemImpl -> Toggle`, which has `onClick` and a live `aria-pressed` even after F329, so Option A never covers Item and names no page it moves. **F369b = Option B (clone via `specialise_host`) for BOTH Native parents, Item and Root:** one mechanism, and it dissolves F330. Fail-closed rules B1-B3, the clone cache key includes the child shape, and Mellow's F1 inside the clone: when the child sets a key the parent binds on the poly element (id, tabindex, data-state, ...) or there is a LIVE `className`/`style` on the parent's poly element, the first cut refuses with `slot-merge`; joining live values is a later row.
- **Order: F369a -> F329 -> F369b.** All ride row F369 (PR parts, no new numbers); F330 closes as a cascade when F369b lands. **Checkpoint after F329:** re-measure the toggle-group page (first refusal, projected bytes against the 15 KB gzip stop rule) before F369b; if the page cannot get under 15 KB, stop and report. A challenge that Option A covers Item after F329 needs a probe, within 2 rounds.
