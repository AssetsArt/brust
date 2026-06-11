import { Marked, type Tokens } from 'marked'
// Heading slugger shared with the public `brustjs/routes` export so a consumer's
// anchors can't drift from the ids we stamp here (FRAMEWORK-GAPS G1).
import { slugifyHeading as slugify } from './slug.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MdHydrate = 'load' | 'idle' | 'visible' | 'interaction'

const HYDRATE_MODES: readonly MdHydrate[] = ['load', 'idle', 'visible', 'interaction']

/** One embedded-component use found in a markdown page (islands only). */
export interface MdIslandUse {
  name: string
  /** 0-based per page; the emit step offsets past the wrapper's own islands. */
  instanceLocal: number
  props: Record<string, unknown>
  hydrate: MdHydrate
  csr: boolean
  /** 1-based line number within the md body (post-frontmatter). */
  line: number
}

/** One behavior-component (x-data) use found in a markdown page. */
export interface MdBehaviorUse {
  name: string
  directive: string
  /** 1-based line number within the md body (post-frontmatter). */
  line: number
  /** Literal tag props (string/number only — validated at extract time). The
   * emit step inline-substitutes them into the component's compiled body. */
  props: Record<string, unknown>
  /** The EXACT placeholder host markup injected into the rendered HTML. The
   * emit step (which owns compileJsx) substitutes the fully inlined component
   * body over this exact string. It carries the per-render nonce, so user
   * prose can never collide with it. */
  marker: string
}

export type MdComponentResolution =
  | { kind: 'island'; id: string }
  | { kind: 'behavior'; directive: string }

export interface RenderMdPageOptions {
  /** Markdown source, frontmatter already stripped. */
  body: string
  absPath: string
  /** `null` → unknown name → renderMdPage throws with `file:line`. */
  resolve: (name: string, line: number) => MdComponentResolution | null
}

// ---------------------------------------------------------------------------
// Shiki (optional peer dep) — lazy, cached, one warning per build
// ---------------------------------------------------------------------------

interface ShikiLike {
  codeToHtml(
    code: string,
    options: { lang: string; themes: { light: string; dark: string } },
  ): Promise<string>
}

const defaultShikiImporter = () => import('shiki') as Promise<ShikiLike>

let shikiImporter: () => Promise<ShikiLike> = defaultShikiImporter
/** `undefined` = not attempted yet; `null` = unavailable. */
let shikiLoad: Promise<ShikiLike | null> | undefined
let warnedShikiMissing = false

/** Test seam: replaces the dynamic `import('shiki')` and resets all cached state. */
export function __setShikiImporterForTests(importer: (() => Promise<ShikiLike>) | null): void {
  shikiImporter = importer ?? defaultShikiImporter
  shikiLoad = undefined
  warnedShikiMissing = false
}

function loadShiki(): Promise<ShikiLike | null> {
  if (shikiLoad === undefined) {
    shikiLoad = shikiImporter().catch(() => null)
  }
  return shikiLoad
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function fallbackCodeBlock(code: string, lang: string): string {
  const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`
  return `<pre><code${cls}>${escapeHtml(code)}</code></pre>`
}

/**
 * Highlights a code fence via shiki (lazy-imported once, cached) with dual
 * CSS-variables themes. shiki absent → escape-only `<pre><code>` fallback and
 * ONE warning per build. Unknown language → silent escape-only fallback.
 */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const language = (lang ?? '').trim().split(/\s+/)[0] ?? ''
  if (language === '') return fallbackCodeBlock(code, '')
  const shiki = await loadShiki()
  if (shiki === null) {
    if (!warnedShikiMissing) {
      warnedShikiMissing = true
      console.warn(
        '[brust md] shiki is not installed — code fences are emitted without syntax highlighting (add the optional `shiki` dependency to enable it)',
      )
    }
    return fallbackCodeBlock(code, language)
  }
  try {
    return await shiki.codeToHtml(code, {
      lang: language,
      themes: { light: 'github-light', dark: 'github-dark' },
    })
  } catch {
    // Unknown/unsupported language — degrade per-fence, no warning.
    return fallbackCodeBlock(code, language)
  }
}

// ---------------------------------------------------------------------------
// Jinja-brace neutralization
// ---------------------------------------------------------------------------

const JINJA_DELIMS: Record<string, string> = {
  '{{': '{{ "{{" }}',
  '}}': '{{ "}}" }}',
  '{%': '{{ "{%" }}',
  '%}': '{{ "%}" }}',
}

/**
 * Replaces every minijinja delimiter in md-origin HTML with a string-literal
 * expression that renders back to the original text. Single pass — the
 * replacements themselves are never re-matched. Component-host markup is
 * injected AFTER this pass so its jinja stays live.
 */
export function neutralizeBraces(html: string): string {
  return html.replace(/\{\{|\}\}|\{%|%\}/g, (m) => JINJA_DELIMS[m] as string)
}

// ---------------------------------------------------------------------------
// Component-tag transform (line-level, outside code fences)
// ---------------------------------------------------------------------------

/**
 * Placeholder strategy: extracted component-tag lines become single-line HTML
 * comments (`<!--brust-md-slot:N-->`). Per CommonMark, a comment line is an
 * HTML block (type 2) that may interrupt a paragraph, so marked emits it raw
 * and block-level — never wrapped in `<p>` — even when the tag line directly
 * abuts paragraph text (probed against marked 18). The comment contains no
 * jinja delimiters, so it passes through `neutralizeBraces` untouched and is
 * substituted with the (live-jinja) host markup afterwards.
 */
// Per-call nonce so user content that happens to contain the literal
// placeholder text (e.g. docs ABOUT this mechanism) can never be substituted.
const slotPlaceholder = (nonce: string, n: number) => `<!--brust-md-slot:${nonce}:${n}-->`

/** Opens like `<Name` with a capital ident — a *candidate* component-tag line. */
const TAG_OPEN_RE = /^<([A-Z][A-Za-z0-9]*)(?=[\s/>])/

interface ExtractedTags {
  /** Body with component-tag lines swapped for slot placeholders. */
  source: string
  /** Host markup per placeholder index. */
  hosts: string[]
  islands: MdIslandUse[]
  behaviors: MdBehaviorUse[]
}

function extractComponentTags(
  body: string,
  absPath: string,
  resolve: RenderMdPageOptions['resolve'],
  nonce: string,
): ExtractedTags {
  const lines = body.split('\n')
  const hosts: string[] = []
  const islands: MdIslandUse[] = []
  const behaviors: MdBehaviorUse[] = []
  let instanceLocal = 0

  let fence: { char: string; len: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const lineNo = i + 1

    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence === null) {
      if (fenceMatch !== null) {
        const marker = fenceMatch[1] as string
        fence = { char: marker[0] as string, len: marker.length }
      }
      // fall through: a fence-opening line is never a component tag
    } else {
      if (
        fenceMatch !== null &&
        (fenceMatch[1] as string)[0] === fence.char &&
        (fenceMatch[1] as string).length >= fence.len &&
        line.trim() === fenceMatch[1]
      ) {
        fence = null
      }
      continue // inside (or closing) a fence — tags are shielded
    }
    if (fenceMatch !== null) continue

    const open = TAG_OPEN_RE.exec(line.trimEnd())
    if (open === null) continue
    const name = open[1] as string
    const trimmed = line.trimEnd()

    if (!trimmed.endsWith('/>')) {
      // Non-self-closing usage of a registry name is an error; unknown names
      // are left for markdown (could be prose-level inline HTML).
      if (resolve(name, lineNo) !== null) {
        throw new Error(
          `${absPath}:${lineNo} — <${name}> must be self-closing in markdown (children are not supported in v1)`,
        )
      }
      continue
    }

    const resolution = resolve(name, lineNo)
    if (resolution === null) {
      throw new Error(`${absPath}:${lineNo} — <${name}> is not in mdRoutes components registry`)
    }

    const attrText = trimmed.slice(open[0].length, trimmed.length - 2)
    const { props, hydrate, csr } = parseTagAttrs(attrText, name, absPath, lineNo)

    let host: string
    if (resolution.kind === 'behavior') {
      // Behavior components have no hydration model — silently dropping these
      // would mislead authors into thinking they did something.
      if (hydrate !== 'load' || csr) {
        throw new Error(
          `${absPath}:${lineNo} — <${name}> is a native behavior component; hydrate/csr do not apply`,
        )
      }
      // The emit step compiles the component's body through the native-inline
      // path and substitutes the result over the placeholder below. That path
      // can only inline-substitute string/number literals (bool/object props
      // are rejected by the JSX compiler), and a string carrying jinja
      // delimiters would land RAW in the compiled host — live jinja that can't
      // be neutralized after the fact. Validate both here, where file:line is
      // at hand.
      for (const [k, v] of Object.entries(props)) {
        if (typeof v !== 'string' && typeof v !== 'number') {
          throw new Error(
            `${absPath}:${lineNo} — <${name}> prop "${k}" must be a string or number literal ` +
              `(behavior component bodies are inlined statically; got ${typeof v})`,
          )
        }
        if (typeof v === 'string' && /\{\{|\}\}|\{%|%\}/.test(v)) {
          throw new Error(
            `${absPath}:${lineNo} — <${name}> prop "${k}" contains jinja delimiters, which cannot ` +
              'be inlined into a md behavior host',
          )
        }
      }
      // Placeholder host: substituted whole-tag by the emit step (which owns
      // compileJsx — this module must stay free of it). The nonce makes the
      // marker impossible to author in md prose; the index disambiguates
      // multiple uses of the same component on one page.
      host = `<div x-data="${resolution.directive}" data-brust-md-behavior="${nonce}:${behaviors.length}"></div>`
      behaviors.push({ name, directive: resolution.directive, line: lineNo, props, marker: host })
    } else {
      const n = instanceLocal
      const common = `<div data-brust-island="${resolution.id}" data-brust-props="{{ island_${n}_props }}" data-brust-hydrate="${hydrate}"`
      host = csr
        ? `${common} data-brust-csr></div>`
        : `${common}>{{ island_${n}_html | safe }}</div>`
      islands.push({ name, instanceLocal: n, props, hydrate, csr, line: lineNo })
      instanceLocal++
    }
    lines[i] = slotPlaceholder(nonce, hosts.length)
    hosts.push(host)
  }

  return { source: lines.join('\n'), hosts, islands, behaviors }
}

interface ParsedTagAttrs {
  props: Record<string, unknown>
  hydrate: MdHydrate
  csr: boolean
}

/**
 * Parses the attr region of a component tag. Forms:
 * - `p="str"`      → string (verbatim, no escapes)
 * - `p={42}`       → JSON-parsed scalar
 * - `p={{"a":1}}`  → JSON object (the `{…}` content is JSON.parse'd)
 * - `flag`         → true
 * Reserved names `hydrate` / `csr` are pulled out of props.
 */
function parseTagAttrs(
  text: string,
  tagName: string,
  absPath: string,
  line: number,
): ParsedTagAttrs {
  const props: Record<string, unknown> = {}
  const fail = (msg: string): never => {
    throw new Error(`${absPath}:${line} — <${tagName}> ${msg}`)
  }

  let i = 0
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i] as string)) i++
    if (i >= text.length) break
    const nameMatch = /^[a-zA-Z][\w-]*/.exec(text.slice(i))
    if (nameMatch === null) return fail(`has a malformed attribute near: ${text.slice(i).trim()}`)
    const attrName = nameMatch[0]
    i += attrName.length

    let value: unknown = true
    if (text[i] === '=') {
      i++
      const open = text[i]
      if (open === '"') {
        const close = text.indexOf('"', i + 1)
        if (close === -1) return fail(`attribute "${attrName}" has an unterminated string value`)
        value = text.slice(i + 1, close)
        i = close + 1
      } else if (open === '{') {
        const end = scanBalancedBraces(text, i)
        if (end === -1) return fail(`attribute "${attrName}" has unbalanced braces`)
        const inner = text.slice(i + 1, end)
        try {
          value = JSON.parse(inner)
        } catch {
          return fail(`attribute "${attrName}" is not valid JSON: {${inner}}`)
        }
        i = end + 1
      } else {
        return fail(`attribute "${attrName}" value must be "…" or {…}`)
      }
    }
    if (attrName in props) {
      return fail(`has duplicate attribute "${attrName}"`)
    }
    props[attrName] = value
  }

  let hydrate: MdHydrate = 'load'
  if ('hydrate' in props) {
    const h = props.hydrate
    delete props.hydrate
    if (typeof h !== 'string' || !HYDRATE_MODES.includes(h as MdHydrate)) {
      return fail(
        `hydrate must be one of ${HYDRATE_MODES.join('|')}, got: ${JSON.stringify(h)}`,
      ) as never
    }
    hydrate = h as MdHydrate
  }
  let csr = false
  if ('csr' in props) {
    csr = props.csr !== false
    delete props.csr
  }
  return { props, hydrate, csr }
}

/**
 * Returns the index of the `}` closing the `{` at `start`, honoring nested
 * braces and JSON double-quoted strings (with backslash escapes); -1 if
 * unbalanced.
 */
function scanBalancedBraces(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

// ---------------------------------------------------------------------------
// Markdown → HTML (marked, GFM, heading ids, shiki fences)
// ---------------------------------------------------------------------------

async function renderMarkdown(source: string): Promise<string> {
  // Fresh instance per page: heading-id dedupe state is page-local.
  const slugCounts = new Map<string, number>()
  const highlighted = new WeakMap<Tokens.Code, string>()

  const marked = new Marked()
  marked.use({
    gfm: true,
    async: true,
    walkTokens: async (token) => {
      if (token.type === 'code') {
        const code = token as Tokens.Code
        highlighted.set(code, await highlightCode(code.text, code.lang ?? ''))
      }
    },
    renderer: {
      code(token: Tokens.Code): string {
        return `${highlighted.get(token) ?? fallbackCodeBlock(token.text, token.lang ?? '')}\n`
      },
      heading({ tokens, depth }: Tokens.Heading): string {
        const text = this.parser.parseInline(tokens, this.parser.textRenderer)
        const base = slugify(text)
        const seen = slugCounts.get(base) ?? 0
        slugCounts.set(base, seen + 1)
        const id = seen === 0 ? base : `${base}-${seen + 1}`
        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`
      },
    },
  })
  return marked.parse(source)
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Renders one markdown page body to jinja-safe HTML.
 *
 * Order is load-bearing (locked by tests):
 * 1. extract component-tag lines to opaque placeholders (marked never sees them)
 * 2. render markdown (GFM, heading ids, shiki fences)
 * 3. neutralize jinja braces over the rendered HTML
 * 4. substitute placeholders with host markup — its jinja stays live
 */
export async function renderMdPage(
  opts: RenderMdPageOptions,
): Promise<{ html: string; islands: MdIslandUse[]; behaviors: MdBehaviorUse[] }> {
  const nonce = Math.random().toString(16).slice(2, 10)
  const { source, hosts, islands, behaviors } = extractComponentTags(
    opts.body,
    opts.absPath,
    opts.resolve,
    nonce,
  )
  const rendered = await renderMarkdown(source)
  let html = neutralizeBraces(rendered)
  for (let n = 0; n < hosts.length; n++) {
    html = html.replaceAll(slotPlaceholder(nonce, n), hosts[n] as string)
  }
  return { html, islands, behaviors }
}
