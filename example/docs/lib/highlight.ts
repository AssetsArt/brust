// Server-side syntax highlighting. Runs in the loader (Bun worker) via Prism and
// returns token HTML, which a native CodeBlock injects with dangerouslySetInnerHTML
// → `{{ (html) | safe }}`. Zero client JS (the design highlighted client-side with
// window.Prism; doing it in the loader is the native way). Token colors live in
// app.css under `.b-code .token.*` (the AssetsArt violet code theme).
import Prism from 'prismjs'
import 'prismjs/components/prism-typescript.js'
import 'prismjs/components/prism-jsx.js'
import 'prismjs/components/prism-tsx.js'
import 'prismjs/components/prism-bash.js'
import 'prismjs/components/prism-json.js'
import 'prismjs/components/prism-rust.js'

const LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  typescript: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  javascript: 'javascript',
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  json: 'json',
  rust: 'rust',
  rs: 'rust',
  css: 'css',
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Highlight `code` for `lang` → token HTML (Prism class spans). Falls back to an
 * HTML-escaped string for unknown languages. Trailing whitespace trimmed. */
export function highlightCode(code: string, lang = 'tsx'): string {
  const key = LANG[lang] ?? 'typescript'
  const grammar = Prism.languages[key]
  const src = code.replace(/\s+$/, '')
  if (grammar) {
    try {
      return Prism.highlight(src, grammar, key)
    } catch {
      /* fall through to escaped */
    }
  }
  return escapeHtml(src)
}
