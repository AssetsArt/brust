import { Info, Lightbulb } from 'lucide-react'
import CodeBlock from '../components/CodeBlock'

export default function Styling({
  tailwindHtml,
  classHtml,
  cssModuleHtml,
  cssModuleUseHtml,
}: {
  tailwindHtml: string
  classHtml: string
  cssModuleHtml: string
  cssModuleUseHtml: string
}) {
  return (
    <article className="b-prose">
      <header className="b-pagehead">
        <p className="b-eyebrow">Core concepts</p>
        <h1>Styling</h1>
        <p className="b-lead">
          brust ships with Tailwind v4 wired in and CSS Modules for component-scoped styles. Both
          work in native routes and React islands without extra config.
        </p>
      </header>

      <h2 id="tailwind">Tailwind v4</h2>
      <p>
        Tailwind is set up out of the box. The dev server runs the v4 engine; the build inlines only
        the classes you used. Author with utilities in <code>className</code> — brust scans both
        native and React component sources.
      </p>
      <CodeBlock native html={tailwindHtml} lang="css" />
      <CodeBlock native html={classHtml} lang="tsx" />
      <div className="b-callout b-callout--info">
        <span className="b-callout__ic">
          <Info size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">No config file by default</p>
          <p>
            Tailwind v4 reads its theme from CSS <code>@theme</code> blocks. brust generates the
            content globs from your sources, so there's nothing to configure unless you want to.
          </p>
        </div>
      </div>

      <h2 id="css-modules">CSS Modules</h2>
      <p>
        For component-scoped styles, name a file <code>*.module.css</code> and import it. Class
        names are hashed at build time, so styles never leak between components — and this works in
        native routes, not just React.
      </p>
      <CodeBlock native html={cssModuleHtml} lang="css" />
      <CodeBlock native html={cssModuleUseHtml} lang="tsx" />
      <div className="b-callout b-callout--tip">
        <span className="b-callout__ic">
          <Lightbulb size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">Mix freely</p>
          <p>
            Use Tailwind for layout and spacing, CSS Modules for the handful of bespoke component
            styles utilities don't express well. They compose — a <code>className</code> can carry
            both. This very site styles its shell with token-driven <code>.b-*</code> classes.
          </p>
        </div>
      </div>
    </article>
  )
}
