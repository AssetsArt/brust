# slot-owner: binding a caller's slot content printed inside a child's host (F307, design note, no code shipped)

owner: Detoro · authority: in-loop · author: Dew · task: `slot-owner-design` · base: `lane/prop-liveness` @26a72f01 (origin/main + F319 PR 1 @34651f63 + F320, both MERGE-READY; F320 is this note's first dependency).
Status: **PROPOSED (option B), for the lead's ruling and Mellow's soundness review.** Nothing here is committed code: an env-gated spike (§4.2) was built and run in my worktree, never committed; its patch is `docs/transcripts/slot-owner/spike-b.patch`.

## 1. Answer

The note was asked how a directive in slot content should name the instance that owns it, so that content a caller prints inside a child's own host (`x-data`) stops being refused by `slot-owner` (F214 for a native child, F309 for a static child linked at the call site).

Measured answer: **the directive does not need to name an owner at run time.** The compiler already has the mechanism that makes the problem disappear: R34.122 / S2 *specialisation* compiles a component once per call site with the caller's content spliced in, and Carry (`children.rs`) turns every name of the caller the content reads into a hidden input `__in_<name>` that the call site passes. Applied to a **host** child (not only a state Provider), the content becomes the clone's own markup, so the nearest `x-data` *is* the right owner and `nearestInstance` stays as it is.

**Recommendation: option B (§5): specialise the host child per call site when its slot content carries a directive of the caller; keep the runtime unchanged.** With F320 in, the spike makes **8 of the 9 matrix pages Native**; every page's observable state equals React hydrating the same page after each click in Chromium, except one (§4.2: a text-only slot gains a `<span>`, a known printer detail with a fix). Cost: **+193 to +383 B gzip per specialised call site** (the clone's chunk), against the React fallback the page pays today (**66 KB gzip** of React + ReactDOM, §6). **Do not build the runtime owner attribute (option A)**: it adds a client resolution path, a new attribute and ordering rules for x-if / x-for clones and SPA swaps, for no page that B does not already cover.

This does not flip the real switch page alone: the shadcn scoreboard lists `island-children`, `island-prop` and `spread-props` before `slot-owner` there (§8).

## 2. The refusal today

A directive is bound by the instance whose host is its nearest `x-data` ancestor (`runtime-dom/src/directives/index.ts` `walkChildren` stops at a nested host; `instance.ts` `nearestInstance`; `props-bind.ts` resolves `x-props-bind` against `nearestInstance`). Slot content is printed by the child, inside the child's host, but written in the caller's scope: a directive of the caller there would look for the caller's members in the child and never update. So the compiler refuses:

- **F214** (`slot-owner`, native child): the children given to a native child that prints `{children}` inside its host contain a directive (handler, ref, live text or attribute, a condition or list over live data, a linked component).
- **F309** (`slot-owner`, static child linked at the call site): the linked static child gets a host of its own (`x-data` on its root), with the same consequence.
- Separate and out of scope: **R34.78** `children-read` (a static or native child that tests `children` as a value, `{open && children}`, `<Box>{children}</Box>` passed on by a static wrapper).

## 3. What exists today (so nothing is designed twice)

- **Specialisation (R34.116 / R34.122 / S2 / R34.123):** `Walker::specialise` + `analyze::modules::compile_specialised`: a clone of a component per call site, id `<id>_s<hash(path, loc)>`, its content spliced at `{children}` (`splice_children`), a render prop's body likewise (B7). The clone's `fixed_props` lists the hidden inputs the call site does not change on the client. Clones whose chunks are equal share one factory module at lowering (R34.124).
- **Carry (S2):** a name of the caller read in the moved content becomes a prop `__in_<name>` of the clone, filled at the call site with the name itself (a constant is seeded, a live value crosses the existing `x-props-bind` link, a function crosses as a client-only prop); a handler of the caller written in the content becomes a handler of the clone that calls the carried function. Refused by name: the caller's whole props or `...rest`, a ref, a list row's bindings, imports, stores, module-level functions, a name read inside code printed verbatim (`check_owner` refuses a consumer of another Provider's frame).
- **F320 (instance rule):** a component with an instance follows its named props as signals (rows get x-for, children it is given a changing prop are linked). F323 (stateless components) stays frozen per call site, except where the call site is known (§4.2: a specialised clone).

## 4. Measured

Harness: `docs/transcripts/slot-owner/` — `app/` (the matrix: `Box` = native host with state printing `{children}`; `Label` = static, linked at the call site; `Gate` = native, `{open && children}`; `Outer` = static, hands `{children}` to `Box`; `Thumb` = static leaf; one page per shape), `show.ts` (`compileTree` as `brust build` does; tiers and diagnostics), `serve.ts` (builds and serves the app, and compares every element under `<main>` — tag, `data-*`, `checked`, leaf text — with React hydrating the same page in the same Chromium, after each click on `f` (the caller's state) and `box` (the child's own state)). Addon built from the base above (warm own target, nice 10).

### 4.1 Stock compiler (base @26a72f01)

| page (content inside the child) | tier | served == React |
|---|---|---|
| `const` — `<Box><b>fixed</b></Box>` | Native | equal |
| `state` — `<Box><b>{on ? 'a' : 'b'}</b></Box>` | React (`slot-owner`) | equal (React) |
| `text` — `<Box>{on ? 'a' : 'b'}</Box>` | React (`slot-owner`) | equal (React) |
| `handler` — `<Box><button onClick={() => setOn(!on)}>` | React (`slot-owner`) | equal (React) |
| `list` — `<Box>{[1, 2].map(i => <b>{on ? i : -i}</b>)}</Box>` | React (`slot-owner`) | equal (React) |
| `linked` — `<Box><Thumb on={on} /></Box>` | React (`slot-owner`) | equal (React) |
| `linked_static` — `<Label on={on}><Thumb on={on} /></Label>` | React (`slot-owner`, F309) | equal (React) |
| `two_levels` — `<Outer><b>{on ? 'a' : 'b'}</b></Outer>` | React (`children-read`) | equal (React) |
| `gate` — `<Gate><b>{on ? 'a' : 'b'}</b></Gate>` | React (`children-read`) | equal (React) |

### 4.2 Spike: specialise the host child (option B)

Spike (env-gated `BRUST_SPIKE_B`, `BRUST_SPIKE_B_STATIC`; patch `spike-b.patch`, 154 lines): in the frames pass, before the Provider specialisation, a child whose slot content holds a directive or a component is cloned for the call site with `spike_host` = Carry + `rebase_sources` + `compile_specialised` + `splice_children` (the S2 code path, minus the Provider frame); native hosts and, with the second flag, static children that print `{children}`. One more line for the static case: a specialised clone counts its non-fixed props as signals (`props_are_signal` true for `specialised`), because its one call site is known (§7.3).

| page | tier (spike) | served == React (spike) |
|---|---|---|
| `const` | Native (not cloned: nothing owned) | equal |
| `state` | **Native** | **equal** |
| `text` | **Native** | **differs**: brust prints `<span>b</span>` where React prints the text node `b` (values follow; one extra element) |
| `handler` | **Native** | **equal** |
| `list` | **Native** | **equal** |
| `linked` | **Native** | **equal** |
| `linked_static` | **Native** | **equal** |
| `two_levels` | **Native** (`Outer` is cloned with the content, so `children-read` no longer applies) | **equal** |
| `gate` | React (`children-read`, `{open && children}`) | equal (React) |

Before F320 the same spike left `list` and `linked` stale (served `b:-1 b:-2` after the click; F319), which is why this note waited for it.

Battery with the spike on (521 rows): **3 rows react → native** (`c-slot-owner-state`, `c-slot-owner-linked-static`, `c-native-provider-live-name-nested`), **1 row native → react** (`c-forwardref-child-ref-cell`: the static-clone flag cloned a static forwardRef child that the stock path keeps *unlinked*; the clone then got linked for its carried `n` and its spread handler was refused, `spread-handler`). The fix is part of the design (§7.2: clone a static child only where the stock path would refuse F309). shadcn scoreboard: no change (§8).

## 5. Options

| | A. runtime owner attribute (`x-own="<k>:<owner>"`) | B. specialise the host child per call site (recommended) |
|---|---|---|
| how a directive finds its owner | `walkChildren` skips `[x-own]`; the owner instance binds them: the k-th enclosing host named `<owner>`, in the scope its walk had at the call site | it does not have to: the content is the clone's own markup, its nearest host is the clone |
| runtime change | yes: owner lookup, a binder pass per owner, `bindAdded` hooked into `hooks.mountTree` for x-if / x-for clones and navigation swaps, `x-props-bind` resolved against the owner for linked components in the content, a parent/child order rule (owner mounts first, but late chunks invert it) | none |
| server | prints the content as today plus `x-own` on each top-level element | the clone's own jinja, seeded through `x-props` like any native child (`__in_*` keys) |
| new attribute / sink | a new `x-*` attribute the reader must refuse when hand-written; a depth-indexed lookup that a DOM reshuffle (portal, swap) can point at the wrong host (the name check only narrows it) | none: compile-time member names only |
| cost | **584 B gzip** once per page that uses it (sketch `own-sketch.ts`, minified + gzip, not wired, no parity tests), plus per-directive lookups | **+193 to +383 B gzip per specialised call site** (§6), equal clones shared (R34.124) |
| coverage (matrix) | in principle all shapes incl. `gate` (content re-created by the child's x-if), if `bindAdded` runs on every clone | 8 of 9 Native, 7 of them equal to React now; `text` needs a printer fix (§7.4); `gate` stays `children-read` |

A is rejected for now: every shape it would cover except `gate` is covered by B with no runtime change, and `gate` is blocked by R34.78 before any owner question arises. **What would force A:** a page where the content must stay shared between call sites (a host child used at many call sites, each with owned content, where per-call-site chunks would cost more than the 584 B runtime), or content re-created by the child at run time (`gate`) once R34.78 is lifted. Neither was found.

## 6. Cost (measured, spike build of the matrix)

| chunk | raw | gzip |
|---|---|---|
| `box` (the shared host, unchanged) | 315 B | 287 B |
| clones, one per call site with owned content: 8 in the matrix (6 of `Box`, 1 of `Label`, 1 of `Outer`) | 165–512 B | 193–383 B |
| stock: the React fallback those pages pay today (`chunk-…`: React + ReactDOM) | 212,435 B | 66,192 B |
| stock: the page's React island chunk (`react-pState…`) | 399 B | 322 B |

The page-level chunks are unchanged in size class (`pState` 288 B raw). The clone's chunk carries what the content binds (its handlers call the carried function: one closure per handler). Build: one more analysis + lowering of the host per such call site (the matrix built in the same tens of milliseconds; not separately measured).

## 7. Design (option B)

### 7.1 When a call site is specialised
In the frames pass, for `<Child …>{content}</Child>` where all hold:
1. `Child` prints `{children}` inside a host: a native child with `hosts_children`, or a static child that prints `{children}` **and is linked at this call site** (§7.2);
2. `content` holds what `owned_directive` reports (handler, ref, live text or attribute, a condition or list over live data) or a component that the children pass may link;
3. Carry accepts `content` (every refusal of S2 stands: whole props / `...rest`, refs, row bindings, imports, stores, module functions, verbatim code, another Provider's frame);
4. the clone compiles to Native or Static (a clone that needs React is discarded and the call site keeps today's refusal).

If any fails, nothing changes: the stock refusal (`slot-owner`) is reported as today.

### 7.2 Static children: only where F309 would refuse
A static child's link is decided in the children pass, after the frames pass. Cloning every static child that prints `{children}` changed a correct Native page (`c-forwardref-child-ref-cell`, §4.2). Rule: the children pass, where it would report F309, records the call site (as `no_spec` / `spec_failure` record Provider call sites today) and the walk is re-run for that component with the call site specialised; a static child that stays unlinked keeps today's inlining, where the parent already binds its content in the parent's own scope.

### 7.3 Liveness inside a clone (closes the static case; part of F323)
A clone has exactly one call site, and its `fixed_props` already lists the inputs that call site does not change. So a specialised clone counts its other props as signals even when it has no instance (`ComponentIR::props_are_signal` → `|| self.specialised`), in analysis and lowering alike. This is the F319 freeze answered exactly: a constant input stays fixed (no x-for, no link), a live one follows. It is what made `linked_static` and `two_levels` Native and equal in the spike.

### 7.4 Text-only content
`<Box>{on ? 'a' : 'b'}</Box>`: the spliced slot is a bare text slot at the host's top level, and the clone prints it in a `<span>` so `x-text` has an element; React prints a text node. Fix in the lane: where a spliced bare slot is the only child of an element of the clone, bind `x-text` on that element (as a hand-written `<div>{x}</div>` does); otherwise keep the span and accept it, or refuse with a named rule (`slot-text-wrapper`) to keep served == React. To be decided in the lane with a served test.

### 7.5 What relaxes, exactly
- **F214** relaxes for a call site that is specialised (§7.1). The guard stays as written for every other call site (Carry refusal, clone needs React, content outside a host).
- **F309** relaxes for a call site that is specialised under §7.2. Otherwise unchanged.
- **R34.78** `children-read`: unchanged. `two_levels` goes Native because the static wrapper itself is cloned with the content (no `{children}` is read as a value any more); `gate` stays refused.
- F319's freeze: unchanged for unspecialised components; inside a clone, §7.3.

## 8. The real targets

- **Switch / checkbox (Radix `Thumb` inside `SwitchTrigger`, F298):** the shadcn scoreboard lists `external-component`, `island-children`, `island-prop`, `spread-props` for `components/ui/switch.tsx`; `slot-owner` comes after those. With the spike on, the shadcn scoreboard does not change. B removes `slot-owner` from the list once the others are gone; it does not flip the page by itself.
- **Any linked trigger (F298):** the same: B is what lets a trigger that is linked at its call site keep live content.

## 9. Security (§4 of the brief)

- **No new sink.** No attribute, no runtime path, no new jinja filter: the clone is printed and bound by the existing native printer and runtime. Names in the clone's chunk are compile-time member names (`_cN`, `_hN`, `__in_*`).
- **Content cannot bind into another instance's members.** It is compiled as the clone's own template: every member it references exists in the clone's chunk, and every value of the caller reaches it only through a hidden input the call site passes explicitly (Carry). What Carry cannot express is refused by name, as for R34.122 today; A1 (`check_owner`) still refuses content that reads another Provider's frame.
- **Values cross as data:** `__in_*` inputs are props: printed with `json_attr` into `x-props` and updated through `x-props-bind`, exactly as any linked child's props (no `tojson`, no raw sink).
- **No widening of what ships** (the F320 D1 principle): the clone ships only what the content binds; F325 holds inside clones (a list over module data stays frozen). A constant input stays fixed and is never re-read on the client.

## 10. Battery rows and fail-closed list

Rows (lane): flip `c-slot-owner-state`, `c-slot-owner-linked-static` to native with served tests; add `c-slot-owner-handler`, `-list`, `-linked`, `-two-levels` (native), `-text` (native or the named refusal, §7.4), `-gate` (react, `children-read`), `-carry-refused` (content reading the caller's `...rest`: react, `slot-owner`), `-clone-react` (a host that needs React as a clone: react, `slot-owner`), and keep `c-forwardref-child-ref-cell` native (the §7.2 regression guard).

Fail-closed (refused by name, unchanged): Carry's list (whole props / `...rest`, refs, row bindings, imports, stores, module functions, verbatim code), another Provider's frame (A1), a clone that needs React, content outside a host, `children-read`.

## 11. Plan for the lane (if B is accepted)

1. The specialisation entry for host children (§7.1) and its tests (compiler + served matrix as `tests/server/slot-owner-b.chromium.test.ts`), mutation per guard.
2. The static re-walk (§7.2) with the `c-forwardref-child-ref-cell` guard.
3. Clone liveness (§7.3), F323's specialised part.
4. Text-only content (§7.4).
5. Battery and shadcn scoreboard before/after, naming every page that flips.
Gate: Mellow (soundness); reviews as the lead assigns.
