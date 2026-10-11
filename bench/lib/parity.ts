// bench/lib/parity.ts — "same page" as a checked claim (spec §1.4). For each app's HTML: take <main>, drop
// <script>/<link>/<style>/<template> and comments, unwrap island hosts (<brust-island>, [data-brust-island]),
// ignore every attribute (subsumes data-*/x-*/hash ids), decode entities, collapse whitespace; compare the tag
// sequence and the text nodes. Attributes/classes are framework-free territory; tags and text are not.
export interface Normalized { tags: string[]; text: string[] }

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&([a-z]+);/g, (m, n: string) => NAMED[n] ?? m)
}

// Compiler-emitted hosts carry no content of their own: <brust-island> (react child), <brust-host> (fragment-root
// component), <brust-row> (x-for host row) and the 0.1.x div[data-brust-island].
const WRAPPERS = new Set(['brust-island', 'brust-host', 'brust-row'])
const isWrapper = (name: string, attrs: string): boolean => WRAPPERS.has(name) || /\sdata-brust-island\b/.test(` ${attrs}`)

export function normalizeMain(html: string): Normalized {
  const m = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)
  if (!m) throw new Error(`no <main> element in the response (${html.length} bytes): ${html.slice(0, 120).replace(/\s+/g, ' ')}…`)
  const body = m[1]!
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
  const tags: string[] = []
  const text: string[] = []
  const stack: boolean[] = [] // true = this open tag was an unwrapped island host
  const re = /<\/?([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g
  for (let t = re.exec(body); t !== null; t = re.exec(body)) {
    if (t[3] !== undefined) {
      const s = decodeEntities(t[3]).replace(/\s+/g, ' ').trim()
      if (s) text.push(s)
      continue
    }
    const name = t[1]!.toLowerCase()
    const attrs = t[2] ?? ''
    if (t[0].startsWith('</')) {
      const skipped = stack.pop() ?? false
      if (!skipped) tags.push(`/${name}`)
      continue
    }
    if (VOID.has(name) || attrs.trimEnd().endsWith('/')) { tags.push(name); continue }
    const skip = isWrapper(name, attrs)
    stack.push(skip)
    if (!skip) tags.push(name)
  }
  return { tags, text }
}

export function diffParity(ref: { app: string; n: Normalized }, other: { app: string; n: Normalized }): string | null {
  const counts = `counts: ${ref.app} ${ref.n.tags.length} tags / ${ref.n.text.length} texts, ${other.app} ${other.n.tags.length} tags / ${other.n.text.length} texts`
  const ctx = (xs: string[], i: number) => xs.slice(Math.max(0, i - 3), i + 4).join(' ')
  const nt = Math.max(ref.n.tags.length, other.n.tags.length)
  for (let i = 0; i < nt; i++) {
    const a = ref.n.tags[i]
    const b = other.n.tags[i]
    if (a !== b) return `tags differ at index ${i}: ${ref.app}: ${a ?? '<end>'} vs ${other.app}: ${b ?? '<end>'}\n  ${ref.app}: … ${ctx(ref.n.tags, i)} …\n  ${other.app}: … ${ctx(other.n.tags, i)} …\n  ${counts}`
  }
  const nx = Math.max(ref.n.text.length, other.n.text.length)
  for (let i = 0; i < nx; i++) {
    const a = ref.n.text[i]
    const b = other.n.text[i]
    if (a !== b) return `text differs at index ${i}: ${ref.app} ${JSON.stringify(a ?? '<end>')} vs ${other.app} ${JSON.stringify(b ?? '<end>')}\n  ${counts}`
  }
  return null
}

/** The runner's entry: every app against the first one; the first mismatch aborts with its diff. */
export async function checkParity(pages: { app: string; html: string }[], probe: string): Promise<void> {
  const [ref, ...rest] = pages.map((p) => ({ app: p.app, n: normalizeMain(p.html) }))
  if (!ref) throw new Error(`parity ${probe}: no pages to compare`)
  for (const other of rest) {
    const d = diffParity(ref, other)
    if (d) throw new Error(`parity mismatch on probe ${probe} (${ref.app} vs ${other.app}):\n${d}`)
  }
}
