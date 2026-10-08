import { Instance } from './instance'
import { whenBehavior } from './registry'
import { bindHost } from './directives/index'
import { warnOnce } from './warn'
import './directives/register'   // Tasks 3–6 add binders here (file created in Task 3; create it empty now)

const instances = new WeakMap<Element, Instance>()
let observer: MutationObserver | null = null

export function instanceOf(el: Element): Instance | undefined { return instances.get(el) }
export function nearestInstance(el: Element): Instance | null {
  let p = el.parentElement
  while (p) { const i = instances.get(p); if (i) return i; p = p.parentElement }
  return null
}

function readProps(host: HTMLElement): Record<string, unknown> {
  const raw = host.getAttribute('x-props')
  if (!raw) return {}
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {} }
  catch { warnOnce(`props:${host.outerHTML.slice(0, 80)}`, `x-props is not valid JSON on <${host.tagName.toLowerCase()} x-data="${host.getAttribute('x-data')}">`); return {} }
}

function mountHost(host: HTMLElement): void {
  if (instances.has(host) || !host.isConnected) return
  const name = host.getAttribute('x-data')!
  whenBehavior(name, (factory) => {
    if (instances.has(host) || !host.isConnected) return
    const parent = nearestInstance(host)
    const inst = new Instance(host, name, parent, readProps(host))
    instances.set(host, inst)
    try { inst.init(factory) } catch (e) { console.error(`[brust] behavior "${name}" threw during init`, e); inst.dispose(); instances.delete(host); return }
    bindHost(inst, host, {})
    bindPropsFromParent(inst)   // Task 6 fills this in; no-op until then
  })
}

export let bindPropsFromParent: (inst: Instance) => void = () => {}
export function _setBindPropsFromParent(f: (inst: Instance) => void): void { bindPropsFromParent = f }

function mountTree(root: ParentNode): void {
  const hosts: HTMLElement[] = []
  if (root instanceof HTMLElement && root.hasAttribute('x-data')) hosts.push(root)
  root.querySelectorAll<HTMLElement>('[x-data]').forEach((h) => hosts.push(h))
  // document order = parents before children, so nearestInstance finds a mounted parent
  for (const h of hosts) mountHost(h)
}
function disposeTree(root: Node): void {
  if (!(root instanceof Element)) return
  const hosts: Element[] = root.hasAttribute('x-data') ? [root] : []
  root.querySelectorAll('[x-data]').forEach((h) => hosts.push(h))
  for (const h of hosts) { const i = instances.get(h); if (i) { i.dispose(); instances.delete(h) } }
}

export function mount(root: ParentNode = document.body): void {
  // Observe first: binders (x-if, x-for) insert nested hosts during the initial pass.
  if (!observer) startObserver(root)
  mountTree(root)
}
function startObserver(root: ParentNode): void {
  observer = new MutationObserver((records) => {
    for (const r of records) {
      r.removedNodes.forEach((n) => { if (!n.isConnected) disposeTree(n) })
      r.addedNodes.forEach((n) => { if (n instanceof Element && n.isConnected) mountTree(n) })
    }
  })
  observer.observe(root, { childList: true, subtree: true })
}
export function unmount(root: ParentNode = document.body): void {
  observer?.disconnect(); observer = null
  disposeTree(root as Node)
}
