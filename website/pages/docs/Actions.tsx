// Actions — one Elysia 2 app behind the Rust server, the typed client, errors; the demo calls this site's real actions.
import type { LoaderCtx } from '@brust/core/routes'
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import Step from '../../components/docs/Step'
import TeamPicker from '../../components/demos/TeamPicker'
import { MAX_TEAM, teamFromValue } from '../../components/demos/team-cookie'
import { team } from '../../components/demos/team-store'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'
import { byId, displayName, spriteUrl } from '../../lib/pokemon'

export interface ActionsData {
  toc: TocItem[]
  blocks: Record<'install' | 'toml' | 'app' | 'client' | 'errors', CodeBlockData>
  candidates: { id: number; name: string; sprite: string }[]
}

const TOML = `[actions]
# every key is optional:
# entry = "actions.ts"
# prefix = "/_brust/action"
# max_body_bytes = 1048576
# max_response_bytes = 8388608
# cross_site = "reject"`

const APP = `// actions.ts (this site's, trimmed): the team lives in a cookie
import { brust } from '@brust/core/elysia'
import { Elysia, problem, t } from 'elysia'

const app = new Elysia({ adapter: brust() })
  .get('/team', ({ request }) => ({ team: teamFromCookie(request.headers.get('cookie')), max: 6 }))
  .post('/team', { body: t.Object({ id: t.Integer({ minimum: 1 }) }) }, ({ body, request, set }) => {
    const team = teamFromCookie(request.headers.get('cookie'))
    if (team.length >= 6) return problem(409, { title: 'TeamFull', detail: 'the team already has 6 members', max: 6 })
    return save(set, [...team, member(body.id)])
  })
  .delete('/team/:id', { params: t.Object({ id: t.Integer({ minimum: 1 }) }) }, ({ params, request, set }) =>
    save(set, teamFromCookie(request.headers.get('cookie')).filter((m) => m.id !== params.id)))

export default app
export type App = typeof app`

const CLIENT = `// components/demos/team-client.ts
import { client } from '@brust/core/client'
import type { App } from '../../actions'   // a type import: no Elysia in the browser
import { team } from './team-store'

const api = client<App>()

export async function addMember(id: number): Promise<string> {
  const r = await api.team.post({ id })
  if (r.error) return r.error.status === 409 ? 'team full' : \`failed with status \${r.error.status}\`
  team.members.set(r.data.team)
  return ''
}`

const ERRORS = `return problem(409, { title: 'TeamFull', max: 6 })   // returned: typed on the client
throw new TeamFull(6)                                  // an HTTPError.id('TEAM_FULL') subclass: unknown on the client
throw new Error('boom')                                // 500 problem+json, detail only outside production`

const PICK = [25, 1, 4, 7, 133, 143, 150, 94]

export async function actionsLoader({ req }: LoaderCtx): Promise<ActionsData> {
  team.members.set(teamFromValue(req.cookies.brust_docs_team))
  team.max.set(MAX_TEAM)
  return {
    toc: [
      { id: 'install', title: 'Turn actions on' },
      { id: 'app', title: 'Write the app' },
      { id: 'client', title: 'Call it from a component' },
      { id: 'try', title: 'Try it' },
      { id: 'errors', title: 'Errors and limits' },
    ],
    blocks: {
      install: codeBlock({ lang: 'sh', cwd: '~/my-app', code: '$ bun add elysia@2.0.0-beta.30 @elysia/eden@2.0.0-beta.6' }),
      toml: codeBlock({ lang: 'toml', file: 'brust.toml', code: TOML }),
      app: codeBlock({ lang: 'ts', file: 'actions.ts', code: APP }),
      client: codeBlock({ lang: 'ts', file: 'components/demos/team-client.ts', code: CLIENT }),
      errors: codeBlock({ lang: 'ts', file: 'actions.ts', code: ERRORS }),
    },
    candidates: PICK.map((id) => ({ id, name: displayName(byId(id)!.name), sprite: spriteUrl(id) })),
  }
}

export default function Actions({ blocks, candidates }: ActionsData) {
  return (
    <section style={{ display: 'contents' }}>
      <h1>Actions</h1>
      <p className="lead">Actions are the server endpoints your pages call. In brust they are one Elysia 2 app, served behind the Rust server: no second port, no second router.</p>

      <Step n={1} id="install" title="Turn actions on" />
      <p>Install the two pinned packages and add an <code>[actions]</code> table to <code>brust.toml</code>. Without the table, actions are off even if <code>actions.ts</code> exists.</p>
      <CodeBlock code={blocks.install.code} lang={blocks.install.lang} cwd={blocks.install.cwd} html={blocks.install.html} />
      <CodeBlock code={blocks.toml.code} lang={blocks.toml.lang} file={blocks.toml.file} html={blocks.toml.html} />

      <Step n={2} id="app" title="Write the app" />
      <p>
        The entry default-exports an Elysia app built with the <code>brust()</code> adapter, and exports its type. Route methods take <code>(path, hook, handler)</code>: the schema comes before the handler. Do not call <code>app.listen()</code>: Rust serves the app.
      </p>
      <CodeBlock code={blocks.app.code} lang={blocks.app.lang} file={blocks.app.file} html={blocks.app.html} />
      <p>
        Every request under the prefix, <code>/_brust/action</code> by default, goes to this app in a Bun worker. Rust answers CORS preflights, caps the request body (413) and the response size, before and after your code.
      </p>

      <Step n={3} id="client" title="Call it from a component" />
      <p>
        <code>client&lt;App&gt;()</code> from <code>@brust/core/client</code> is a typed Eden Treaty client, already pointed at the prefix. Import the app's type only: a value import would pull Elysia into the browser, and the build refuses it.
      </p>
      <CodeBlock code={blocks.client.code} lang={blocks.client.lang} file={blocks.client.file} html={blocks.client.html} />
      <p>
        Every call resolves to <code>{'{ data, error, status, response, headers }'}</code>, with exactly one of <code>data</code> and <code>error</code> set. A network failure resolves with status 503.
      </p>

      <Step n={4} id="try" title="Try it" />
      <p>
        Each button calls <code>POST /_brust/action/team</code> on this site. The team is kept in a cookie, so it is yours alone, and the reply goes into the <code>team</code> store that the buttons read. The <a href="/docs/store">Store</a> page shows the same team.
      </p>
      <div className="browser">
        <div className="url">
          <span>POST /_brust/action/team</span>
          <span className="lbl">TeamPicker · native</span>
        </div>
        <div className="vp">
          <TeamPicker candidates={candidates} />
        </div>
      </div>

      <Step n={5} id="errors" title="Errors and limits" />
      <CodeBlock code={blocks.errors.code} lang={blocks.errors.lang} file={blocks.errors.file} html={blocks.errors.html} />
      <ul>
        <li>An unknown path or a wrong method under the prefix is a 404 problem+json from Elysia; there is no 405.</li>
        <li>Outside the prefix, a non-GET request to a page is a 405 from Rust.</li>
        <li>
          Cross-site requests are rejected by default (<code>cross_site = "reject"</code>). Behind a proxy, pass <code>Host</code> through or set <code>X-Forwarded-Host</code>, or same-origin POSTs get a 403.
        </li>
      </ul>
      <Note>
        A store written inside an action is per-request and never reaches the page. Return the data and set the store in the browser with the reply, as <code>addMember</code> does.
      </Note>
    </section>
  )
}
