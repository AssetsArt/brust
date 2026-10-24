// F386: the normaliser that makes brust's server HTML and React's `renderToString` of the same component comparable.
// An explicit list, not a fuzzy diff: every rule below is one thing brust adds (or React adds) that does not change what
// the first paint shows. Anything else that differs is a candidate wrong output.
//
//   1. comments are dropped (React's `<!-- -->` text separators and `<!--$-->` boundaries, brust's `<!--x-for-->` markers)
//   2. brust's own wrapper elements are unwrapped: <brust-island>, <brust-host>, <brust-row>, <brust-if>
//      (all `display:contents`: no box, no content of their own)
//   3. brust's own attributes are dropped: every `x-*` directive/prop attribute and every `data-brust-*`
//   4. attributes are sorted by name; a boolean attribute is `name=""`; entity references in values/text are decoded
//   5. adjacent text nodes merge (after rule 1); a run of ASCII whitespace collapses to ONE space, NOT trimmed (a dropped JSX space
//      is a real wrong paint); a whitespace-only text node is dropped only when it contains a newline (formatting, JSX never
//      emits it); `&nbsp;` decodes to U+00A0 and is never collapsed with an ASCII space
//   6. void elements carry no closing token
//   7. an element with a `hidden` attribute AND one of `x-if`, `x-else-if`, `x-else`, `x-show` (parsed attributes, not the raw tag
//      text) is brust's client-toggled copy: its subtree is dropped (React never paints the false branch). A bound `hidden` row
//      (`x-bind-hidden`) or a class named `hidden` is content and is compared
//   7b. the element right after a `<!--x-for-->` marker, when it is `x-for` + `hidden`, is the list's zero-row template (the prototype
//      the client clones for the first row): dropped. Any other hidden row, authored `hidden={cond}` (F412 / F396 shape) included, is
//      compared
//   8. <title>, <meta>, <link>, <script> are dropped with their content: document-level in both (React 19 hoists them in
//      renderToString, the server hoists them into <head>, F399) and the runtime's own scripts follow the body
//  10. the route envelope's `params` and `path` props, when a row spreads them onto an element, are dropped (React stringifies the
//      object, brust writes JSON; a route component's props are not what a battery row is about)
//  11. `useId` values are opaque: React's `_R_…_` and brust's `brust-r…` ids are renumbered by first appearance (`ID1`, `ID2`, …), so
//      the comparison keeps WHICH elements share an id and drops the spelling
//  12. a `<span>` left with no attribute is unwrapped on BOTH sides: brust wraps a bound text in `<span x-text>` and an author's
//      `<span>{n}</span>` is indistinguishable from it once the directive is dropped (a bare span's presence is not compared)
//   9. React's `javascript:throw new Error('React form unexpectedly submitted.')` form action placeholder is dropped
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const DOCUMENT_LEVEL = new Set(['title', 'meta', 'link', 'script'])
const REACT_FORM_PLACEHOLDER = /^javascript:throw new Error\('React form unexpectedly submitted\.'\)$/
const WRAPPERS = new Set(['brust-island', 'brust-host', 'brust-row', 'brust-if'])
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&([a-z]+);/g, (m, n: string) => NAMED[n] ?? m)
}

const isBrustAttr = (name: string): boolean => name.startsWith('x-') || name.startsWith('data-brust-')

/** The attributes of a tag's raw text, as parsed name/value pairs (names lower-cased, values entity-decoded). */
function parseAttrs(raw: string): [string, string][] {
  const out: [string, string][] = []
  for (const m of raw.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) out.push([m[1]!.toLowerCase(), decode(m[2] ?? m[3] ?? m[4] ?? '')])
  return out
}

const TOGGLES = new Set(['x-if', 'x-else-if', 'x-else', 'x-show'])

function attrs(list: [string, string][]): string {
  const out: [string, string][] = []
  for (const [name, value] of list) {
    if (isBrustAttr(name) || name === 'params' || name === 'path') continue
    let v = value
    if (name === 'action' && REACT_FORM_PLACEHOLDER.test(v)) continue
    if (name === 'class') v = v.replace(/\s+/g, ' ').trim()
    out.push([name, v])
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return out.map(([n, v]) => ` ${n}=${JSON.stringify(v)}`).join('')
}

/** The comparable token list of an HTML fragment. */
export function normalise(html: string): string[] {
  // the marker only matters as the position of the zero-row template (rule 7b): carry it on that element, then drop comments
  const body = html.replace(/<!--x-for-->(\s*)<([a-zA-Z][\w-]*)/g, '<$2 data-brust-xfor-template').replace(/<!--[\s\S]*?-->/g, '')
  const tokens: string[] = []
  let text = ''
  const spans: boolean[] = [] // open <span>s: true = a text-binding wrapper that was unwrapped
  let skip = 0 // depth inside a dropped subtree (rules 7, 8)
  const flush = () => {
    const t = decode(text).replace(/[ \t\n\r\f]+/g, ' ')
    // formatting whitespace (a newline in a whitespace-only node) is not content; a lone space between inline elements is
    if (t !== '' && !(t.trim() === '' && /\n/.test(decode(text)))) tokens.push(JSON.stringify(t))
    text = ''
  }
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+|<)/g)) {
    if (m[4] !== undefined) { if (skip === 0) text += m[4]; continue }
    const name = m[2]!.toLowerCase()
    const raw = m[3] ?? ''
    const selfClosed = raw.trimEnd().endsWith('/')
    if (m[1]) {
      if (skip > 0) { skip--; continue }
      if (WRAPPERS.has(name) || VOID.has(name)) continue
      if (name === 'span' && spans.pop()) continue
      flush()
      tokens.push(`</${name}>`)
      continue
    }
    if (skip > 0) { if (!VOID.has(name) && !selfClosed) skip++; continue }
    const list = parseAttrs(raw)
    const has = (a: string) => list.some(([n]) => n === a)
    const dropped = DOCUMENT_LEVEL.has(name) || (has('hidden') && (list.some(([n]) => TOGGLES.has(n)) || (has('x-for') && has('data-brust-xfor-template'))))
    if (dropped) { if (!VOID.has(name) && !selfClosed) skip = 1; continue }
    if (WRAPPERS.has(name)) continue
    if (name === 'span' && attrs(list) === '') { spans.push(true); continue }
    if (name === 'span') spans.push(false)
    flush()
    tokens.push(`<${name}${attrs(list)}>`)
  }
  flush()
  return renumberIds(tokens)
}

const ID = /_R_[A-Za-z0-9]*_|brust-r[\w.-]+?-\d+(?:-\d+)?(?![\w.-])/g

/** Rule 11: ids renumbered by first appearance across the whole token list. */
function renumberIds(tokens: string[]): string[] {
  const seen = new Map<string, string>()
  return tokens.map((t) => t.replace(ID, (m) => { if (!seen.has(m)) seen.set(m, `ID${seen.size + 1}`); return seen.get(m)! }))
}

/** The first difference between two normalised token lists, with a few tokens of context; null when equal. */
export function firstDifference(a: string[], b: string[]): string | null {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue
    const ctx = (xs: string[]) => xs.slice(Math.max(0, i - 2), i + 3).join(' ')
    return `at token ${i}: brust ${a[i] ?? '<end>'} vs react ${b[i] ?? '<end>'}\n    brust: … ${ctx(a)} …\n    react: … ${ctx(b)} …`
  }
  return null
}
