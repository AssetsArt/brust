// "Actions, typed end to end" and "One store, both sides": two columns of code.
import type { CodeBlockData } from '../../lib/highlight'
import CodeBlock from '../CodeBlock'

export default function ActionsStore({ actions, client, store, teamCount }: { actions: CodeBlockData; client: CodeBlockData; store: CodeBlockData; teamCount: CodeBlockData }) {
  return (
    <section className="sec">
      <div className="wrap pair">
        <div>
          <h2>Actions, typed end to end</h2>
          <p>
            One Elysia app, served by Rust under <code>/_brust/action</code>. The browser gets a client that knows every route and its types.
          </p>
          <CodeBlock code={actions.code} lang={actions.lang} file={actions.file} cwd={actions.cwd} html={actions.html} />
          <CodeBlock code={client.code} lang={client.lang} file={client.file} cwd={client.cwd} html={client.html} />
        </div>
        <div>
          <h2>One store, both sides</h2>
          <p>Define a store once. The server fills it while rendering, the browser picks it up as a snapshot, and native components and islands read the same signals.</p>
          <CodeBlock code={store.code} lang={store.lang} file={store.file} cwd={store.cwd} html={store.html} />
          <CodeBlock code={teamCount.code} lang={teamCount.lang} file={teamCount.file} cwd={teamCount.cwd} html={teamCount.html} />
        </div>
      </div>
    </section>
  )
}
