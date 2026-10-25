// The layout chain of a brust document (design §5.9): the root level from the nav tag's `data-brust-root`, then the
// `<!--brust-l:<id>:<hash>-->…<!--/brust-l:<id>-->` pairs the server wraps around every inner level, outermost first.

/** One level: `key` is `<id>:<shellHash>`; an inner level has its two comments. */
export interface Level { key: string; open?: Comment; close?: Comment }

/** null when the document has no usable chain (no root, unbalanced, crossing or sibling pairs): swap the whole body. */
export function readChain(doc: Document): Level[] | null {
  const root = doc.querySelector('script[data-brust-nav]')?.getAttribute('data-brust-root')
  if (!root || !doc.body) return null
  const out: Level[] = [{ key: root }]
  const open: Level[] = []
  const w = doc.createTreeWalker(doc.body, 128 /* NodeFilter.SHOW_COMMENT */)
  for (let n: Node | null; (n = w.nextNode()); ) {
    const v = (n as Comment).data
    if (v.startsWith('brust-l:')) {
      // a level opens inside the deepest open one, never beside a closed one: the chain is a line
      if (open.length !== out.length - 1) return null
      const l: Level = { key: v.slice(8), open: n as Comment }
      out.push(l)
      open.push(l)
    } else if (v.startsWith('/brust-l:')) {
      const l = open.pop()
      if (!l || l.key.slice(0, l.key.lastIndexOf(':')) !== v.slice(9)) return null
      l.close = n as Comment
    }
  }
  return open.length ? null : out
}

/**
 * A pair can be a range only when the parser kept its two comments siblings (a block in a `<p>` splits them), and not
 * in a table section: there the comments stay put while the parser moves the content out in front of the table
 * (foster parenting), so the range would hold nothing of the level.
 */
const usable = (l: Level) => l.open!.parentNode === l.close!.parentNode && !/^T(ABLE|BODY|HEAD|FOOT|R)$/.test(l.open!.parentNode!.nodeName)

/**
 * The level to replace: the first one whose id or hash differs, else the page (never kept), moved up while its pair is
 * not a sibling pair in either document. 0 = the whole body.
 */
export function swapLevel(a: Level[] | null, b: Level[] | null): number {
  if (!a || !b || a[0]!.key !== b[0]!.key) return 0
  const leaf = Math.min(a.length, b.length) - 1
  let i = 1
  while (i < leaf && a[i]!.key === b[i]!.key) i++
  if (i > leaf) return 0
  while (i && !(usable(a[i]!) && usable(b[i]!))) i--
  return i
}

/** The nodes of a level's range, both comments included. */
export function between(l: Level): ChildNode[] {
  const out: ChildNode[] = []
  for (let n: ChildNode | null = l.open!; n; n = n === l.close ? null : n.nextSibling) out.push(n)
  return out
}
