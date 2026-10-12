// Cookbook: Form action — an Elysia 2 action behind the Rust server, called from a native form. Responses are real
// (curl against the built app); the form component was built as native and exercised in Chromium.
import CodeBlock from '../../../components/CodeBlock'
import Note from '../../../components/docs/Note'
import Step from '../../../components/docs/Step'
import { type CodeBlockData, type CodeBlockInput, codeBlock } from '../../../lib/highlight'
import type { TocItem } from '../../../lib/nav'

const SRC = {
  install: {
    lang: 'sh',
    cwd: '~/my-app',
    code: '$ bun add elysia@2.0.0-beta.30 @elysia/eden@2.0.0-beta.6',
  },
  toml: { lang: 'toml', file: 'brust.toml', code: '[actions]' },
  actions: {
    lang: 'ts',
    file: 'actions.ts',
    code: `import { brust } from '@brust/core/elysia'
import { Elysia, problem, t } from 'elysia'

const team: number[] = []
const MAX = 6

const app = new Elysia({ adapter: brust() })
  .get('/team', () => ({ team, max: MAX }))
  .post('/team', { body: t.Object({ id: t.Integer({ minimum: 1 }) }) }, ({ body }) => {
    if (team.length >= MAX) return problem(409, { title: 'TeamFull', max: MAX })
    if (!team.includes(body.id)) team.push(body.id)
    return { team, max: MAX }
  })

export default app
export type App = typeof app`,
  },
  api: {
    lang: 'ts',
    file: 'lib/api.ts',
    code: `import { client } from '@brust/core/client'
import type { App } from '../actions'

export const api = client<App>()`,
  },
  form: {
    lang: 'tsx',
    file: 'components/AddToTeam.tsx',
    code: `import { useState } from 'react'
import { api } from '../lib/api'

export default function AddToTeam() {
  const [id, setId] = useState('25')
  const [msg, setMsg] = useState('')
  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault()
    const r = await api.team.post({ id: Number(id) })
    if (r.error) setMsg(r.error.status === 409 ? 'The team is full' : \`Failed with \${r.error.status}\`)
    else setMsg(\`Team: \${r.data.team.length}/\${r.data.max}\`)
  }
  return (
    <form onSubmit={submit}>
      <input name="id" value={id} onChange={(e) => setId(e.target.value)} />
      <button type="submit">Add to team</button>
      <p>{msg}</p>
    </form>
  )
}`,
  },
  curl: {
    lang: 'sh',
    cwd: '~/my-app',
    code: `$ curl -si -X POST http://127.0.0.1:1337/_brust/action/team -H 'content-type: application/json' -d '{"id":25}'
HTTP/1.1 200 OK
{"team":[25],"max":6}

$ curl -si -X POST http://127.0.0.1:1337/_brust/action/team -H 'content-type: application/json' -d '{"id":0}'
HTTP/1.1 422 Unprocessable Entity
content-type: application/problem+json
{"type":"validation","code":"validation","title":"Validation Error","status":422,"on":"body","property":"/id"}`,
  },
} satisfies Record<string, CodeBlockInput>

export interface FormActionData {
  toc: TocItem[]
  blocks: Record<keyof typeof SRC, CodeBlockData>
}

export async function formActionLoader(): Promise<FormActionData> {
  return {
    toc: [
      { id: 'setup', title: 'Turn actions on' },
      { id: 'action', title: 'Write the action' },
      { id: 'form', title: 'Call it from a form' },
      { id: 'try', title: 'Try it' },
    ],
    blocks: Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, codeBlock(v)])) as FormActionData['blocks'],
  }
}

export default function FormAction({ blocks }: FormActionData) {
  return (
    <section style={{ display: 'contents' }}>
      <h1>Form action</h1>
      <p className="lead">
        A form that adds a Pokémon to a team of up to six. The server side is one Elysia 2 app behind the Rust server; the form is a native component.
      </p>

      <Step n={1} id="setup" title="Turn actions on" />
      <p>Actions are opt-in. Install the two pinned packages and add an <code>[actions]</code> table; every key in it is optional.</p>
      <CodeBlock code={blocks.install.code} lang={blocks.install.lang} cwd={blocks.install.cwd} html={blocks.install.html} />
      <CodeBlock code={blocks.toml.code} lang={blocks.toml.lang} file={blocks.toml.file} html={blocks.toml.html} />

      <Step n={2} id="action" title="Write the action" />
      <p>
        The entry default-exports an Elysia app built with the <code>brust()</code> adapter. In Elysia 2 the argument order is <code>(path, hook, handler)</code>: the schema comes before the handler. A body that fails the schema answers 422; a returned <code>problem(409, ...)</code> is typed on the client.
      </p>
      <CodeBlock code={blocks.actions.code} lang={blocks.actions.lang} file={blocks.actions.file} html={blocks.actions.html} />

      <Step n={3} id="form" title="Call it from a form" />
      <p>
        <code>client&lt;App&gt;()</code> is Eden Treaty wired to the actions mount. The <code>import type</code> is erased, so the browser bundle carries no Elysia. This form has state and handlers but nothing the native tier cannot express, so it compiles to a <span className="tier native">native</span> component.
      </p>
      <CodeBlock code={blocks.api.code} lang={blocks.api.lang} file={blocks.api.file} html={blocks.api.html} />
      <CodeBlock code={blocks.form.code} lang={blocks.form.lang} file={blocks.form.file} html={blocks.form.html} />

      <Step n={4} id="try" title="Try it" />
      <p>The same endpoint with curl: a valid body, then one that fails validation.</p>
      <CodeBlock code={blocks.curl.code} lang={blocks.curl.lang} cwd={blocks.curl.cwd} html={blocks.curl.html} />
      <Note>
        Actions are public endpoints. brust rejects cross-site non-GET requests by default (403), and nothing more: authentication is your app&rsquo;s job. The team array above lives in one worker&rsquo;s memory, so keep real state in a database. See <a href="/docs/actions">Actions</a>.
      </Note>
    </section>
  )
}
