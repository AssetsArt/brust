// "Actions, typed end to end" and "One store, both sides": two columns of code.
import type { CodeBlockData } from '../../lib/highlight'
import Code from './Code'

export default function ActionsStore({ actions, client, store, teamCount }: { actions: CodeBlockData; client: CodeBlockData; store: CodeBlockData; teamCount: CodeBlockData }) {
  return (
    <section className="sec">
      <div className="wrap pair">
        <div>
          <h2>Actions, typed end to end</h2>
          <p>
            One Elysia app, served by Rust under <code>/_brust/action</code>. The browser gets a client that knows every route and its types.
          </p>
          <Code b={actions} />
          <Code b={client} />
        </div>
        <div>
          <h2>One store, both sides</h2>
          <p>Define a store once. The server fills it while rendering, the browser picks it up as a snapshot, and native components and islands read the same signals.</p>
          <Code b={store} />
          <Code b={teamCount} />
        </div>
      </div>
    </section>
  )
}
