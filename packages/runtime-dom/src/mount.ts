import { Instance, hooks, instances, nearestInstance } from './instance'
import { untracked } from './signal'
import { whenBehavior } from './registry'
import { bindHost } from './directives/index'
import { warnOnce } from './warn'
import { bindPropsFromParent } from './props-bind'
import './directives/register'   // Tasks 3–6 add binders here (file created in Task 3; create it empty now)

let observer: MutationObserver | null = null

function readProps(host: HTMLElement): Record<string, unknown> {
  const raw = host.getAttribute('x-props')
  if (!raw) return {}
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {} }
  catch { warnOnce(`j:${host.outerHTML.slice(0, 80)}`, `bad x-props JSON in ${host.getAttribute('x-data')}`); return {} }
}

function mountHost(host: HTMLElement): void {
  if (instances.has(host) || !host.isConnected) return
  const name = host.getAttribute('x-data')!
  whenBehavior(name, (factory) => {
    if (instances.has(host) || !host.isConnected) return
    const parent = nearestInstance(host)
    const inst = new Instance(host, name, parent, readProps(host))
    instances.set(host, inst)
    try { inst.init(factory) } catch (e) { console.error(`[brust] init threw: ${name}`, e); inst.dispose(); instances.delete(host); return }
    bindHost(inst, host, {})
    inst.booted = true
    bindPropsFromParent(inst)
    // Children that mounted before this instance existed (parent chunk arrived late) link up now.
    host.querySelectorAll<HTMLElement>('[x-data]').forEach((h) => {
      const child = instances.get(h)
      if (child && !child.parent && h.parentElement?.closest('[x-data]') === host) { child.parent = inst; inst.children.add(child); bindPropsFromParent(child) }
    })
  })
}

function mountTree(root: ParentNode): void {
  const hosts: HTMLElement[] = []
  if (root instanceof HTMLElement && root.hasAttribute('x-data')) hosts.push(root)
  root.querySelectorAll<HTMLElement>('[x-data]').forEach((h) => hosts.push(h))
  // document order = parents before children, so nearestInstance finds a mounted parent
  for (const h of hosts) mountHost(h)
}
hooks.mountTree = (root) => untracked(() => mountTree(root))

function disposeTree(root: Node): void {
  if (!(root instanceof Element)) return
  const hosts: Element[] = root.hasAttribute('x-data') ? [root] : []
  root.querySelectorAll('[x-data]').forEach((h) => hosts.push(h))
  for (const h of hosts) { const i = instances.get(h); if (i) { i.dispose(); instances.delete(h) } }
}

export function mount(root: ParentNode = document.body): void {
  // Observe first: binders (x-if, x-for) insert nested hosts during the initial pass.
  if (!observer) startObserver(root); else if (root !== observedRoot) observer.observe(root, { childList: true, subtree: true })
  mountTree(root)
}
let observedRoot: ParentNode | null = null
function startObserver(root: ParentNode): void {
  observedRoot = root
  observer = new MutationObserver((records) => {
    for (const r of records) {
      r.removedNodes.forEach((n) => { if (!n.isConnected) disposeTree(n) })
      r.addedNodes.forEach((n) => { if (n instanceof Element && n.isConnected) mountTree(n) })
    }
  })
  observer.observe(root, { childList: true, subtree: true })
}
export function unmount(root: ParentNode = document.body): void {
  if (root === observedRoot) { observer?.disconnect(); observer = null; observedRoot = null }
  disposeTree(root as Node)
}
