// `<brust-devtools>` (L15): the browser overlay of `brust dev`. Served by the dev proxy as `/_brust/dev/devtools.js`
// (bundled from this file on first request) and injected by it into HTML responses: nothing of it exists under
// `brust start` or in a production build. Everything it shows comes from the trace (`#__brust_trace`,
// `/_brust/dev/traces`), `dev.json` (`/_brust/dev/meta`), the DOM or the dev global (`__brustDev`): nothing is invented.
// It lives in a shadow root: no style leaks either way.

import { tierCounts, type Tier } from './devtools-data'
interface Diag { class: string; rule: string; line: number; col: number; message: string; remediation: string }
export interface DevComponent { file: string; tier: Tier; reason?: string; diagnostics: Diag[] }
interface DevMeta { components?: Record<string, DevComponent> }
interface TraceJob { call_id: string; kind: string; component_id: string; user_key: string | null; tags: string[]; hit: boolean }
interface Trace {
  route: { id: string; pattern: string; chain: string[]; params: Record<string, string> } | null
  status: number
  cache: string
  loader_ms: number | null
  render_ms: number | null
  render_error: string | null
  bun_calls: number
  jobs: TraceJob[]
  jobs_more: number
  rendered: string[]
  truncated?: boolean
}
interface Entry { id: number; at: number; kind: string; method: string; path: string; status: number; ms: number; trace: Trace | null }
interface BuildState { state: 'building' | 'ready' | 'error'; gen: number; diag: { rule: string; file?: string; line?: number; col?: number; message: string } | null }

const TABS = ['Page', 'Components', 'Jobs', 'Store', 'Islands', 'Build', 'Requests'] as const
type TabName = (typeof TABS)[number]

const CSS = `
:host { all: initial; position: fixed; width: 0; height: 0; --bg: #ffffff; --fg: #1a1a1f; --muted: #4a4a55; --line: #c9c9d2; --accent: #0b57d0; --accent-fg: #ffffff;
  --static: #0b6b3a; --native: #0b57d0; --react: #8a3b00; --err: #b3261e; --warn: #7a5300; --hl: rgba(11, 87, 208, .25); }
@media (prefers-color-scheme: dark) { :host { --bg: #1b1b1f; --fg: #f2f2f5; --muted: #c4c4cf; --line: #4a4a55; --accent: #8ab4f8; --accent-fg: #0a0a0c;
  --static: #6ee7a8; --native: #8ab4f8; --react: #ffb27a; --err: #ff8a80; --warn: #ffd180; --hl: rgba(138, 180, 248, .3); } }
* { box-sizing: border-box; }
button { font: inherit; color: inherit; }
.ind { position: fixed; right: 12px; bottom: 12px; z-index: 2147483646; display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-radius: 999px;
  background: var(--bg); color: var(--fg); border: 1px solid var(--line); font: 12px/1.2 ui-monospace, Menlo, monospace; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
.ind:focus-visible, .tab:focus-visible, .x:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--static); }
.dot.building { background: var(--warn); } .dot.error { background: var(--err); }
.panel { position: fixed; right: 12px; bottom: 52px; z-index: 2147483646; width: min(560px, calc(100vw - 24px)); max-height: min(70vh, 560px); display: flex; flex-direction: column;
  background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 8px; font: 12px/1.45 ui-monospace, Menlo, monospace; box-shadow: 0 6px 24px rgba(0,0,0,.35); }
.panel[hidden] { display: none; }
.bar { display: flex; align-items: center; border-bottom: 1px solid var(--line); }
.tabs { display: flex; flex: 1; overflow-x: auto; }
.tab { padding: 8px 10px; background: none; border: 0; border-bottom: 2px solid transparent; cursor: pointer; color: var(--muted); }
.tab[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent); }
.x { padding: 6px 10px; background: none; border: 0; cursor: pointer; color: var(--muted); }
.body { padding: 10px; overflow: auto; }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
.b { display: inline-block; padding: 0 6px; border-radius: 4px; border: 1px solid currentColor; font-weight: 700; }
.b.static { color: var(--static); } .b.native { color: var(--native); } .b.react { color: var(--react); }
.err { color: var(--err); } .warn { color: var(--warn); } .muted { color: var(--muted); }
ul.tree { list-style: none; margin: 0; padding-left: 14px; } ul.tree.root { padding-left: 0; }
.node { padding: 2px 4px; border-radius: 4px; cursor: default; } .node:hover, .node:focus { background: var(--hl); outline: none; }
.hl { position: fixed; z-index: 2147483645; pointer-events: none; background: var(--hl); border: 2px solid var(--accent); border-radius: 3px; }
code { font: inherit; } h3 { margin: 0 0 6px; font-size: 12px; }
`

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  for (const k of kids) e.append(k)
  return e
}
const badge = (t: Tier | 'unknown') => el('span', { class: `b ${t}` }, t)
const ms = (n: number | null | undefined) => (typeof n === 'number' ? `${n.toFixed(2)} ms` : '—')

class BrustDevtools extends HTMLElement {
  private root = this.attachShadow({ mode: 'open' })
  private ind!: HTMLButtonElement
  private panel!: HTMLElement
  private body!: HTMLElement
  private tabs: HTMLButtonElement[] = []
  private hl = el('div', { class: 'hl', hidden: '' })
  private tab: TabName = 'Page'
  private opener: Element | null = null
  private meta: DevMeta | null = null
  private entries: Entry[] = []
  private build: BuildState = { state: 'building', gen: 0, diag: null }
  private trace: Trace | null = null

  connectedCallback(): void {
    this.trace = readTrace()
    const style = el('style'); style.textContent = CSS
    this.ind = el('button', { class: 'ind', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': 'brust devtools' })
    this.panel = el('div', { class: 'panel', role: 'dialog', 'aria-label': 'brust devtools', hidden: '' })
    const tablist = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'devtools panels' })
    for (const t of TABS) {
      const b = el('button', { class: 'tab', type: 'button', role: 'tab', id: `tab-${t}`, 'aria-selected': 'false', tabindex: '-1', 'aria-controls': 'body' }, t)
      b.onclick = () => this.select(t)
      this.tabs.push(b); tablist.append(b)
    }
    const close = el('button', { class: 'x', type: 'button', 'aria-label': 'Close devtools' }, '✕')
    close.onclick = () => this.close()
    this.body = el('div', { class: 'body', id: 'body', role: 'tabpanel' })
    this.panel.append(el('div', { class: 'bar' }, tablist, close), this.body)
    this.root.append(style, this.hl, this.ind, this.panel)
    this.ind.onclick = () => this.toggle()
    tablist.onkeydown = (e) => this.tabKeys(e)
    this.panel.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.close() } }
    window.addEventListener('keydown', (e) => { if (e.altKey && e.shiftKey && (e.key === 'B' || e.key === 'b' || e.code === 'KeyB')) { e.preventDefault(); this.toggle() } })
    this.paintIndicator()
    void this.loadMeta()
    this.connect()
  }

  private async loadMeta(): Promise<void> {
    try { this.meta = (await (await fetch('/_brust/dev/meta')).json()) as DevMeta } catch { this.meta = null }
    this.paintIndicator()
    if (!this.panel.hidden) this.render()
  }

  private async loadEntries(): Promise<void> {
    try { this.entries = ((await (await fetch('/_brust/dev/traces')).json()) as { traces: Entry[] }).traces } catch { this.entries = [] }
  }

  private connect(): void {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/_brust/dev/ws`)
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as { type: string; gen?: number; state?: BuildState['state']; diag?: BuildState['diag'] }
      if (m.type === 'hello') this.build = { state: m.state ?? 'ready', gen: m.gen ?? 0, diag: m.diag ?? null }
      else if (m.type === 'error') this.build = { state: 'error', gen: this.build.gen, diag: m.diag ?? null }
      else return
      this.paintIndicator()
      if (!this.panel.hidden && this.tab === 'Build') this.render()
    }
    ws.onclose = () => setTimeout(() => this.connect(), 1000)
  }

  private counts(): Record<Tier, number> { return tierCounts(this.trace?.rendered ?? [], this.meta) }

  private paintIndicator(): void {
    const c = this.counts()
    this.ind.replaceChildren(el('span', { class: `dot ${this.build.state}`, 'aria-hidden': 'true' }), `${this.build.state} · ${c.static}s ${c.native}n ${c.react}r`)
    this.ind.setAttribute('data-state', this.build.state)
    this.ind.title = `static ${c.static} · native ${c.native} · react ${c.react} (Alt+Shift+B)`
  }

  toggle(): void { if (this.panel.hidden) this.open(); else this.close() }

  open(): void {
    this.opener = deepActive()
    this.panel.hidden = false
    this.ind.setAttribute('aria-expanded', 'true')
    void this.loadEntries().then(() => { if (this.tab === 'Requests') this.render() })
    this.select(this.tab)
    this.tabs[TABS.indexOf(this.tab)]?.focus()
  }

  close(): void {
    this.panel.hidden = true
    this.hl.hidden = true
    this.ind.setAttribute('aria-expanded', 'false')
    const back = this.opener instanceof HTMLElement && this.opener !== document.body && this.opener.isConnected && !this.contains(this.opener) ? this.opener : this.ind
    back.focus()
  }

  private tabKeys(e: KeyboardEvent): void {
    const i = TABS.indexOf(this.tab)
    const to = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1
    if (to < 0) return
    e.preventDefault()
    this.select(TABS[to] as TabName)
    this.tabs[to]?.focus()
  }

  private select(t: TabName): void {
    this.tab = t
    this.tabs.forEach((b, i) => { const on = TABS[i] === t; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1 })
    this.body.setAttribute('aria-labelledby', `tab-${t}`)
    this.render()
  }

  private render(): void {
    const t = this.trace
    const kids: Node[] = []
    switch (this.tab) {
      case 'Page': kids.push(this.pagePanel(t)); break
      case 'Components': kids.push(this.componentsPanel(t)); break
      case 'Jobs': kids.push(this.jobsPanel(t)); break
      case 'Store': kids.push(this.storePanel()); break
      case 'Islands': kids.push(this.islandsPanel()); break
      case 'Build': kids.push(this.buildPanel()); break
      case 'Requests': kids.push(this.requestsPanel()); break
    }
    this.body.replaceChildren(...kids)
  }

  private kv(rows: [string, string | Node][]): HTMLElement {
    const tb = el('table')
    for (const [k, v] of rows) tb.append(el('tr', {}, el('th', { scope: 'row' }, k), el('td', {}, v)))
    return tb
  }

  private pagePanel(t: Trace | null): Node {
    if (!t?.route) return el('p', { class: 'muted' }, 'No trace for this page (not served through a traced core, or the route did not match).')
    const params = Object.entries(t.route.params)
    return this.kv([
      ['route', `${t.route.id}  ${t.route.pattern}`],
      ['params', params.length ? params.map(([k, v]) => `${k}=${v}`).join(', ') : '—'],
      ['status', String(t.status)],
      ['cache', t.cache === '-' ? 'none (this route has no cache)' : t.cache],
      ['loader', ms(t.loader_ms)],
      ['render', ms(t.render_ms)],
      ['worker calls', String(t.bun_calls)],
      ['render error', t.render_error ?? '—'],
      ...(t.truncated ? ([['trace', 'truncated to fit the header']] as [string, string][]) : []),
    ])
  }

  private componentsPanel(t: Trace | null): Node {
    const chain = t?.route?.chain ?? []
    if (chain.length === 0) return el('p', { class: 'muted' }, 'No component data for this page.')
    const extras = (t?.rendered ?? []).filter((id) => !chain.includes(id))
    const node = (id: string, nested: Node | null): HTMLElement => {
      const c = this.meta?.components?.[id]
      const row = el('div', { class: 'node', tabindex: '0', 'data-component': id }, badge(c?.tier ?? 'unknown'), ' ', el('code', {}, id), c ? el('span', { class: 'muted' }, `  ${c.file}`) : '')
      if (c?.tier === 'react') {
        row.append(el('div', { class: 'muted' }, `reason: ${c.reason ?? '—'}`))
        for (const d of c.diagnostics.filter((x) => x.class !== 'error')) row.append(el('div', { class: 'warn' }, `${c.file}:${d.line}:${d.col} ${d.rule}`))
      }
      const on = () => this.highlight(id)
      row.onmouseenter = on; row.onfocus = on
      row.onmouseleave = () => { this.hl.hidden = true }; row.onblur = () => { this.hl.hidden = true }
      const li = el('li', {}, row)
      if (nested) li.append(nested)
      return li
    }
    let tree: Node | null = null
    for (const id of [...chain].reverse()) tree = el('ul', { class: 'tree' }, node(id, tree))
    const rootList = el('ul', { class: 'tree root' })
    rootList.append(...(tree ? [...tree.childNodes] : []))
    const out = el('div', {}, rootList)
    if (extras.length) out.append(el('h3', {}, 'Also on the page (children)'), el('ul', { class: 'tree root' }, ...extras.map((id) => node(id, null))))
    return out
  }

  /** Highlight a component on the page: chain marker (Range between `<!--brust-l:id:hash-->` and `<!--/brust-l:id-->`, the root is the whole document), native `[x-data]`, island `brust-island`. */
  private highlight(id: string): void {
    const rects = componentRects(id)
    if (rects.length === 0) { this.hl.hidden = true; return }
    const r = rects[0] as DOMRect
    Object.assign(this.hl.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
    this.hl.hidden = false
  }

  private jobsPanel(t: Trace | null): Node {
    if (!t) return el('p', { class: 'muted' }, 'No trace for this page.')
    if (t.jobs.length === 0) return el('p', { class: 'muted' }, t.cache === 'HIT' ? 'A cache HIT: no jobs ran.' : 'No jobs on this page.')
    const tb = el('table', {}, el('tr', {}, ...['call', 'kind', 'result', 'key / tags'].map((h) => el('th', {}, h))))
    for (const j of t.jobs) tb.append(el('tr', {}, el('td', {}, j.call_id), el('td', {}, j.kind), el('td', {}, j.hit ? 'hit' : 'miss'), el('td', {}, [j.user_key, ...j.tags].filter(Boolean).join(', ') || '—')))
    const out = el('div', {}, tb)
    if (t.jobs_more) out.append(el('p', { class: 'muted' }, `+${t.jobs_more} more not listed`))
    return out
  }

  private storePanel(): Node {
    const seeds = [...document.querySelectorAll('script[data-brust-store]')]
    if (seeds.length === 0) return el('p', { class: 'muted' }, 'No stores on this page.')
    const reg = (globalThis as Record<symbol, Record<string, { instance: Record<string, unknown> }> | undefined>)[Symbol.for('brust.stores')]
    const out = el('div')
    for (const s of seeds) {
      const name = s.getAttribute('data-brust-store') ?? '?'
      let seed: unknown = null
      try { seed = JSON.parse(s.textContent ?? 'null') } catch { seed = s.textContent }
      out.append(el('h3', {}, name), this.kv([['seed (SSR)', JSON.stringify(seed)], ['live', reg?.[name] ? JSON.stringify(liveValues(reg[name].instance)) : 'not mounted natively (no native component read it)']]))
    }
    return out
  }

  private islandsPanel(): Node {
    const islands = [...document.querySelectorAll('brust-island')]
    if (islands.length === 0) return el('p', { class: 'muted' }, 'No React islands on this page.')
    const tb = el('table', {}, el('tr', {}, ...['island', 'hydrated'].map((h) => el('th', {}, h))))
    for (const i of islands) tb.append(el('tr', {}, el('td', {}, i.getAttribute('data-id') ?? '?'), el('td', { class: i.getAttribute('data-hydrated') === '1' ? '' : 'warn' }, i.getAttribute('data-hydrated') === '1' ? 'yes' : 'no')))
    return tb
  }

  private buildPanel(): Node {
    const out = el('div', {}, el('p', {}, `build: ${this.build.state} (generation ${this.build.gen})`))
    const d = this.build.diag
    if (d) out.append(el('p', { class: 'err' }, `${d.rule}${d.file ? ` ${d.file}${d.line ? `:${d.line}${d.col ? `:${d.col}` : ''}` : ''}` : ''} ${d.message}`))
    const rows: Node[] = []
    for (const [id, c] of Object.entries(this.meta?.components ?? {})) {
      for (const x of c.diagnostics) rows.push(el('tr', {}, el('td', { class: x.class === 'error' ? 'err' : 'warn' }, x.class), el('td', {}, `${c.file}:${x.line}:${x.col}`), el('td', {}, x.rule), el('td', {}, x.message + (x.remediation ? ` — ${x.remediation}` : '')), el('td', { class: 'muted' }, id)))
    }
    if (rows.length === 0) out.append(el('p', { class: 'muted' }, 'No warnings.'))
    else out.append(el('table', {}, el('tr', {}, ...['class', 'location', 'rule', 'message', 'component'].map((h) => el('th', {}, h))), ...rows))
    return out
  }

  private requestsPanel(): Node {
    if (this.entries.length === 0) return el('p', { class: 'muted' }, 'No traced requests yet.')
    const tb = el('table', {}, el('tr', {}, ...['', 'request', 'status', 'ms', 'cache'].map((h) => el('th', {}, h))))
    for (const e of [...this.entries].reverse()) tb.append(el('tr', {}, el('td', { class: 'muted' }, e.kind), el('td', {}, `${e.method} ${e.path}`), el('td', { class: e.status >= 500 ? 'err' : '' }, String(e.status)), el('td', {}, String(e.ms)), el('td', {}, e.trace?.cache ?? '—')))
    return tb
  }
}

/** The focused element, looking through shadow roots (the devtools' own buttons live in one). */
function deepActive(): Element | null {
  let a: Element | null = document.activeElement
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement
  return a
}

function readTrace(): Trace | null {
  try { return JSON.parse(document.getElementById('__brust_trace')?.textContent ?? 'null') as Trace | null } catch { return null }
}

/** Live values of a store instance. Only signals and computeds are READ (marked by the runtime with `Symbol.for`); actions are never called. */
function liveValues(instance: Record<string, unknown>): Record<string, unknown> {
  const SIGNAL = Symbol.for('brust.signal'); const COMPUTED = Symbol.for('brust.computed')
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(instance)) {
    if (typeof v !== 'function') continue
    const f = v as unknown as Record<symbol, unknown> & (() => unknown)
    if (f[SIGNAL] === true || f[COMPUTED] === true) out[k] = f()
  }
  return out
}

/** Client rects of component `id` on the page. */
export function componentRects(id: string): DOMRect[] {
  const rects: DOMRect[] = []
  for (const e of document.querySelectorAll(`[x-data]`)) if (e.getAttribute('x-data') === id) rects.push(e.getBoundingClientRect())
  // the island host is display:contents (no box of its own): its painted children carry the rects
  for (const e of document.querySelectorAll('brust-island')) if (e.getAttribute('data-id') === id) rects.push(...[...e.children].map((c) => c.getBoundingClientRect()))
  if (rects.length) return rects
  // The root level carries no comment pair: its mark is on the nav tag, and it spans the document.
  const root = document.querySelector('script[data-brust-nav]')?.getAttribute('data-brust-root')
  if (root !== null && root !== undefined && root.slice(0, root.lastIndexOf(':')) === id) return [document.documentElement.getBoundingClientRect()]
  // An inner chain level: the nodes between `<!--brust-l:id:hash-->` and its `<!--/brust-l:id-->` (F453 markers).
  const w = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT)
  let open: Comment | null = null
  for (let n = w.nextNode() as Comment | null; n; n = w.nextNode() as Comment | null) {
    const v = n.nodeValue ?? ''
    if (!open) { if (v.startsWith('brust-l:') && v.slice(8, v.lastIndexOf(':')) === id) open = n; continue }
    if (v === `/brust-l:${id}`) {
      const r = document.createRange()
      r.setStartAfter(open); r.setEndBefore(n)
      const box = r.getBoundingClientRect()
      return box.width || box.height ? [box] : []
    }
  }
  return []
}

if (typeof customElements !== 'undefined' && !customElements.get('brust-devtools')) {
  customElements.define('brust-devtools', BrustDevtools)
  const mount = () => { if (!document.querySelector('brust-devtools')) document.body.append(document.createElement('brust-devtools')) }
  if (document.body) mount()
  else addEventListener('DOMContentLoaded', mount)
}
