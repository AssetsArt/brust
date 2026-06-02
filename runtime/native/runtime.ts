// Directive runtime — react-free, dom-only. Scans the DOM for x-* directives and
// binds them to per-element component instances via brustjs/store's `effect`.
import { effect, isComputed, isSignal } from 'brustjs/store'

export type Instance = Record<string, unknown>
export type Behavior = (ctx: { el: HTMLElement; props: unknown }) => Instance

interface Mounted {
  disposers: Array<() => void>
}

const registry = new Map<string, Behavior>()
const mounted = new WeakMap<HTMLElement, Mounted>()
let started = false

/** Register a component behavior under `name` (called by the generated entry). */
export function register(name: string, behavior: Behavior): void {
  registry.set(name, behavior)
}

/** Scan `root` (default: document) for [x-data], mount each, and (once) attach a
 * MutationObserver for dynamic mount/dispose. Idempotent. */
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
    console.warn(`[brust] unknown x-data component "${name}"`)
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

const FOR_RE = /^\s*(\w+)\s+in\s+([\w.]+)\s*$/

// `x-for="item in member"` — the element is the template. Replace it with a comment
// anchor; on each change of `member`, clear previous clones and render one per item,
// binding each clone with a child scope { [item]: value } prototype-linked to the
// instance (so instance members + methods stay visible). v1 = full re-render.
function bindFor(tplEl: HTMLElement, instance: Instance, disposers: Array<() => void>): void {
  const raw = tplEl.getAttribute('x-for') ?? ''
  const m = FOR_RE.exec(raw)
  if (!m) {
    console.warn(`[brust] malformed x-for expression: "${raw}"`)
    return
  }
  const itemName = m[1] as string
  const listPath = m[2] as string
  const parent = tplEl.parentNode
  if (!parent) return
  const anchor = tplEl.ownerDocument.createComment(`x-for:${itemName}`)
  parent.insertBefore(anchor, tplEl)
  tplEl.removeAttribute('x-for')
  const template = tplEl.cloneNode(true) as HTMLElement
  tplEl.remove()

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
      for (const item of list) {
        const clone = template.cloneNode(true) as HTMLElement
        const childScope: Instance = Object.create(instance)
        childScope[itemName] = item
        bindTree(clone, childScope, childDisposers)
        parent.insertBefore(clone, anchor) // before anchor → preserves order
        rendered.push(clone)
      }
    }),
  )
  disposers.push(clear)
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

/** Walk a dotted member path against `scope`; at the LEAF, call signals/computeds/
 * functions to obtain the reactive value (this read is what `effect` tracks). */
export function read(scope: Instance, path: string): unknown {
  let cur: unknown = scope
  for (const part of path.split('.')) {
    if (cur == null) return undefined
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
