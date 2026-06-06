// NATIVE code block — AssetsArt code theme. Traffic-light dots, language label, and
// a copy button (behavior: reads the <pre> text → clipboard, flips the label). The
// `html` prop is server-highlighted token HTML (Prism, from the loader) injected raw
// via dangerouslySetInnerHTML → `{{ (html) | safe }}`. Token colors are in app.css.
import { signal } from 'brustjs/store'
import type { BehaviorCtx } from 'brustjs/native'

export const behavior = ({ el }: BehaviorCtx) => {
  const label = signal('Copy')
  const copy = () => {
    const txt = el.querySelector('pre')?.textContent ?? ''
    navigator.clipboard?.writeText?.(txt)
    label.set('Copied')
    setTimeout(() => label.set('Copy'), 1600)
  }
  return { label, copy }
}

export default function CodeBlock({ html, lang }: { html: string; lang?: string }) {
  return (
    <div className="b-code">
      <div className="b-code__head">
        <span className="b-code__dots">
          <i></i>
          <i></i>
          <i></i>
        </span>
        <span className="b-code__lang">{lang}</span>
        <button
          type="button"
          x-on-click="copy"
          x-text="label"
          aria-label="Copy code"
          className="b-code__copy"
        >
          Copy
        </button>
      </div>
      <div className="b-code__scroll">
        <pre>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: server-highlighted trusted code (Prism, build-time loader output) — the framework's documented raw-passthrough boundary, never user input */}
          <code dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      </div>
    </div>
  )
}
