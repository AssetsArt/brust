// Directive runtime — react-free, dom-only. Scans the DOM for x-* directives and
// binds them to per-element component instances via brustjs/store's `effect`.
import { batch, effect, isComputed, isSignal, signal } from '../store/index.ts'
import type { Signal } from '../store/index.ts'

export type Instance = Record<string, unknown>
export type Behavior = (ctx: { el: HTMLElement; props: unknown }) => Instance

interface Mounted {
  disposers: Array<() => void>
}

const registry = new Map<string, Behavior>()
const mounted = new WeakMap<HTMLElement, Mounted>()
const loading = new Map<string, Promise<unknown>>()
let started = false

/** Per-component behavior chunk URL. Each native interactive component is built to
 * its OWN `<name>.directive.js` chunk (served from the islands static route) and
 * loaded ON DEMAND — only when an `x-data="<name>"` for it actually appears (initial
 * render OR after an SPA-nav swap). The chunk self-registers via the global below. */
const CHUNK_BASE = '/_brust/islands/'

/** Register a component behavior under `name`. Called by `<name>.directive.js` chunks
 * via the global handle below (they do NOT import this module — keeps each chunk to
 * just its behavior, with the runtime shared as the single `_directives.js` copy). */
export function register(name: string, behavior: Behavior): void {
  registry.set(name, behavior)
}
// Expose `register` on a global so dynamically-imported behavior chunks self-register
// into THIS runtime's registry without importing/duplicating the runtime. Symbol.for
// → shared across chunks (same rationale as the store's brands/reactive ctx).
;(globalThis as { [k: symbol]: unknown })[Symbol.for('brust.directive.register')] = register

/** Scan `root` (default: document) for [x-data], mount each, and (once) attach a
 * MutationObserver for dynamic mount/dispose. Idempotent. NOTE: `root` scopes the
 * INITIAL scan only; the observer always watches the global `document.body` (one
 * observer per document handles every later mount/dispose, incl. SPA-nav swaps). */
export function start(root?: ParentNode): void {
  const scope: ParentNode | undefined =
    root ?? (typeof document !== 'undefined' ? document : undefined)
  if (!scope) return
  const run = () => {
    scanAndMount(scope)
    if (!started) {
      started = true
      observe()
    }
  }
  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true })
  } else {
    run()
  }
}

function scanAndMount(scope: ParentNode): void {
  if (scope instanceof HTMLElement && scope.hasAttribute('x-data')) mountElement(scope)
  for (const el of Array.from(scope.querySelectorAll<HTMLElement>('[x-data]'))) {
    mountElement(el)
  }
}

function mountElement(el: HTMLElement): void {
  if (mounted.has(el)) return
  const name = el.getAttribute('x-data') ?? ''
  const behavior = registry.get(name)
  if (!behavior) {
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
  const instance = behavior({ el, props })
  const m: Mounted = { disposers: [] }
  mounted.set(el, m)
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
    console.warn(`[brust] unsafe x-data component name "${name}" — not loaded`)
    return
  }
  // Promise.resolve().then(...) so a synchronous import() throw (e.g. happy-dom in
  // unit tests, or a bad specifier) becomes a rejection the .catch() handles.
  const p = Promise.resolve()
    .then(() => import(/* @vite-ignore */ `${CHUNK_BASE}${name}.directive.js`))
    .then(() => {
      if (!registry.has(name)) {
        console.warn(`[brust] "${name}.directive.js" loaded but did not register "${name}"`)
        return
      }
      // Mount every element waiting on this name (initial + swapped-in).
      if (typeof document !== 'undefined') {
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[x-data="${name}"]`))) {
          mountElement(el)
        }
      }
    })
    .catch((e) => console.error(`[brust] failed to load directive component "${name}":`, e))
  loading.set(name, p)
}

// Bind this element's directives, then recurse — but never descend into a nested
// [x-data] (it owns its own subtree and is mounted independently).
function bindTree(el: HTMLElement, instance: Instance, disposers: Array<() => void>): void {
  if (el.hasAttribute('x-for')) {
    bindFor(el, instance, disposers)
    return
  }
  bindAttrs(el, instance, disposers)
  for (const child of Array.from(el.children)) {
    if (!(child instanceof HTMLElement)) continue
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
  node: HTMLElement
  itemSig: Signal<unknown>
  idxSig?: Signal<number>
  disposers: Array<() => void>
}

// `x-for="item in member"` — the element is the template. Replace it with a comment
// anchor. Without a `by` key clause this is a full re-render on each list change
// (legacy v1, now with optional plain index). With `by <keypath>...` it is an opt-in
// keyed reconcile that reuses DOM nodes (focus/scroll survive) and is reactive
// per-item via a per-clone `signal(item)` resolved through `read`'s unwrap-each-hop.
function bindFor(tplEl: HTMLElement, instance: Instance, disposers: Array<() => void>): void {
  const expr = parseFor(tplEl.getAttribute('x-for') ?? '')
  if (!expr) {
    console.warn(`[brust] malformed x-for expression: "${tplEl.getAttribute('x-for')}"`)
    return
  }
  const { itemName, indexName, listPath, keyPaths } = expr
  const parent = tplEl.parentNode
  if (!parent) return
  const anchor = tplEl.ownerDocument.createComment(`x-for:${itemName}`)
  parent.insertBefore(anchor, tplEl)
  tplEl.removeAttribute('x-for')
  const template = tplEl.cloneNode(true) as HTMLElement
  tplEl.remove()

  // ---- legacy (no `by`) — full re-render, with optional plain index ----
  if (!keyPaths) {
    const rendered: HTMLElement[] = []
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
          const clone = template.cloneNode(true) as HTMLElement
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

  // ---- keyed reconcile ----
  let map = new Map<string, ForEntry>()
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
        const probe: Instance = { [itemName]: item } // plain scope for key extraction
        if (indexName) probe[indexName] = i
        // resolveRaw (NOT read): never calls signal getters → the reconcile effect
        // tracks ONLY the list signal, even if a list item nests a signal on a key
        // path. Keys are plain identity data by contract; this just makes the
        // no-self-retrigger invariant hold unconditionally.
        let key = keyPaths.map((p) => String(resolveRaw(probe, p))).join('\x00')
        if (next.has(key)) {
          console.warn(`[brust] duplicate x-for key "${key}"`)
          key = `${key}\x00#${i}`
        }
        const existing = map.get(key)
        if (existing) {
          batch(() => {
            existing.itemSig.set(item)
            existing.idxSig?.set(i)
          })
          parent.insertBefore(existing.node, anchor) // move into new order
          map.delete(key)
          next.set(key, existing)
        } else {
          const clone = template.cloneNode(true) as HTMLElement
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
      for (const e of map.values()) disposeEntry(e) // not reused this pass → gone
      map = next
    }),
  )
  // component-unmount teardown of all live entries (mirrors legacy `clear`)
  disposers.push(() => {
    for (const e of map.values()) disposeEntry(e)
    map.clear()
  })
}

function bindAttrs(el: HTMLElement, scope: Instance, disposers: Array<() => void>): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name
    const value = attr.value
    if (name === 'x-data' || name === 'x-props') continue
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
          el.style.display = read(scope, value) ? '' : 'none'
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

function observe(): void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return
  if (!document.body) return // nothing to observe yet (called pre-<body>); start() re-runs on DOMContentLoaded
  const obs = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of Array.from(rec.removedNodes)) {
        if (node instanceof HTMLElement) disposeTree(node)
      }
      for (const node of Array.from(rec.addedNodes)) {
        if (node instanceof HTMLElement) scanAndMount(node)
      }
    }
  })
  obs.observe(document.body, { childList: true, subtree: true })
}

function disposeTree(node: HTMLElement): void {
  if (mounted.has(node)) disposeElement(node)
  for (const el of Array.from(node.querySelectorAll<HTMLElement>('[x-data]'))) {
    disposeElement(el)
  }
}

function disposeElement(el: HTMLElement): void {
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

/** Apply a bound value to a DOM attr/property. class → className; boolean props →
 * property (when present) + attribute presence; value → property; else attribute. */
export function setBound(el: HTMLElement, attr: string, value: unknown): void {
  if (attr === 'class') {
    el.className = value == null ? '' : String(value)
    return
  }
  if (attr === 'value') {
    ;(el as unknown as { value: unknown }).value = value == null ? '' : value
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
