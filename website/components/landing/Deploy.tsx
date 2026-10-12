// "Deploy where you like": the same routes file for a Bun process or Cloudflare Workers.
import type { CodeBlockData } from '../../lib/highlight'
import CodeBlock from '../CodeBlock'

export default function Deploy({ selfHost, workers }: { selfHost: CodeBlockData; workers: CodeBlockData }) {
  return (
    <section className="sec">
      <div className="wrap">
        <div className="head">
          <h2>Deploy where you like</h2>
          <p>The same routes file builds for a Bun process on your own machine or for Cloudflare Workers. Nothing in the app changes.</p>
        </div>
        <div className="pair">
          <div>
            <h3>Your server</h3>
            <p>A Rust server handles HTTP; Bun workers run loaders and actions beside it.</p>
            <CodeBlock code={selfHost.code} lang={selfHost.lang} file={selfHost.file} cwd={selfHost.cwd} html={selfHost.html} />
          </div>
          <div>
            <h3>Cloudflare Workers</h3>
            <p>
              The build emits a Worker, the static assets and a merged <code>wrangler.jsonc</code>. D1 and KV bind as usual.
            </p>
            <CodeBlock code={workers.code} lang={workers.lang} file={workers.file} cwd={workers.cwd} html={workers.html} />
          </div>
        </div>
      </div>
    </section>
  )
}
