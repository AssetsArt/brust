// website/lib/highlight.ts — server-side syntax highlighting for CodeBlock (ruling dd484eca: runs in page loaders).
// A CodeBlock that highlighted its own `code` prop would get a precompute job, and a page passing literal code would
// fail the build (instance-prop-path), so loaders build every block with codeBlock() and pass the result as props.
import { createHighlighterCore, type ThemeRegistrationRaw } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import json from 'shiki/langs/json.mjs'
import toml from 'shiki/langs/toml.mjs'
import tsx from 'shiki/langs/tsx.mjs'
import typescript from 'shiki/langs/typescript.mjs'

export type Lang = 'ts' | 'tsx' | 'json' | 'toml' | 'sh' | 'text'

export interface CodeBlockInput {
  code: string
  lang: Lang
  /** File name shown as the tab, e.g. `routes.tsx`. */
  file?: string
  /** Working directory shown instead of a file, e.g. `~/my-app`. */
  cwd?: string
}

export interface CodeBlockData extends CodeBlockInput {
  /** Highlighted inner HTML of the `<code>` element: spans with the canon classes k/s/f/t/c/n/ps. */
  html: string
}

// The theme carries no real colours: each canon class gets a marker colour, and tokensToHtml turns the
// marker back into the class, so the palette stays in app.css (light/dark tokens --sy-*).
const CLASS_BY_MARK: Record<string, string> = { '#00000A': 'k', '#00000B': 's', '#00000C': 'f', '#00000D': 't', '#00000E': 'c', '#00000F': 'n' }
const theme: ThemeRegistrationRaw = {
  name: 'brust-canon',
  type: 'dark',
  settings: [
    { settings: { foreground: '#000000', background: '#000001' } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#00000E' } },
    { scope: ['string', 'punctuation.definition.string', 'string.template', 'string.quoted'], settings: { foreground: '#00000B' } },
    { scope: ['constant.numeric', 'constant.language.boolean', 'constant.language.null', 'constant.language.undefined'], settings: { foreground: '#00000F' } },
    {
      scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control', 'keyword.operator.new', 'keyword.operator.expression', 'variable.language.this'],
      settings: { foreground: '#00000A' },
    },
    { scope: ['keyword.operator', 'keyword.operator.assignment', 'keyword.operator.arithmetic', 'keyword.operator.relational'], settings: { foreground: '#000000' } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function'], settings: { foreground: '#00000C' } },
    { scope: ['entity.name.tag', 'support.class.component', 'punctuation.definition.tag'], settings: { foreground: '#00000D' } },
  ],
}

const SHIKI_LANG: Partial<Record<Lang, string>> = { ts: 'typescript', tsx: 'tsx', json: 'json', toml: 'toml' }

const highlighter = await createHighlighterCore({
  themes: [theme],
  langs: [typescript, tsx, json, toml],
  engine: createJavaScriptRegexEngine(),
})

export function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function span(cls: string | undefined, text: string): string {
  return cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text)
}

function highlightSource(code: string, lang: string): string {
  const lines = highlighter.codeToTokensBase(code, { lang, theme: 'brust-canon' })
  return lines
    .map((line) => {
      let out = ''
      let cls: string | undefined
      let buf = ''
      for (const tok of line) {
        const next = CLASS_BY_MARK[(tok.color ?? '').toUpperCase()]
        if (next !== cls && buf) {
          out += span(cls, buf)
          buf = ''
        }
        cls = next
        buf += tok.content
      }
      return out + span(cls, buf)
    })
    .join('\n')
}

// Shell sessions: `$ ` lines are commands (the prompt is not selectable), every other line is output.
function highlightShell(code: string): string {
  return code
    .split('\n')
    .map((line) => (line.startsWith('$ ') ? `<span class="ps">$ </span>${escapeHtml(line.slice(2))}` : line ? span('c', line) : ''))
    .join('\n')
}

export function highlight(code: string, lang: Lang): string {
  if (lang === 'sh') return highlightShell(code)
  const shikiLang = SHIKI_LANG[lang]
  return shikiLang ? highlightSource(code, shikiLang) : escapeHtml(code)
}

const memo = new Map<string, CodeBlockData>()

/** Builds one CodeBlock's props in a loader; memoised per (lang, code) for the life of the worker. */
export function codeBlock(input: CodeBlockInput): CodeBlockData {
  const key = `${input.lang}\0${input.code}`
  let hit = memo.get(key)
  if (!hit) {
    hit = { code: input.code, lang: input.lang, html: highlight(input.code, input.lang) }
    memo.set(key, hit)
  }
  return { ...hit, ...(input.file === undefined ? {} : { file: input.file }), ...(input.cwd === undefined ? {} : { cwd: input.cwd }) }
}
