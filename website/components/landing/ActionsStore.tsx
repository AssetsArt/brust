// "Actions, typed end to end" and "One store, both sides": two columns of code.
import type { CodeBlockData } from '../../lib/highlight'
import CodeBlock from '../CodeBlock'
import ElysiaLink from '../ElysiaLink'

export default function ActionsStore({ actions, client, store, teamCount }: { actions: CodeBlockData; client: CodeBlockData; store: CodeBlockData; teamCount: CodeBlockData }) {
  return (
    <section className="border-t border-rule py-18">
      <div className="mx-auto grid max-w-[1160px] grid-cols-2 gap-0 px-4 max-wide:grid-cols-1 max-wide:gap-10">
        <div className="grid min-w-0 content-start gap-[.9rem] pr-10 max-wide:pr-0">
          <h2>Actions, typed end to end</h2>
          <p className="text-ink-2">
            One <ElysiaLink /> app, served by Rust under <code>/_brust/action</code>. The browser gets a client that knows every route and its types.
          </p>
          <CodeBlock code={actions.code} lang={actions.lang} file={actions.file} cwd={actions.cwd} html={actions.html} />
          <CodeBlock code={client.code} lang={client.lang} file={client.file} cwd={client.cwd} html={client.html} />
        </div>
        <div className="grid min-w-0 content-start gap-[.9rem] border-l border-rule pl-10 max-wide:border-t max-wide:border-l-0 max-wide:pt-10 max-wide:pl-0">
          <h2>One store, both sides</h2>
          <p className="text-ink-2">Define a store once. The server fills it while rendering, the browser picks it up as a snapshot, and native components and islands read the same signals.</p>
          <CodeBlock code={store.code} lang={store.lang} file={store.file} cwd={store.cwd} html={store.html} />
          <CodeBlock code={teamCount.code} lang={teamCount.lang} file={teamCount.file} cwd={teamCount.cwd} html={teamCount.html} />
        </div>
      </div>
    </section>
  )
}
