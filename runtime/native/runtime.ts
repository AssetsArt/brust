// Directive runtime — react-free, dom-only. Scans the DOM for x-* directives and
// binds them to per-element component instances via brustjs/store's `effect`.
import { batch, effect, isComputed, isSignal, signal } from '../store/index.ts'
import type { Signal } from '../store/index.ts'

export type Instance = Record<string, unknown>

/** What a `behavior` receives. Beyond `el`/`props`, two lifecycle helpers whose
 * teardown auto-joins the component's disposer set (run on unmount / SPA-nav swap):
 *  - `effect(fn)`  — a reactive effect (React `useEffect` semantics: `fn` may return
 *                    a cleanup that runs before each re-run and on unmount). Use it
 *                    for side-effects on signal change (sync localStorage, the DOM
 *                    outside the component, timers). Returns the disposer too.
 *  - `onCleanup(fn)` — register a one-shot teardown for unmount (e.g. removeEventListener). */
export interface BehaviorCtx<Host extends Element = HTMLElement> {
  el: Host
  props: unknown
  // biome-ignore lint/suspicious/noConfusingVoidType: React useEffect return shape (`void | Destructor`) — see store `effect`.
  effect: (fn: () => void | (() => void)) => () => void
  onCleanup: (fn: () => void) => void
}
export type Behavior<Host extends Element = HTMLElement> = (ctx: BehaviorCtx<Host>) => Instance

interface Mounted {
  disposers: Array<() => void>
}

type RegisteredBehavior = Behavior<Element>

const registry = new Map<string, RegisteredBehavior>()
const mounted = new WeakMap<Element, Mounted>()
const loading = new Map<string, Promise<unknown>>()
const pending = new Map<string, Set<Element>>()
let started = false

/** Per-component behavior chunk URL. Each native interactive component is built to
 * its OWN `<name>.directive.js` chunk (served from the islands static route) and
 * loaded ON DEMAND — only when an `x-data="<name>"` for it actually appears (initial
 * render OR after an SPA-nav swap). The chunk self-registers via the global below. */
const CHUNK_BASE = '/_brust/islands/'

/** Register a component behavior under `name`. Called by `<name>.directive.js` chunks
 * via the global handle below (they do NOT import this module — keeps each chunk to
 * just its behavior, with the runtime shared as the single `_directives.js` copy). */
export function register<Host extends Element = HTMLElement>(
  name: string,
  behavior: Behavior<Host>,
): void {
  registry.set(name, behavior as unknown as RegisteredBehavior)
  const hosts = pending.get(name)
  if (!hosts) return
  pending.delete(name)
  for (const el of hosts) mountElement(el)
}
// Expose `register` on a global so dynamically-imported behavior chunks self-register
// into THIS runtime's registry without importing/duplicating the runtime. Symbol.for
// → shared across chunks (same rationale as the store's brands/reactive ctx).
;(globalThis as { [k: symbol]: unknown })[Symbol.for('brust.directive.register')] = register

/** Scan `root` (default: document) for [x-data], mount each, and (once) attach a
 * MutationObserver for dynamic mount/dispose. Idempotent. NOTE: `root` scopes the
 * INITIAL scan only; the observer always watches the global `document.body` (one
 * observer per document handles every later mount/dispose, incl. SPA-nav swaps),
 * plus one observer per discovered OPEN shadow root (a body observer cannot see
 * mutations inside a shadow tree). */
export function start(root?: ParentNode): void {
  const scope: ParentNode | undefined =
    root ?? (typeof document !== 'undefined' ? document : undefined)
  if (!scope) return
  const run = () => {
    scanAndMount(scope)
    if (!started) {
      started = true
      if (typeof document !== 'undefined' && document.body) observeRoot(document.body)
    }
  }
  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true })
  } else {
    run()
  }
}

function scanAndMount(scope: ParentNode): void {
  if (scope instanceof Element && scope.hasAttribute('x-data')) mountElement(scope)
  for (const el of Array.from(scope.querySelectorAll<Element>('[x-data]'))) {
    mountElement(el)
  }
  // R10 — OPEN shadow roots host their own component trees: scan each the same
  // way (the recursion covers roots nested within roots) and attach an observer
  // per root, since neither the body observer nor an outer root's observer sees
  // mutations inside an inner shadow tree. Closed roots expose `shadowRoot ===
  // null` and are unreachable by design. The walk-all is per added subtree only.
  if (scope instanceof Element && scope.shadowRoot) scanShadowRoot(scope.shadowRoot)
  for (const el of Array.from(scope.querySelectorAll<Element>('*'))) {
    if (el.shadowRoot) scanShadowRoot(el.shadowRoot)
  }
}

function scanShadowRoot(root: ShadowRoot): void {
  scanAndMount(root)
  observeRoot(root)
}

function mountElement(el: Element): void {
  if (mounted.has(el)) return
  // Removed mid-scan (e.g. an initial-falsy x-if subtree pruned while scanAndMount's
  // snapshot loop was still iterating): mounting a detached element would leak its
  // effects forever — the MutationObserver never saw it removed.
  if (!el.isConnected) return
  const name = el.getAttribute('x-data') ?? ''
  const behavior = registry.get(name)
  if (!behavior) {
    let hosts = pending.get(name)
    if (!hosts) {
      hosts = new Set()
      pending.set(name, hosts)
    }
    hosts.add(el)
    // Behavior chunk not loaded yet → fetch it on demand, then mount this name.
    loadBehavior(name)
    return
  }
  let props: unknown = {}
  const rawProps = el.getAttribute('x-props')
  if (rawProps) {
    try {
      props = JSON.parse(rawProps)
    } catch {
      console.warn(`[brust] x-props on "${name}" is not valid JSON`)
    }
  }
  // Build the disposer set and register the element as mounted BEFORE invoking the
  // behavior, so (a) the ctx `effect`/`onCleanup` helpers can register teardown
  // (a ctx effect runs immediately during behavior(), pushing its disposer here),
  // and (b) a behavior that synchronously triggers a re-entrant mount of THIS
  // element (e.g. a ctx effect whose signal write reaches scanAndMount) hits the
  // `mounted.has(el)` guard above instead of creating a second, leaked Mounted.
  const m: Mounted = { disposers: [] }
  mounted.set(el, m)
  // ctxEffect/onCleanup typed via BehaviorCtx so the `void | Destructor` shape is
  // declared in one place (the interface) — no inline void-union to suppress here.
  const ctxEffect: BehaviorCtx<Element>['effect'] = (fn) => {
    const dispose = effect(fn)
    m.disposers.push(dispose)
    return dispose
  }
  const onCleanup: BehaviorCtx<Element>['onCleanup'] = (fn) => {
    m.disposers.push(fn)
  }
  const instance = behavior({ el, props, effect: ctxEffect, onCleanup })
  bindTree(el, instance, m.disposers)
  if (typeof instance.init === 'function') {
    try {
      Promise.resolve((instance.init as () => unknown)()).catch((e) =>
        console.error('[brust] x-data init() failed:', e),
      )
    } catch (e) {
      console.error('[brust] x-data init() threw:', e)
    }
  }
}

// Dynamically import a component's behavior chunk (once), then mount every pending
// element for that name. The chunk self-registers via the global register handle.
function loadBehavior(name: string): void {
  if (registry.has(name) || loading.has(name)) return
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    pending.delete(name)
    console.warn(`[brust] unsafe x-data component name "${name}" — not loaded`)
    return
  }
  // Promise.resolve().then(...) so a synchronous import() throw (e.g. happy-dom in
  // unit tests, or a bad specifier) becomes a rejection the .catch() handles.
  const p = Promise.resolve()
    .then(() => import(/* @vite-ignore */ `${CHUNK_BASE}${name}.directive.js`))
    .then(() => {
      if (!registry.has(name)) {
        loading.delete(name)
        pending.delete(name)
        console.warn(`[brust] "${name}.directive.js" loaded but did not register "${name}"`)
      }
    })
    .catch((e) => {
      loading.delete(name)
      pending.delete(name)
      console.error(`[brust] failed to load directive component "${name}":`, e)
    })
  loading.set(name, p)
}

// Bind this element's directives, then recurse — but never descend into a nested
// [x-data] (it owns its own subtree and is mounted independently). bindTree also
// does NOT descend into shadow roots of elements inside an x-data subtree: a
// shadow root is its own composition boundary — its x-data components mount
// independently via scanAndMount's shadow-root scan (R10), never inheriting the
// enclosing instance's scope. (The `el.children` walk below naturally excludes
// shadow content; this is by design, not an accident.)
function bindTree(el: Element, instance: Instance, disposers: Array<() => void>): void {
  // Coexistence check MUST precede the x-for early-exit, else x-for preempts and the
  // warn never fires. Strip x-if so x-for's template clones don't carry it either.
  if (el.hasAttribute('x-if') && el.hasAttribute('x-for')) {
    console.warn('[brust] x-if and x-for on the same element — x-if ignored; nest it instead')
    el.removeAttribute('x-if')
  }
  if (el.hasAttribute('x-for')) {
    bindFor(el, instance, disposers)
    return
  }
  if (el.hasAttribute('x-if')) {
    bindIf(el, instance, disposers)
    return
  }
  bindAttrs(el, instance, disposers)
  for (const child of Array.from(el.children)) {
    if (!(child instanceof Element)) continue
    if (child.hasAttribute('x-data')) continue
    bindTree(child, instance, disposers)
  }
}

export interface ForExpr {
  itemName: string
  indexName?: string
  listPath: string
  keyPaths?: string[]
}

const PATH_RE = /^[\w.]+$/
const ITEM_RE = /^(?:\(\s*(\w+)\s*,\s*(\w+)\s*\)|(\w+))$/

/** Parse an x-for expression. Grammar:
 *   (item[, index]) in listPath [by keyPath, keyPath, ...]
 * Returns null on malformed input (caller warns + skips). */
export function parseFor(raw: string): ForExpr | null {
  const trimmed = raw.trim()
  let head = trimmed
  let keyPart: string | undefined
  const byIdx = trimmed.search(/\sby\s/)
  if (byIdx !== -1) {
    head = trimmed.slice(0, byIdx)
    keyPart = trimmed.slice(byIdx + 4) // skip " by "
  }
  const m = /^(.*?)\s+in\s+(.+)$/.exec(head.trim())
  if (!m) return null
  const itemRaw = (m[1] as string).trim()
  const listPath = (m[2] as string).trim()
  if (!PATH_RE.test(listPath)) return null
  const im = ITEM_RE.exec(itemRaw)
  if (!im) return null
  const itemName = (im[1] ?? im[3]) as string
  const indexName = im[2] // undefined for the simple form
  let keyPaths: string[] | undefined
  if (keyPart !== undefined) {
    keyPaths = keyPart.split(',').map((s) => s.trim())
    if (keyPaths.length === 0 || keyPaths.some((p) => !PATH_RE.test(p))) return null
  }
  return { itemName, indexName, listPath, keyPaths }
}

interface ForEntry {
  node: Element
  itemSig: Signal<unknown>
  idxSig?: Signal<number>
  disposers: Array<() => void>
}

// One x-for mount per (parent, listPath): the SSR seed renders N sibling nodes
// each carrying x-for, and bindTree's parent loop visits every one — without this
// guard, bindFor would mount the list N times.
const forMountGuard = new WeakMap<Node, Set<string>>()

// `x-for="item in member"` — the element is the template. Replace it with a comment
// anchor. Without a `by` key clause this is a full re-render on each list change
// (legacy v1, now with optional plain index). With `by <keypath>...` it is an opt-in
// keyed reconcile that reuses DOM nodes (focus/scroll survive) and is reactive
// per-item via a per-clone `signal(item)` resolved through `read`'s unwrap-each-hop.
function bindFor(tplEl: Element, instance: Instance, disposers: Array<() => void>): void {
  const expr = parseFor(tplEl.getAttribute('x-for') ?? '')
  if (!expr) {
    console.warn(`[brust] malformed x-for expression: "${tplEl.getAttribute('x-for')}"`)
    return
  }
  const { itemName, indexName, listPath, keyPaths } = expr
  const parent = tplEl.parentNode
  if (!parent) return

  // Idempotency: the SSR seed renders N sibling x-for nodes; bindTree's parent loop
  // visits each. Mount the list ONCE per (parent, listPath); later siblings no-op.
  let mountedSet = forMountGuard.get(parent)
  if (!mountedSet) {
    mountedSet = new Set()
    forMountGuard.set(parent, mountedSet)
  }
  if (mountedSet.has(listPath)) return
  mountedSet.add(listPath)
  disposers.push(() => mountedSet?.delete(listPath)) // re-mount (SPA nav) works again

  // ---- SSR adopt: keyed x-for whose seed nodes were server-rendered ----
  if (keyPaths) {
    const seeds = collectSeeds(parent, keyPaths, tplEl.getAttribute('x-for') ?? '')
    if (seeds.length > 0) {
      bindForAdopt(seeds, instance, parent, expr, disposers)
      return
    }
  }

  const anchor = tplEl.ownerDocument.createComment(`x-for:${itemName}`)
  parent.insertBefore(anchor, tplEl)
  tplEl.removeAttribute('x-for')
  const template = tplEl.cloneNode(true) as Element
  tplEl.remove()

  // ---- legacy (no `by`) — full re-render, with optional plain index ----
  if (!keyPaths) {
    const rendered: Element[] = []
    const childDisposers: Array<() => void> = []
    const clear = () => {
      for (const d of childDisposers.splice(0)) {
        try {
          d()
        } catch {
          /* keep clearing */
        }
      }
      for (const node of rendered.splice(0)) node.remove()
    }
    disposers.push(
      effect(() => {
        clear()
        const list = read(instance, listPath)
        if (!Array.isArray(list)) return
        for (let i = 0; i < list.length; i++) {
          const clone = template.cloneNode(true) as Element
          const childScope: Instance = Object.create(instance)
          childScope[itemName] = list[i]
          if (indexName) childScope[indexName] = i
          bindTree(clone, childScope, childDisposers)
          parent.insertBefore(clone, anchor) // before anchor → preserves order
          rendered.push(clone)
        }
      }),
    )
    disposers.push(clear)
    return
  }

  // ---- keyed reconcile (client-only x-for: no SSR seed) ----
  installKeyedReconcile(instance, parent, expr, template, anchor, new Map(), disposers)
}

/** The 0.1.28 keyed reconcile, parameterized by an INITIAL `map` (empty for a
 *  client-only x-for; pre-populated with adopted SSR seeds for an SSR-seeded one)
 *  and a `template`/`anchor` already derived by the caller. */
function installKeyedReconcile(
  instance: Instance,
  parent: Node,
  expr: ForExpr,
  template: Element,
  anchor: Comment,
  initialMap: Map<string, ForEntry>,
  disposers: Array<() => void>,
): void {
  const { itemName, indexName, listPath, keyPaths } = expr
  const keys = keyPaths as string[] // keyed path → always defined
  let live = initialMap
  const disposeEntry = (e: ForEntry) => {
    for (const d of e.disposers.splice(0)) {
      try {
        d()
      } catch {
        /* keep tearing down */
      }
    }
    e.node.remove()
  }
  disposers.push(
    effect(() => {
      const list = read(instance, listPath) // tracks ONLY the list signal
      const arr = Array.isArray(list) ? list : []
      const next = new Map<string, ForEntry>()
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i]
        const probe: Instance = { [itemName]: item }
        if (indexName) probe[indexName] = i
        let key = keys.map((p) => String(resolveRaw(probe, p))).join('\x00')
        if (next.has(key)) {
          console.warn(`[brust] duplicate x-for key "${key}"`)
          key = `${key}\x00#${i}`
        }
        const existing = live.get(key)
        if (existing) {
          batch(() => {
            existing.itemSig.set(item)
            existing.idxSig?.set(i)
          })
          parent.insertBefore(existing.node, anchor)
          live.delete(key)
          next.set(key, existing)
        } else {
          const clone = template.cloneNode(true) as Element
          const itemSig = signal(item)
          const idxSig = indexName ? signal(i) : undefined
          const childScope: Instance = Object.create(instance)
          childScope[itemName] = itemSig
          if (indexName && idxSig) childScope[indexName] = idxSig
          const entryDisposers: Array<() => void> = []
          bindTree(clone, childScope, entryDisposers)
          parent.insertBefore(clone, anchor)
          next.set(key, { node: clone, itemSig, idxSig, disposers: entryDisposers })
        }
      }
      for (const e of live.values()) disposeEntry(e)
      live = next
    }),
  )
  disposers.push(() => {
    for (const e of live.values()) disposeEntry(e)
    live.clear()
  })
}

/** Direct-child seed nodes of THIS x-for (matched by the identical compiled
 *  `x-for` string) carrying the SSR key attr (single `data-x-key`, composite
 *  `data-x-key-0`). Only direct children — the key attr lives on the for-item
 *  root, never a descendant. The x-for match prevents a sibling x-for list under
 *  the same parent from having its seeds consumed by this one. */
function collectSeeds(parent: Node, keyPaths: string[], xforRaw: string): Element[] {
  const sel = keyPaths.length > 1 ? '[data-x-key-0]' : '[data-x-key]'
  const out: Element[] = []
  for (const c of Array.from((parent as Element).children ?? [])) {
    if (c instanceof Element && c.matches(sel) && c.getAttribute('x-for') === xforRaw) {
      out.push(c)
    }
  }
  return out
}

/** The seed's key from markup — must match the reconcile's computed key (single
 *  `data-x-key`, OR `data-x-key-*` joined with `\x00` IN JS — NUL never in HTML). */
function seedKey(node: Element, keyPaths: string[]): string {
  if (keyPaths.length > 1) {
    return keyPaths.map((_, i) => node.getAttribute(`data-x-key-${i}`) ?? '').join('\x00')
  }
  return node.getAttribute('data-x-key') ?? ''
}

function stripKeyAttrs(el: Element, keyPaths: string[]): void {
  if (keyPaths.length > 1) {
    for (let i = 0; i < keyPaths.length; i++) el.removeAttribute(`data-x-key-${i}`)
  } else {
    el.removeAttribute('data-x-key')
  }
}

/** Bind an adopted seed node as a plain subtree. The node KEEPS its x-for attr so
 *  the parent bindTree loop's later re-visit routes back to bindFor → mount guard
 *  no-ops; do NOT route the node itself through bindFor again here. */
function bindAdoptedNode(node: Element, scope: Instance, disposers: Array<() => void>): void {
  bindAttrs(node, scope, disposers)
  for (const child of Array.from(node.children)) {
    if (!(child instanceof Element)) continue
    if (child.hasAttribute('x-data')) continue
    bindTree(child, scope, disposers)
  }
}

/** Adopt SSR-seeded keyed x-for: reuse the seed nodes (identity preserved), seed
 *  each item-signal from the matching client item by key, wire reactivity, then
 *  hand the pre-populated map to the shared reconcile (first run = all reused). */
function bindForAdopt(
  seeds: Element[],
  instance: Instance,
  parent: Node,
  expr: ForExpr,
  disposers: Array<() => void>,
): void {
  const { itemName, indexName, listPath, keyPaths } = expr
  // Static fallback: a sugar-marked (or hand-written) x-for whose list has NO
  // backing signal on the instance must NOT reconcile — installKeyedReconcile would
  // wipe the SSR seeds on its first (empty-list) tick. resolveRaw returns the signal
  // OBJECT for a registered signal (truthy); undefined only when truly absent.
  if (resolveRaw(instance, listPath) == null) {
    return // leave the SSR seed nodes exactly as rendered (fully static)
  }
  const keys = keyPaths as string[]
  // template for future creates: stripped clone of the first seed.
  const template = seeds[0].cloneNode(true) as Element
  template.removeAttribute('x-for')
  stripKeyAttrs(template, keys)
  // anchor AFTER the last seed so future inserts keep document order.
  const last = seeds[seeds.length - 1]
  const anchor = last.ownerDocument.createComment(`x-for:${itemName}`)
  parent.insertBefore(anchor, last.nextSibling)
  // index the client list by key (same computation as the reconcile).
  const list = read(instance, listPath)
  const arr = Array.isArray(list) ? list : []
  const byKey = new Map<string, { item: unknown; idx: number }>()
  for (let i = 0; i < arr.length; i++) {
    const probe: Instance = { [itemName]: arr[i] }
    if (indexName) probe[indexName] = i
    const k = keys.map((p) => String(resolveRaw(probe, p))).join('\x00')
    if (!byKey.has(k)) byKey.set(k, { item: arr[i], idx: i })
  }
  // adopt each seed in place.
  const map = new Map<string, ForEntry>()
  for (let si = 0; si < seeds.length; si++) {
    const node = seeds[si] as Element
    let key = seedKey(node, keys)
    if (map.has(key)) {
      // mirror the reconcile's dup-key handling: suffix so the entry is tracked
      // (and disposed on the first reconcile, since no client item matches it).
      console.warn(`[brust] duplicate x-for seed key "${key}"`)
      key = `${key}\x00#${si}`
    }
    const match = byKey.get(key)
    const itemSig = signal(match ? match.item : undefined)
    const idxSig = indexName ? signal(match ? match.idx : 0) : undefined
    const childScope: Instance = Object.create(instance)
    childScope[itemName] = itemSig
    if (indexName && idxSig) childScope[indexName] = idxSig
    const entryDisposers: Array<() => void> = []
    bindAdoptedNode(node, childScope, entryDisposers)
    map.set(key, { node, itemSig, idxSig, disposers: entryDisposers })
  }
  installKeyedReconcile(instance, parent, expr, template, anchor, map, disposers)
}

/** `x-if="path"` — conditional MOUNT/UNMOUNT (vs x-show's display toggle). A comment
 * anchor marks the position; the element is captured as a template BEFORE the initial
 * evaluation. Truthy-initial ADOPTS the original in place (no re-clone — SSR markup
 * kept); falsy removes it. Each later falsy→truthy inserts a FRESH clone bound with
 * fresh per-clone disposers (the installKeyedReconcile pattern); truthy→falsy removes
 * the node and runs those disposers. The per-clone disposers cover only non-x-data
 * teardown (bindTree skips nested x-data); nested x-data dispose/mount is delegated
 * to the MutationObserver on removal/insert — single-owner discipline. */
function bindIf(el: Element, instance: Instance, disposers: Array<() => void>): void {
  const path = el.getAttribute('x-if') ?? ''
  const parent = el.parentNode
  if (!parent) return
  const anchor = el.ownerDocument.createComment('x-if')
  parent.insertBefore(anchor, el)
  el.removeAttribute('x-if')
  const template = el.cloneNode(true) as Element // capture FIRST (before initial effect)
  let current: Element | null = el // the original, adopted if initially truthy
  let bound = false // original starts unbound; clones are bound at creation
  const currentDisposers: Array<() => void> = []
  const teardown = () => {
    for (const d of currentDisposers.splice(0)) {
      try {
        d()
      } catch {
        // keep tearing down
      }
    }
    if (current) {
      current.remove() // nested x-data disposal delegated to the observer's disposeTree
      current = null
    }
  }
  disposers.push(
    effect(() => {
      const truthy = Boolean(read(instance, path))
      if (!truthy) {
        teardown()
        return
      }
      if (current) {
        if (!bound) {
          // initial truthy: adopt the original in place, no re-clone
          bindTree(current, instance, currentDisposers)
          bound = true
        }
        return
      }
      const clone = template.cloneNode(true) as Element
      bindTree(clone, instance, currentDisposers) // bind BEFORE insert (observer mounts nested x-data after)
      anchor.parentNode?.insertBefore(clone, anchor.nextSibling)
      current = clone
      bound = true
    }),
  )
  disposers.push(teardown)
}

// x-model targets that already warned "not a signal" — warn once per path, then skip.
const warnedModelPaths = new Set<string>()

/** Write `value` into the signal at `path`, unwrapping intermediate signal/computed
 * hops like `read()` (resolveRaw does NOT unwrap intermediates and cannot be the base
 * for multi-hop paths). The LEAF is never called: `isSignal(leaf)` → `.set(value)`,
 * else warn once and skip. */
export function writePath(scope: Instance, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur: unknown = scope
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null) break
    if (isSignal(cur) || isComputed(cur)) cur = (cur as () => unknown)()
    cur = (cur as Record<string, unknown>)[parts[i] as string]
  }
  let leaf: unknown
  if (cur != null) {
    if (isSignal(cur) || isComputed(cur)) cur = (cur as () => unknown)()
    leaf = (cur as Record<string, unknown>)[parts[parts.length - 1] as string]
  }
  if (isSignal(leaf)) {
    ;(leaf as Signal<unknown>).set(value)
    return
  }
  if (!warnedModelPaths.has(path)) {
    warnedModelPaths.add(path)
    console.warn(`[brust] x-model target "${path}" is not a signal — write skipped`)
  }
}

/** `x-model="path"` — two-way binding for form controls. Write side: checkbox/radio
 * on 'change' (checkbox → boolean checked; radio → its value when checked), everything
 * else (text/textarea/select-single/other inputs) → string value on 'input'. Read side:
 * one reflect effect per element with an echo guard (`el.value !== v`/`el.checked !== v`)
 * so a reflected write never loops (signal.set with an equal value is a no-op anyway).
 * `select[multiple]` is rejected at bind time with one warn — no listener. */
function bindModel(
  el: HTMLElement,
  scope: Instance,
  path: string,
  disposers: Array<() => void>,
): void {
  if (el.tagName === 'SELECT' && (el as HTMLSelectElement).multiple) {
    console.warn('[brust] x-model on select[multiple] is not supported — binding skipped')
    return
  }
  const input = el as HTMLInputElement
  const type = el.tagName === 'INPUT' ? (input.type ?? '').toLowerCase() : ''
  if (type === 'checkbox') {
    const onChange = () => writePath(scope, path, input.checked)
    el.addEventListener('change', onChange)
    disposers.push(() => el.removeEventListener('change', onChange))
    disposers.push(
      effect(() => {
        const v = Boolean(read(scope, path))
        if (input.checked !== v) input.checked = v
      }),
    )
    return
  }
  if (type === 'radio') {
    const onChange = () => {
      if (input.checked) writePath(scope, path, input.value)
    }
    el.addEventListener('change', onChange)
    disposers.push(() => el.removeEventListener('change', onChange))
    // Per-radio reflect: checked = (signalValue === el.value) — group consistency
    // falls out naturally, no special-casing.
    disposers.push(
      effect(() => {
        const on = read(scope, path) === input.value
        if (input.checked !== on) input.checked = on
      }),
    )
    return
  }
  // text/textarea/select(single)/other inputs → string value on 'input'
  const valueEl = el as unknown as { value: string }
  const onInput = () => writePath(scope, path, valueEl.value)
  el.addEventListener('input', onInput)
  disposers.push(() => el.removeEventListener('input', onInput))
  disposers.push(
    effect(() => {
      const v = read(scope, path)
      const s = v == null ? '' : String(v)
      if (valueEl.value !== s) valueEl.value = s
    }),
  )
}

function bindAttrs(el: Element, scope: Instance, disposers: Array<() => void>): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name
    const value = attr.value
    if (name === 'x-data' || name === 'x-props') continue
    if (name === 'x-model') {
      if (el instanceof HTMLElement) bindModel(el, scope, value, disposers)
      else console.warn('[brust] x-model is only supported on HTML elements — binding skipped')
      continue
    }
    if (name === 'x-text') {
      disposers.push(
        effect(() => {
          const v = read(scope, value)
          el.textContent = v == null ? '' : String(v)
        }),
      )
      continue
    }
    if (name === 'x-show') {
      disposers.push(
        effect(() => {
          if ('style' in el) {
            ;(el as Element & { style: CSSStyleDeclaration }).style.display = read(scope, value)
              ? ''
              : 'none'
          }
        }),
      )
      continue
    }
    if (name.startsWith('x-bind-')) {
      const target = name.slice('x-bind-'.length)
      disposers.push(
        effect(() => {
          setBound(el, target, read(scope, value))
        }),
      )
      continue
    }
    if (name.startsWith('x-on-')) {
      const eventName = name.slice('x-on-'.length)
      const handler = (e: Event) => callMethod(scope, value, e)
      el.addEventListener(eventName, handler)
      disposers.push(() => el.removeEventListener(eventName, handler))
    }
  }
}

// Roots that already have a mount/dispose observer attached (document.body +
// every discovered open shadow root). A WeakSet so a removed shadow root stays
// GC-collectable — its observer dies with it.
const observedRoots = new WeakSet<Node>()

/** Attach the mount/dispose MutationObserver to `root` (document.body or an
 * open ShadowRoot), once per root. Every observer runs the same callback:
 * dispose removed subtrees, scan added ones — and `scanAndMount`'s recursion
 * means a subtree added INSIDE a shadow root that itself hosts more shadow
 * roots gets those scanned and observed too. */
function observeRoot(root: Node): void {
  if (typeof MutationObserver === 'undefined') return
  if (observedRoots.has(root)) return
  observedRoots.add(root)
  const obs = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of Array.from(rec.removedNodes)) {
        if (node instanceof Element) disposeTree(node)
      }
      for (const node of Array.from(rec.addedNodes)) {
        if (node instanceof Element) scanAndMount(node)
      }
    }
  })
  obs.observe(root, { childList: true, subtree: true })
}

function disposeTree(node: Element): void {
  if (mounted.has(node)) disposeElement(node)
  for (const el of Array.from(node.querySelectorAll<Element>('[x-data]'))) {
    disposeElement(el)
  }
  // R10 — a removed HOST's shadow contents never reach any observer: the host's
  // removal fires on the light tree's observer, and the shadow root's own
  // observer only sees mutations INSIDE the root. Walk shadow roots explicitly.
  if (node.shadowRoot) disposeShadowContents(node.shadowRoot)
  for (const el of Array.from(node.querySelectorAll<Element>('*'))) {
    if (el.shadowRoot) disposeShadowContents(el.shadowRoot)
  }
}

function disposeShadowContents(root: ShadowRoot): void {
  for (const el of Array.from(root.querySelectorAll<Element>('[x-data]'))) {
    disposeElement(el)
  }
  for (const el of Array.from(root.querySelectorAll<Element>('*'))) {
    if (el.shadowRoot) disposeShadowContents(el.shadowRoot)
  }
}

function disposeElement(el: Element): void {
  const m = mounted.get(el)
  if (!m) return
  for (const d of m.disposers.splice(0)) {
    try {
      d()
    } catch {
      // disposer must not break sibling disposal
    }
  }
  mounted.delete(el)
}

const BOOL_PROPS = new Set(['disabled', 'checked', 'hidden', 'readonly', 'required', 'selected'])

/** Apply a bound value to a DOM attr/property. class → HTML className or a
 * namespace-safe attribute; boolean/value properties are used only when present. */
export function setBound(el: Element, attr: string, value: unknown): void {
  if (attr === 'class') {
    if (el instanceof HTMLElement) el.className = value == null ? '' : String(value)
    else if (value == null) el.removeAttribute('class')
    else el.setAttribute('class', String(value))
    return
  }
  if (attr === 'value') {
    if ('value' in el) (el as unknown as { value: unknown }).value = value == null ? '' : value
    else if (value == null) el.removeAttribute(attr)
    else el.setAttribute(attr, String(value))
    return
  }
  if (BOOL_PROPS.has(attr)) {
    const on = Boolean(value)
    if (attr in el) (el as unknown as Record<string, unknown>)[attr] = on
    if (on) el.setAttribute(attr, '')
    else el.removeAttribute(attr)
    return
  }
  if (value == null || value === false) el.removeAttribute(attr)
  else el.setAttribute(attr, String(value))
}

// --- reactive read helpers (used by later tasks) -------------------------------

/** Walk a dotted member path against `scope`, unwrapping a signal/computed at EVERY
 * hop (so an intermediate item-signal is tracked by `effect`); at the LEAF also call
 * a plain function to obtain its value (this read is what `effect` tracks). */
export function read(scope: Instance, path: string): unknown {
  let cur: unknown = scope
  for (const part of path.split('.')) {
    if (cur == null) return undefined
    // Unwrap a signal/computed BEFORE descending (intermediate hop) so reading
    // `item.name` calls the item signal here → effect() tracks it. Plain functions
    // are NOT called mid-path (only signal/computed), preserving x-on/method semantics.
    if (isSignal(cur) || isComputed(cur)) cur = (cur as () => unknown)()
    cur = (cur as Record<string, unknown>)[part]
  }
  if (isSignal(cur) || isComputed(cur)) return (cur as () => unknown)()
  if (typeof cur === 'function') return (cur as () => unknown)()
  return cur
}

/** Resolve a dotted path WITHOUT calling the leaf (for x-on handlers). */
export function resolveRaw(scope: Instance, path: string): unknown {
  let cur: unknown = scope
  for (const part of path.split('.')) {
    if (cur == null) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** Resolve `path` on `scope` and, if a function, call it with the event. */
export function callMethod(scope: Instance, path: string, event: Event): void {
  const fn = resolveRaw(scope, path)
  if (typeof fn === 'function') (fn as (e: Event) => unknown)(event)
  else console.warn(`[brust] x-on target "${path}" is not a function`)
}
