// website/test/lib.test.ts — lib/highlight.ts (canon classes, escaping, shell prompts, memo) and lib/pokemon.ts.
import { expect, test } from 'bun:test'
import { codeBlock, escapeHtml, highlight } from '../lib/highlight'
import { artworkUrl, byId, byName, dexNo, displayName, POKEMON, search, shinyUrl, spriteUrl } from '../lib/pokemon'

test('highlight: ts/tsx tokens map to the canon classes k/s/f/t/c/n', () => {
  const html = highlight("import { x } from 'y'\n// note\nexport function f() { return <p>{1}</p> }", 'tsx')
  expect(html).toContain('<span class="k">import</span>')
  expect(html).toContain(`<span class="s">'y'</span>`)
  expect(html).toContain('<span class="c">// note</span>')
  expect(html).toContain('<span class="f">f</span>')
  expect(html).toContain('<span class="t">&lt;p&gt;</span>')
  expect(html).toContain('<span class="n">1</span>')
  expect(html.split('\n')).toHaveLength(3)
})

test('highlight: everything is escaped, nothing becomes markup', () => {
  const html = highlight("const s = '<script>alert(1)</script>' && a < b", 'ts')
  expect(html).not.toContain('<script>')
  expect(html).toContain('&lt;script&gt;')
  expect(highlight('<b>"x" & y</b>', 'text')).toBe(escapeHtml('<b>"x" & y</b>'))
  expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
})

test('highlight: shell sessions get an unselectable prompt and dimmed output', () => {
  expect(highlight('$ bun --version\n1.4.3\n\n$ echo <hi>', 'sh')).toBe(
    '<span class="ps">$ </span>bun --version\n<span class="c">1.4.3</span>\n\n<span class="ps">$ </span>echo &lt;hi&gt;',
  )
})

test('codeBlock: carries code/lang/file/cwd and memoises the html per (lang, code)', () => {
  const a = codeBlock({ code: 'const a = 1', lang: 'ts', file: 'a.ts' })
  const b = codeBlock({ code: 'const a = 1', lang: 'ts', cwd: '~/' })
  expect(a).toEqual({ code: 'const a = 1', lang: 'ts', file: 'a.ts', html: '<span class="k">const</span> a = <span class="n">1</span>' })
  expect(b).toEqual({ code: 'const a = 1', lang: 'ts', cwd: '~/', html: a.html })
  expect(codeBlock({ code: 'const a = 1', lang: 'text' }).html).toBe('const a = 1')
})

test('pokemon: a curated Gen-1 set of 24 with the required ids, sorted, unique', () => {
  expect(POKEMON).toHaveLength(24)
  for (const id of [1, 4, 7, 25, 133, 143, 150]) expect(byId(id)?.id).toBe(id)
  const ids = POKEMON.map((p) => p.id)
  expect(ids).toEqual([...ids].sort((x, y) => x - y))
  expect(new Set(ids).size).toBe(24)
  expect(new Set(POKEMON.map((p) => p.name)).size).toBe(24)
  for (const p of POKEMON) expect(p.id).toBeLessThanOrEqual(151)
})

test('pokemon: PokeAPI image URLs and display helpers', () => {
  const base = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon'
  expect(artworkUrl(25)).toBe(`${base}/other/official-artwork/25.png`)
  expect(shinyUrl(25)).toBe(`${base}/other/official-artwork/shiny/25.png`)
  expect(spriteUrl(25)).toBe(`${base}/25.png`)
  expect(dexNo(7)).toBe('#007')
  expect(displayName('mr-mime')).toBe('Mr Mime')
  expect(byName('Pikachu')?.types).toEqual(['electric'])
})

test('pokemon: search by name or number, empty query returns all', () => {
  expect(search('').length).toBe(24)
  expect(search('char').map((p) => p.name)).toEqual(['charmander', 'charmeleon', 'charizard'])
  expect(search('#025').map((p) => p.name)).toEqual(['pikachu'])
  expect(search('  EEV ').map((p) => p.name)).toEqual(['eevee'])
  expect(search('zzz')).toEqual([])
})
