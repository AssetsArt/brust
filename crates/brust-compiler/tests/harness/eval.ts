// Dual-evaluation harness (spec §6.3), driven by tests/dual_eval.rs.
//
//   bun eval.ts slots <job.server.ts> <props.json>   → precompute(props) as JSON
//   bun eval.ts check <dir> <page.html>              → { checked, mismatches }
//
// `check` loads the server-rendered HTML into happy-dom, imports every
// `*.client.js` in <dir> (they import ./rt.ts, which captures the factories),
// instantiates each host's behavior in document order with the props the
// runtime would give it (x-props, or the parent member named by
// x-props-bind), and compares every x-text / x-bind-* / x-if / x-model value
// with what the server painted. Hidden templates are skipped.
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { captured } from './rt.ts'
import { signal } from '../../../../packages/runtime-dom/src/index.ts'

const repo = resolve(import.meta.dir, '../../../..')
const { Window } = await import(Bun.resolveSync('happy-dom', join(repo, 'packages/runtime-dom')))

const [cmd, a, b] = process.argv.slice(2)

if (cmd === 'slots') {
  const job = await import(resolve(a!))
  const props = JSON.parse(await Bun.file(b!).text())
  console.log(JSON.stringify(job.precompute(props)))
  process.exit(0)
}

type Members = Record<string, unknown>
const BOOLEAN = new Set(['disabled', 'checked', 'selected', 'readonly', 'required', 'hidden', 'open', 'multiple'])

for (const f of readdirSync(a!).sort()) if (f.endsWith('.client.js')) await import(join(resolve(a!), f))
const win = new Window()
const doc = win.document
doc.body.innerHTML = await Bun.file(b!).text()

const instances = new Map<unknown, Members>()
const listsChecked = new WeakMap<Element, Set<string>>()
const mismatches: string[] = []
let checked = 0

const isHost = (el: Element) => el.hasAttribute('x-data')
function hostOf(el: Element | null): Element | null {
  for (let e = el; e; e = e.parentElement) if (isHost(e)) return e
  return null
}
function hidden(el: Element, stop: Element | null): boolean {
  for (let e: Element | null = el; e; e = e.parentElement) {
    if (e.hasAttribute('hidden')) return true
    if (e === stop) break
  }
  return false
}
const value = (v: unknown, args: unknown[] = []) =>
  typeof v === 'function' ? (v as (...x: unknown[]) => unknown)(...args) : v

// Verbatim from packages/runtime-dom/src/directives/for.ts:9 (`SYNTAX`); keep in sync.
const FOR_SYNTAX = /^\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*))?\s+in\s+([A-Za-z_$][\w$.]*(?::[A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)?)\s+by\s+([A-Za-z_$][\w$.]*)\s*$/

function scopeOf(el: Element, host: Element | null, members: Members): Record<string, unknown> {
  // Rows from the outermost in: an inner source may read an outer binding.
  const rows: Element[] = []
  for (let e: Element | null = el; e && e !== host?.parentElement; e = e.parentElement) {
    if (e.hasAttribute('x-for')) rows.unshift(e)
  }
  const scope: Record<string, unknown> = {}
  for (const e of rows) {
    const raw = e.getAttribute('x-for')!
    const m = FOR_SYNTAX.exec(raw); if (!m) throw new Error(`x-for not parseable: ${raw}`)
    const same = Array.from(e.parentElement!.children).filter((c) => c.getAttribute('x-for') === raw && !c.hasAttribute('hidden'))
    const list = resolveDirective(members, m[3]!, scope) as unknown[]
    const k = same.indexOf(e)
    scope[m[1]!] = list?.[k]
    if (m[2]) scope[m[2]] = k
  }
  return scope
}
function lookup(members: Members, path: string): unknown {
  let v: unknown = members
  for (const p of path.split('.')) v = v == null ? undefined : (value(v) as Members)[p]
  return v
}
function resolveDirective(members: Members, raw: string, scope: Record<string, unknown>): unknown {
  const [path, binds] = raw.split(':') as [string, string | undefined]
  const m = lookup(members, path)
  if (binds) return (m as (...x: unknown[]) => unknown)(...binds.split(',').map((n) => scope[n.trim()]))
  return value(m)
}
// Exactly what the runtime binders write (directives/text.ts, bind.ts): the
// compiler, not the harness, must make the client agree with the paint.
const textOf = (v: unknown): string => (v == null ? '' : String(v))

for (const host of Array.from(doc.querySelectorAll('[x-data]')) as Element[]) {
  const parentHost = hostOf(host.parentElement)
  if (hidden(host, null)) continue
  const name = host.getAttribute('x-data')!
  const factory = captured.get(name)
  if (!factory) { mismatches.push(`${name}: no chunk`); continue }
  let props: unknown = {}
  const xp = host.getAttribute('x-props')
  if (xp != null) { try { props = JSON.parse(xp) } catch { mismatches.push(`${name}: x-props is not JSON: ${xp}`) } }
  const bind = host.getAttribute('x-props-bind')
  if (bind && parentHost) {
    const pm = instances.get(parentHost)!
    props = resolveDirective(pm, bind, scopeOf(host, parentHost, pm))
  }
  const members = (factory({ el: host, props: signal(props), effect: () => () => {}, onCleanup() {}, ref: () => ({ current: null }) }) ?? {}) as Members
  instances.set(host, members)
  for (const el of [host, ...(Array.from(host.querySelectorAll('*')) as Element[])]) {
    if (hostOf(el) !== host) continue
    // One check per x-for source: the server-painted rows (not the hidden template) must number what the client list holds.
    const forRaw = el.getAttribute('x-for')
    const parent = el.parentElement
    if (forRaw && parent && !hidden(parent, host) && !listsChecked.get(parent)?.has(forRaw)) {
      listsChecked.set(parent, (listsChecked.get(parent) ?? new Set()).add(forRaw))
      const fm = FOR_SYNTAX.exec(forRaw); if (!fm) throw new Error(`x-for not parseable: ${forRaw}`)
      const painted = Array.from(parent.children).filter((c) => c.getAttribute('x-for') === forRaw && !c.hasAttribute('hidden')).length
      const list = resolveDirective(members, fm[3]!, scopeOf(parent, host, members))
      checked++
      if (!Array.isArray(list)) mismatches.push(`${name} <${el.tagName.toLowerCase()} x-for="${forRaw}">: client source is not a list`)
      else if (list.length !== painted) mismatches.push(`${name} <${el.tagName.toLowerCase()} x-for="${forRaw}">: server painted ${painted} rows, client list has ${list.length}`)
    }
    if (hidden(el, host)) {
      // The template of an x-if the server rendered false: the client agrees.
      const raw = el.getAttribute('x-if')
      if (raw && el.hasAttribute('hidden') && !(el.parentElement && hidden(el.parentElement, host))) {
        checked++
        if (resolveDirective(members, raw, scopeOf(el, host, members)))
          mismatches.push(`${name} <${el.tagName.toLowerCase()} x-if="${raw}" hidden>: server false, client true`)
      }
      continue
    }
    const scope = scopeOf(el, host, members)
    for (const at of Array.from(el.attributes) as Attr[]) {
      const where = `${name} <${el.tagName.toLowerCase()} ${at.name}="${at.value}">`
      if (at.name === 'x-text') {
        checked++
        const want = textOf(resolveDirective(members, at.value, scope))
        if (el.textContent !== want) mismatches.push(`${where}: painted ${JSON.stringify(el.textContent)}, client ${JSON.stringify(want)}`)
      } else if (at.name.startsWith('x-bind-')) {
        checked++
        const attr = at.name.slice(7)
        const v = resolveDirective(members, at.value, scope)
        const got = el.getAttribute(attr)
        // class → className = String(v) (an absent class reads as '').
        const want = attr === 'class' ? textOf(v)
          : BOOLEAN.has(attr) ? (v ? '' : null)
          : v == null || v === false ? null : String(v)
        const gotNorm = attr === 'class' ? (got ?? '') : BOOLEAN.has(attr) ? (got == null ? null : '') : got
        if (gotNorm !== want) mismatches.push(`${where}: painted ${JSON.stringify(got)}, client ${JSON.stringify(want)}`)
      } else if (at.name === 'x-if') {
        checked++
        if (!resolveDirective(members, at.value, scope)) mismatches.push(`${where}: painted, client false`)
      } else if (at.name === 'x-model') {
        checked++
        const v = value(lookup(members, at.value))
        const ok = typeof v === 'boolean' ? el.hasAttribute('checked') === v : (el.getAttribute('value') ?? '') === String(v ?? '')
        if (!ok) mismatches.push(`${where}: painted ${JSON.stringify(el.getAttribute('value'))}, client ${JSON.stringify(v)}`)
      }
    }
  }
}
console.log(JSON.stringify({ checked, mismatches }))
