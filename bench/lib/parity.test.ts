import { describe, expect, test } from 'bun:test'
import { decodeEntities, diffParity, normalizeMain } from './parity'

const brustHtml = `<html lang="en"><head><title>Team</title><link rel="stylesheet" href="/x.css"></head><body>
<header><nav><a href="/types">Types</a></nav></header>
<main>
  <h1>Team</h1>
  <p>Pick up to 6.</p>
  <brust-island data-id="counter_0a1b2c3d" x-props='{"start":0,"label":"clicks"}'><div data-testid="counter"><button type="button">clicks<!-- -->: <!-- -->0</button></div></brust-island>
  <script type="module" src="/_brust/client/runtime-abc.js"></script>
</main>
<footer>bench · brust v2</footer></body></html>`

const nextHtml = `<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><title>Team · bench</title></head><body><header><nav><a href="/types">Types</a></nav></header><main><!--$--><h1>Team</h1><p>Pick up to 6.</p><div data-testid="counter"><button type="button">clicks<!-- -->: <!-- -->0</button></div><!--/$--><style>.x{}</style></main><footer>bench · next</footer><script src="/_next/static/chunks/main.js" async=""></script></body></html>`

const x01Html = `<html><body><main><h1>Team</h1><p>Pick up to 6.</p><div data-brust-island="Counter" data-brust-props="{&quot;start&quot;:0}" data-brust-hydrate="load"><div data-testid="counter"><button type="button">clicks<!-- -->: <!-- -->0</button></div></div></main></body></html>`

describe('normalizeMain', () => {
  test('brust-style and next-style fixtures normalize equal (wrapper, script/link/style, comments, attrs, whitespace)', () => {
    const a = normalizeMain(brustHtml)
    const b = normalizeMain(nextHtml)
    expect(a).toEqual(b)
    expect(a.tags).toEqual(['h1', '/h1', 'p', '/p', 'div', 'button', '/button', '/div'])
    expect(a.text).toEqual(['Team', 'Pick up to 6.', 'clicks: 0'])
  })
  test('0.1.x div[data-brust-island] wrapper is unwrapped', () => {
    expect(normalizeMain(x01Html)).toEqual(normalizeMain(nextHtml))
  })
  test('brust-host and brust-row wrappers are unwrapped', () => {
    const a = normalizeMain('<main><brust-host x-data="p"><ul><li><brust-row style="display:contents"><span>x</span></brust-row></li></ul></brust-host></main>')
    expect(a).toEqual(normalizeMain('<main><ul><li><span>x</span></li></ul></main>'))
  })
  test('only <main> is compared: header/footer/title differences are invisible', () => {
    const n = normalizeMain(brustHtml.replace('bench · brust v2', 'something else').replace('<title>Team</title>', '<title>Other</title>'))
    expect(n).toEqual(normalizeMain(brustHtml))
  })
  test('missing <main> throws naming the problem', () => {
    expect(() => normalizeMain('<html><body><div>no main</div></body></html>')).toThrow(/no <main>/)
  })
  test('entities: &#x27; and &#39; and &amp; decode to the same text; void tags do not open', () => {
    expect(decodeEntities('it&#x27;s &amp; it&#39;s &lt;3 &quot;q&quot; &#233;')).toBe(`it's & it's <3 "q" é`)
    const n = normalizeMain('<main><p>a<br>b<img src="x"></p></main>')
    expect(n.tags).toEqual(['p', 'br', 'img', '/p'])
    expect(n.text).toEqual(['a', 'b'])
  })
})

describe('diffParity', () => {
  test('equal pages → null', () => {
    expect(diffParity({ app: 'brust', n: normalizeMain(brustHtml) }, { app: 'next', n: normalizeMain(nextHtml) })).toBeNull()
  })
  test('a missing row is a mismatch with a diff naming index and both values', () => {
    const ref = normalizeMain('<main><table><tbody><tr><td>#0001</td></tr><tr><td>#0002</td></tr></tbody></table></main>')
    const other = normalizeMain('<main><table><tbody><tr><td>#0001</td></tr></tbody></table></main>')
    const d = diffParity({ app: 'brust', n: ref }, { app: 'next', n: other })
    expect(d).toMatch(/tags differ at index 6/)
    expect(d).toMatch(/brust: tr/)
    expect(d).toMatch(/next: \/tbody/)
    expect(d).toMatch(/counts: brust 12 tags \/ 2 texts, next 8 tags \/ 1 texts/)
  })
  test('different text content is a mismatch', () => {
    const d = diffParity({ app: 'brust', n: normalizeMain('<main><h1>Types</h1></main>') }, { app: 'next', n: normalizeMain('<main><h1>Type</h1></main>') })
    expect(d).toMatch(/text differs at index 0: brust "Types" vs next "Type"/)
  })
})
