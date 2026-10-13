// A code block in a terminal pane: a tab bar (file name or working directory) with a Copy button, then the code.
// Build the props in the page loader with codeBlock() from lib/highlight.ts (never a JSX literal: see that file).
// `html` is the highlighted markup from codeBlock() (escaped by lib/highlight.ts); without it the code shows as plain text.
import CopyButton from './CopyButton'

export default function CodeBlock({ code, lang, file, cwd, html }: { code: string; lang: string; file?: string; cwd?: string; html?: string }) {
  return (
    // `code` stays as a hook class with no rule of its own: CopyButton finds the block by it, and the landing's
    // `.panel .code pre` rule and the scrollbar rules in app.css are written against it.
    <figure className="code m-0 min-w-0 overflow-hidden rounded-[2px] border border-term-rule bg-term text-[13.5px] leading-[1.6] text-term-fg">
      <div className="flex items-stretch justify-between border-b border-term-rule bg-term-2 font-mono text-[12px] text-term-dim">
        {file ? (
          <span className="relative bg-term px-[.9rem] py-[.4rem] text-term-fg [box-shadow:1px_0_0_var(--term-rule)] before:absolute before:inset-x-0 before:top-0 before:h-[2px] before:bg-sun before:content-['']">{file}</span>
        ) : (
          <span className="px-[.9rem] py-[.4rem] text-term-dim">{cwd}</span>
        )}
        <CopyButton text={code} lang={lang} />
      </div>
      <pre className="m-0 overflow-x-auto px-4 py-[.9rem] [scrollbar-color:var(--term-rule)_transparent] [scrollbar-width:thin]">
        {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
      </pre>
    </figure>
  )
}
