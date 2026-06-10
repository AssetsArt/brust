import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  __setShikiImporterForTests,
  highlightCode,
  type MdComponentResolution,
  neutralizeBraces,
  renderMdPage,
} from './render.ts'

const ABS = '/proj/content/docs/page.md'

function registryResolve(name: string): MdComponentResolution | null {
  if (name === 'Counter') return { kind: 'island', id: 'Counter_abc12345' }
  if (name === 'Clock') return { kind: 'island', id: 'Clock_def67890' }
  if (name === 'ThemeToggle') return { kind: 'behavior', directive: 'themeToggle_11223344' }
  return null
}

async function render(body: string) {
  return renderMdPage({ body, absPath: ABS, resolve: registryResolve })
}

/** Minijinja-style substitution: resolves the `{{ "X" }}` literals neutralization emits. */
function substituteJinjaLiterals(html: string): string {
  return html.replace(/\{\{ "([^"]*)" \}\}/g, (_m, lit: string) => lit)
}

afterEach(() => {
  __setShikiImporterForTests(null)
})

// ---------------------------------------------------------------------------
// Task 2.3 — markdown rendering
// ---------------------------------------------------------------------------

describe('markdown rendering (GFM)', () => {
  test('renders a GFM table', async () => {
    const { html } = await render(['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n'))
    expect(html).toContain('<table>')
    expect(html).toContain('<th>a</th>')
    expect(html).toContain('<td>2</td>')
  })

  test('heading anchor ids: slugged + deduped with -2 suffixes', async () => {
    const { html } = await render(
      ['# Hello World', '## Hello World', '## Hello World', "## What's New?"].join('\n\n'),
    )
    expect(html).toContain('<h1 id="hello-world">Hello World</h1>')
    expect(html).toContain('<h2 id="hello-world-2">Hello World</h2>')
    expect(html).toContain('<h2 id="hello-world-3">Hello World</h2>')
    expect(html).toContain('id="whats-new"')
  })

  test('slugger state is per-page (no bleed between renders)', async () => {
    const first = await render('# Same Title')
    const second = await render('# Same Title')
    expect(first.html).toContain('id="same-title"')
    expect(second.html).toContain('id="same-title"')
    expect(second.html).not.toContain('id="same-title-2"')
  })
})

describe('neutralizeBraces', () => {
  test('replaces all four jinja delimiters with string literals', () => {
    expect(neutralizeBraces('a {{ b }} c')).toBe('a {{ "{{" }} b {{ "}}" }} c')
    expect(neutralizeBraces('{% if x %}')).toBe('{{ "{%" }} if x {{ "%}" }}')
  })

  test('does not re-neutralize its own output (single pass)', () => {
    const once = neutralizeBraces('{{')
    expect(once).toBe('{{ "{{" }}')
    // Substituting resolves back to the original text.
    expect(substituteJinjaLiterals(once)).toBe('{{')
  })
})

describe('code fences with jinja-hostile content', () => {
  const fenceBody = ['```', '{{ name }} {% if x %} {% endraw %} %}', '```'].join('\n')

  test('emitted jinja contains the neutralized form, never a raw {% endraw %}', async () => {
    const { html } = await render(fenceBody)
    expect(html).not.toContain('{% endraw %}')
    expect(html).not.toContain('{{ name }}')
    expect(html).toContain('{{ "{{" }}')
    expect(html).toContain('{{ "{%" }}')
  })

  test('survives minijinja-style substitution to identical visible text', async () => {
    const { html } = await render(fenceBody)
    const substituted = substituteJinjaLiterals(html)
    expect(substituted).toContain('{{ name }} {% if x %} {% endraw %} %}')
  })
})

describe('highlightCode', () => {
  test('shiki-present: dual-theme CSS-variables output', async () => {
    const html = await highlightCode('const a = 1', 'ts')
    expect(html).toContain('shiki-themes github-light github-dark')
    expect(html).toContain('--shiki-dark:')
  })

  test('fence with a lang goes through shiki inside renderMdPage', async () => {
    const { html } = await render(['```ts', 'const a = 1', '```'].join('\n'))
    expect(html).toContain('shiki-themes github-light github-dark')
  })

  test('shiki missing: escape-only fallback + ONE warning per build', async () => {
    __setShikiImporterForTests(() => Promise.reject(new Error('Cannot find module shiki')))
    const warn = mock(() => {})
    const realWarn = console.warn
    console.warn = warn
    try {
      const first = await highlightCode('<b>&{{ x }}', 'js')
      expect(first).toBe('<pre><code class="language-js">&lt;b&gt;&amp;{{ x }}</code></pre>')
      await highlightCode('more()', 'ts')
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      console.warn = realWarn
    }
  })

  test('no lang: escape-only fallback without class, no warning', async () => {
    const warn = mock(() => {})
    const realWarn = console.warn
    console.warn = warn
    try {
      expect(await highlightCode('a < b', '')).toBe('<pre><code>a &lt; b</code></pre>')
      expect(warn).toHaveBeenCalledTimes(0)
    } finally {
      console.warn = realWarn
    }
  })

  test('unknown language falls back to escape-only with the class', async () => {
    const html = await highlightCode('x', 'definitely-not-a-language')
    expect(html).toBe('<pre><code class="language-definitely-not-a-language">x</code></pre>')
  })
})

// ---------------------------------------------------------------------------
// Task 2.4 — component-tag transform
// ---------------------------------------------------------------------------

describe('component tags: props', () => {
  test('every prop kind: string, number, boolean, object, bare flag', async () => {
    const { islands } = await render(
      '<Counter label="hi" start={42} on={true} cfg={{"a":1,"b":[2]}} flag/>',
    )
    expect(islands).toHaveLength(1)
    expect(islands[0]?.props).toEqual({
      label: 'hi',
      start: 42,
      on: true,
      cfg: { a: 1, b: [2] },
      flag: true,
    })
  })

  test('malformed JSON prop → build error with file:line', async () => {
    const body = ['# Title', '', '<Counter cfg={{"a":}}/>'].join('\n')
    expect(render(body)).rejects.toThrow(`${ABS}:3`)
  })
})

describe('component tags: island hosts', () => {
  test('SSR island (default): host div with live jinja markers', async () => {
    const { html, islands } = await render('<Counter start={1}/>')
    expect(html).toContain(
      '<div data-brust-island="Counter_abc12345" data-brust-props="{{ island_0_props }}" data-brust-hydrate="load">{{ island_0_html | safe }}</div>',
    )
    expect(islands).toEqual([
      {
        name: 'Counter',
        instanceLocal: 0,
        props: { start: 1 },
        hydrate: 'load',
        csr: false,
        line: 1,
      },
    ])
  })

  test('csr island: data-brust-csr + empty inner', async () => {
    const { html, islands } = await render('<Counter csr hydrate="visible"/>')
    expect(html).toContain(
      '<div data-brust-island="Counter_abc12345" data-brust-props="{{ island_0_props }}" data-brust-hydrate="visible" data-brust-csr></div>',
    )
    expect(islands[0]?.csr).toBe(true)
    expect(islands[0]?.hydrate).toBe('visible')
    // reserved props do not leak into props
    expect(islands[0]?.props).toEqual({})
  })

  test('hydrate variants accepted; invalid rejected with file:line', async () => {
    for (const h of ['load', 'idle', 'visible', 'interaction']) {
      const { islands } = await render(`<Counter hydrate="${h}"/>`)
      expect(islands[0]?.hydrate).toBe(h)
    }
    expect(render('<Counter hydrate="lazy"/>')).rejects.toThrow(`${ABS}:1`)
  })

  test('two instances of the same component get distinct local instances', async () => {
    const { html, islands } = await render(
      ['<Counter start={1}/>', '', 'middle text', '', '<Counter start={2}/>'].join('\n'),
    )
    expect(islands.map((i) => i.instanceLocal)).toEqual([0, 1])
    expect(islands.map((i) => i.line)).toEqual([1, 5])
    expect(html).toContain('{{ island_0_html | safe }}')
    expect(html).toContain('{{ island_1_html | safe }}')
  })

  test('island jinja stays LIVE while md braces are neutralized (pipeline order)', async () => {
    const body = ['```', '{{ raw }}', '```', '', '<Counter/>'].join('\n')
    const { html } = await render(body)
    // md-origin braces neutralized…
    expect(html).toContain('{{ "{{" }} raw {{ "}}" }}')
    // …host jinja untouched
    expect(html).toContain('data-brust-props="{{ island_0_props }}"')
    expect(html).toContain('{{ island_0_html | safe }}')
  })

  test('host div is not wrapped in a <p>', async () => {
    const { html } = await render(['some text', '<Counter/>', 'more text'].join('\n'))
    expect(html).not.toMatch(/<p>[^<]*<div data-brust-island/)
    expect(html).toContain('<div data-brust-island="Counter_abc12345"')
  })
})

describe('component tags: behavior hosts', () => {
  test('behavior → x-data host, no island entry', async () => {
    const { html, islands } = await render('<ThemeToggle/>')
    expect(html).toContain('<div x-data="themeToggle_11223344"></div>')
    expect(islands).toHaveLength(0)
  })
})

describe('component tags: matching rules', () => {
  test('unknown tag name → registry error with file:line', async () => {
    expect(render('<Missing/>')).rejects.toThrow(
      `${ABS}:1 — <Missing> is not in mdRoutes components registry`,
    )
  })

  test('tag inside a code fence is ignored', async () => {
    const { html, islands } = await render(['```', '<Counter/>', '```'].join('\n'))
    expect(islands).toHaveLength(0)
    expect(html).not.toContain('data-brust-island')
    expect(html).toContain('&lt;Counter/&gt;')
  })

  test('tag inside a lang-tagged (highlighted) fence is ignored too', async () => {
    const { html, islands } = await render(['```md', '<Counter/>', '```'].join('\n'))
    expect(islands).toHaveLength(0)
    expect(html).not.toContain('data-brust-island')
  })

  test('tag mid-paragraph is NOT matched (line-anchored)', async () => {
    const { islands } = await render('Use <Counter/> inline here')
    expect(islands).toHaveLength(0)
  })

  test('non-self-closing usage of a registry name → error', async () => {
    expect(render('<Counter>child</Counter>')).rejects.toThrow(`${ABS}:1`)
  })

  test('two different components resolve to their own ids', async () => {
    const { html } = await render(['<Counter/>', '', '<Clock/>'].join('\n'))
    expect(html).toContain('data-brust-island="Counter_abc12345"')
    expect(html).toContain('data-brust-island="Clock_def67890"')
  })
})
