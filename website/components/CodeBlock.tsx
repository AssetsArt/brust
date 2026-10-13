// A code block in a terminal pane: a tab bar (file name or working directory) with a Copy button, then the code.
// Build the props in the page loader with codeBlock() from lib/highlight.ts (never a JSX literal: see that file).
// `html` is the highlighted markup from codeBlock() (escaped by lib/highlight.ts); without it the code shows as plain text.
import CopyButton from './CopyButton'

export default function CodeBlock({ code, lang, file, cwd, html }: { code: string; lang: string; file?: string; cwd?: string; html?: string }) {
  return (
    <figure className="code">
      <div className="bar">
        {file ? <span className="tab">{file}</span> : <span className="cwd">{cwd}</span>}
        <CopyButton text={code} lang={lang} />
      </div>
      <pre>
        {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
      </pre>
    </figure>
  )
}
