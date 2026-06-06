import { Info, Lightbulb } from 'lucide-react'
import CodeBlock from '../components/CodeBlock'

export default function Installation({
  scaffoldHtml,
  addHtml,
  pkgHtml,
}: {
  scaffoldHtml: string
  addHtml: string
  pkgHtml: string
}) {
  return (
    <article className="b-prose">
      <header className="b-pagehead">
        <p className="b-eyebrow">Getting Started</p>
        <h1>Installation</h1>
        <p className="b-lead">
          brust requires Bun. The native addon ships prebuilt for Linux (glibc and musl) and macOS —
          no Rust toolchain needed to use it.
        </p>
      </header>

      <h2 id="scaffold">Scaffold a new app</h2>
      <p>
        The fastest way to start is the project creator. It writes a minimal app, installs
        dependencies, and prints the dev command.
      </p>
      <CodeBlock native html={scaffoldHtml} lang="bash" />
      <p>
        Open <code>http://localhost:1337</code>. The dev server boots in a few milliseconds and
        hot-reloads on save.
      </p>

      <div className="b-callout b-callout--tip">
        <span className="b-callout__ic">
          <Lightbulb size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">Prerequisites</p>
          <p>
            You only need Bun. The Rust server is a prebuilt binary pulled in as a dependency — you
            don't install <code>cargo</code> unless you're building native addons of your own.
          </p>
        </div>
      </div>

      <h2 id="add-existing">Add to an existing project</h2>
      <p>brust is a regular Bun package. Add the runtime and React:</p>
      <CodeBlock native html={addHtml} lang="bash" />
      <p>
        Then wire the scripts in your <code>package.json</code>:
      </p>
      <CodeBlock native html={pkgHtml} lang="json" />

      <div className="b-callout b-callout--info">
        <span className="b-callout__ic">
          <Info size={18} />
        </span>
        <div className="b-callout__body">
          <p className="b-callout__title">Supported targets</p>
          <p>
            Prebuilt binaries cover <code>linux-x64-gnu</code>, <code>linux-x64-musl</code>,{' '}
            <code>linux-arm64-gnu</code>, and <code>darwin-arm64</code>. Other targets fall back to
            a source build (needs a Rust toolchain).
          </p>
        </div>
      </div>
    </article>
  )
}
