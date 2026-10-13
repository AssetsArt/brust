// "Deploy where you like": the same routes file for a Bun process or Cloudflare Workers.
import type { CodeBlockData } from '../../lib/highlight'
import CodeBlock from '../CodeBlock'
import SecHead from './SecHead'

export default function Deploy({ selfHost, workers }: { selfHost: CodeBlockData; workers: CodeBlockData }) {
  return (
    <section className="border-t border-rule py-18">
      <div className="mx-auto max-w-[1160px] px-4">
        <SecHead title="Deploy where you like" lede="The same routes file builds for a Bun process on your own machine or for Cloudflare Workers. Nothing in the app changes." />
        <div className="grid grid-cols-2 gap-0 max-wide:grid-cols-1 max-wide:gap-10">
          <div className="grid min-w-0 content-start gap-[.9rem] pr-10 max-wide:pr-0">
            <h3>Your server</h3>
            <p className="text-ink-2">A Rust server handles HTTP; Bun workers run loaders and actions beside it.</p>
            <CodeBlock code={selfHost.code} lang={selfHost.lang} file={selfHost.file} cwd={selfHost.cwd} html={selfHost.html} />
          </div>
          <div className="grid min-w-0 content-start gap-[.9rem] border-l border-rule pl-10 max-wide:border-t max-wide:border-l-0 max-wide:pt-10 max-wide:pl-0">
            <h3>Cloudflare Workers</h3>
            <p className="text-ink-2">
              The build emits a Worker, the static assets and a merged <code>wrangler.jsonc</code>. D1 and KV bind as usual.
            </p>
            <CodeBlock code={workers.code} lang={workers.lang} file={workers.file} cwd={workers.cwd} html={workers.html} />
          </div>
        </div>
      </div>
    </section>
  )
}
