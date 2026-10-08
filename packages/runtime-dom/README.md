# @brust/runtime-dom

React-free browser runtime that binds a compiled client chunk (`defineBehavior`) to server-rendered HTML
through `x-*` attributes. **This README is the output format the M1c client backend prints against**; every
behaviour below is pinned by a test in `test/`. Zero dependencies, eval-free, bundle < 13 KB minified
(`bun scripts/build.ts`).

## Public surface

```ts
import { signal, computed, effect, batch, untracked, defineBehavior, setChunkLoader, mount, unmount } from '@brust/runtime-dom'
```

- Signals (`test/signal.test.ts`): writes are `Object.is`-deduped; `computed` is lazy and cached; `effect(fn)` runs now and on
  change, a returned function is a cleanup that runs before each re-run and on dispose; `batch` defers effects to its end;
  `untracked` reads without subscribing.
- `defineBehavior(name, factory)`: `factory({ el, props, effect, onCleanup, ref })` returns the instance **members**
  (signals, computeds, functions, plain values). `props` is a **signal** of the props object. An `init` member, if a function, runs after the factory.
- `setChunkLoader(load)`: called once per unknown behavior name; the loader is expected to call `defineBehavior(name, …)`. Default: none (hosts wait).
- `mount(root = document.body)`: idempotent; mounts every `[x-data]` in document order (parents first) and starts a `MutationObserver`
  that mounts added hosts and disposes removed ones (a removed-then-reinserted host is disposed, then mounted fresh).
  `unmount(root)` disposes instances under `root` and stops the observer. A factory that throws is logged and its instance discarded; other hosts still mount.

## Directive value grammar

```
value    := path (":" bindings)?
path     := ident ("." ident)*          // looked up on the instance members; a signal/computed hop is unwrapped
bindings := ident ("," ident)*          // loop-scope names (x-for item/index); the member must be a function and is called with them
```

Anything else (`x + 1`, `fn()`) is not parsed: a warning is logged once and the DOM is left as rendered. An unknown member behaves the same.

## Attributes

- **`x-data="name"`**: one instance per host. Nested hosts are bound by their own instance, not the parent's walker.
- **`x-props='{"json":1}'`**: seeds `ctx.props`. Invalid JSON warns and seeds `{}`.
- **`x-props-bind="member[:binding]"`**: on a child host, rebinds the child's `props` signal reactively to the nearest ancestor instance's member
  (an object, typically a `computed`; function values pass through). Inside `x-for` the row's scope supplies the bindings. If the parent is not mounted yet
  (chunk still loading) the child links up when the parent mounts. No ancestor: warns, keeps the `x-props` seed.
- **`x-text="value"`**: sets `textContent`; `null`/`undefined` → `''`.
- **`x-show="value"`**: `style.display = ''` when truthy, `'none'` otherwise.
- **`x-if="value"`**: the element is replaced by a `<!--x-if-->` comment anchor; a clone is inserted after it while truthy and removed otherwise.
  Nested `x-data` hosts in the clone mount/dispose with it. Server HTML omits the element when false.
- **`x-bind-<attr>="value"`**: `class` → `className`; `value` → `.value`; `disabled checked selected readonly required hidden open multiple` → property + attribute (present/absent);
  anything else: `null`/`undefined`/`false` removes the attribute, otherwise `setAttribute`. **Refused** (warn once): `on*` and `srcdoc` attributes, and, in `href src action formaction poster data`, any URL whose parsed scheme is not `http(s):`/`mailto:`/`tel:` (relative URLs are fine; `java\tscript:` is caught because the URL is parsed, not pattern-matched).
- **`x-on-<event>="member[:binding]"`**: calls the member with the bound scope values first, then the event: `pick(item, index, event)`.
- **`x-model="member"`**: the member must be a writable signal (else warns). text-like: `input` event ↔ `.value`; checkbox: `change` ↔ boolean `.checked`;
  radio: `change` writes `.value` when checked, signal sets `.checked`; single `select`: `change` ↔ `.value`, re-applied whenever its options change. `select[multiple]` is unsupported (warns).
- **`x-for="item[, index] in source by keyFn"`**: `source` is a member path to an array (or signal/computed of one); `keyFn` is a member function of the item.
  Server-rendered sibling rows carrying the same `x-for` are **adopted in order** on first run; with zero rows the server emits a `<!--x-for-->` comment followed by one `hidden` template element
  (carrying `x-for`) which is cloned. Rows are reconciled by key (moves keep DOM identity); a reused row whose item/index changed has its binders re-run. Duplicate keys warn once and fall back to index identity.
  Elements with `x-for` are owned by the directive: their other `x-*` attributes are bound on the rows, with scope `{ item, index }`.
- **`x-ref="name"`**: `ctx.ref('name').current` is the element after mount, `null` after dispose.

## First-paint rule

Nothing re-renders on mount: server HTML is the initial state. A binder writes the DOM only when its effect re-runs after a change, **or** when the initial `x-text` value differs from the server text,
in which case it corrects it and warns once (`first-paint mismatch …`): a mismatch is a compiler bug the runtime must not hide. Elements created after mount (new rows, `x-if` clones) never trip this check.

## Gates

`bun test` · `bunx tsc --noEmit -p .` (`bun check` needs Bun ≥ 1.4.3) · `bun scripts/build.ts` (fails if the bundle imports React).
