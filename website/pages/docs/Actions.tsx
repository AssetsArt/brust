// Actions — one Elysia 2 app behind the Rust server, the typed client, errors, and actions deployed on their own origin
// (--actions-only, base_url, credentials, cross-origin calls). This site is a static export (plan R5), so the demos run
// the same rules in the browser; the Elysia app below is the reference, not this site's code.
// The cross-origin section (step 6) cites its sources in `source:` comments (files at v2 @00e116c, merged into
// docs-site @0689b0c); "observed:" lines were run, not read.
import CodeBlock from '../../components/CodeBlock'
import Note from '../../components/docs/Note'
import Step from '../../components/docs/Step'
import CrossOriginCheck from '../../components/demos/CrossOriginCheck'
import TeamPicker from '../../components/demos/TeamPicker'
import { type CodeBlockData, codeBlock } from '../../lib/highlight'
import type { TocItem } from '../../lib/nav'
import { byId, displayName, spriteUrl } from '../../lib/pokemon'
import ElysiaLink from '../../components/ElysiaLink'
import Frame from '../../components/docs/Frame'
import Lead from '../../components/docs/Lead'

export interface ActionsData {
  toc: TocItem[]
  blocks: Record<'install' | 'toml' | 'app' | 'client' | 'errors' | 'apiToml' | 'apiBuild' | 'webToml' | 'injected' | 'cookie', CodeBlockData>
  candidates: { id: number; name: string; sprite: string }[]
}

const TOML = `[actions]
# every key is optional:
# entry = "actions.ts"
# prefix = "/_brust/action"
# max_body_bytes = 1048576
# max_response_bytes = 8388608
# cross_site = "reject"
# base_url = "https://api.example.com"   # actions on another origin (step 6)
# credentials = "same-origin"`

const APP = `// actions.ts: a team kept in a cookie (the app the demo below mirrors in the browser)
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

const CLIENT = `// components/team-client.ts
import { client } from '@brust/core/client'
import type { App } from '../actions'   // a type import: no Elysia in the browser
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

// source: docs/actions.md §11 (the two brust.toml files of a split deployment)
const API_TOML = `[actions]
entry = "actions.ts"
prefix = "/"                            # only in an --actions-only build

[cors]
origins = ["https://app.example.com"]   # the exact page origin
credentials = true                      # only if the page sends cookies`

const WEB_TOML = `[actions]
base_url = "https://api.example.com"   # an origin: no path, query, fragment or credentials
prefix = "/"                           # the prefix the other deployment mounts at
credentials = "include"                # same-origin (default) | include | omit`

// source: crates/brust-core/src/config.rs:160-185 (the tags) and :343 (the expected output in its test)
const INJECTED = `<script>globalThis.__BRUST_ACTION_PREFIX__="/"</script><script>globalThis.__BRUST_ACTION_BASE__="https://api.example.com";globalThis.__BRUST_ACTION_CREDENTIALS__="include"</script>`

// source: docs/actions.md §11 (a cookie that must travel cross-site)
const COOKIE = `.post('/login', ({ cookie: { session } }) => {
  session.set({ value: token, httpOnly: true, sameSite: 'none', secure: true, path: '/' })
  return { ok: true }
})`

const PICK = [25, 1, 4, 7, 133, 143, 150, 94]

export async function actionsLoader(): Promise<ActionsData> {
  return {
    toc: [
      { id: 'install', title: 'Turn actions on' },
      { id: 'app', title: 'Write the app' },
      { id: 'client', title: 'Call it from a component' },
      { id: 'try', title: 'Try it' },
      { id: 'errors', title: 'Errors and limits' },
      { id: 'separate', title: 'Actions on their own origin' },
      { id: 'cross-origin', title: 'Calling across origins' },
    ],
    blocks: {
      install: codeBlock({ lang: 'sh', cwd: '~/my-app', code: '$ bun add elysia@2.0.0-beta.30 @elysia/eden@2.0.0-beta.6' }),
      toml: codeBlock({ lang: 'toml', file: 'brust.toml', code: TOML }),
      app: codeBlock({ lang: 'ts', file: 'actions.ts', code: APP }),
      client: codeBlock({ lang: 'ts', file: 'components/team-client.ts', code: CLIENT }),
      errors: codeBlock({ lang: 'ts', file: 'actions.ts', code: ERRORS }),
      apiToml: codeBlock({ lang: 'toml', file: 'api/brust.toml', code: API_TOML }),
      apiBuild: codeBlock({ lang: 'sh', cwd: '~/api', code: '$ brust build --actions-only\n$ brust start' }),
      webToml: codeBlock({ lang: 'toml', file: 'web/brust.toml', code: WEB_TOML }),
      injected: codeBlock({ lang: 'text', file: 'every page', code: INJECTED }),
      cookie: codeBlock({ lang: 'ts', file: 'api/actions.ts', code: COOKIE }),
    },
    candidates: PICK.map((id) => ({ id, name: displayName(byId(id)!.name), sprite: spriteUrl(id) })),
  }
}

export default function Actions({ blocks, candidates }: ActionsData) {
  return (
    <>
      <h1>Actions</h1>
      <Lead>Actions are the server endpoints your pages call. In brust they are one <ElysiaLink label="Elysia 2" /> app, served behind the Rust server: no second port, no second router.</Lead>

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
        On this site the demo runs in your browser; with <code>[actions]</code> on a brust server the same buttons call <code>POST /_brust/action/team</code>. The rules are the app's above: at most 6, a Pokémon already in the team is not added twice, and the seventh gets the <code>TeamFull</code> 409. The team is kept in your browser's storage and goes into the <code>team</code> store that the buttons read. The <a href="/docs/store">Store</a> page shows the same team.
      </p>
      <Frame title="runs in your browser" label="TeamPicker · native">
          <TeamPicker candidates={candidates} />
        
      </Frame>

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

      <Step n={6} id="separate" title="Actions on their own origin" />
      {/* source: docs/actions.md §11 (L16): pages and actions as two deployments on two origins */}
      <p>
        The pages and the actions can be two deployments: static pages on Cloudflare Pages and the actions on <code>api.example.com</code>, or an API server next to a front end hosted elsewhere. One build flag on the actions side, one setting on the pages side.
      </p>
      <h3 id="actions-only">The actions deployment</h3>
      {/* source: packages/brust/src/build/actions-only.ts:1-4 and :42-50 (no routes, no templates, no jobs; same Rust admission); packages/brust/src/cli.ts:11 and :59 (the flag) */}
      <p>
        <code>brust build --actions-only</code> builds a <code>dist/</code> with no pages: no routes, no templates, no jobs, no client chunks. The app still runs behind the same Rust admission: method gate, body caps, <code>Content-Encoding</code>, the cross-site guard and CORS. Every path outside the prefix is a 404 <code>application/problem+json</code>.
      </p>
      <CodeBlock code={blocks.apiToml.code} lang={blocks.apiToml.lang} file={blocks.apiToml.file} html={blocks.apiToml.html} />
      <CodeBlock code={blocks.apiBuild.code} lang={blocks.apiBuild.lang} cwd={blocks.apiBuild.cwd} html={blocks.apiBuild.html} />
      <ul>
        {/* source: packages/brust/src/build/actions-only.ts:27-28 (needs [actions]; not with --target static) and :34-35 ([cache] and base_url ignored with an info line); docs/cloudflare.md §6 (a Worker with only actions, no Static Assets) */}
        <li>
          It combines with <code>--target bun</code> (the default: <code>brust start</code> serves it) and <code>--target cloudflare</code> (a Worker with only actions and no Static Assets). It cannot be combined with <code>--target static</code>, and it needs an <code>[actions]</code> table. <code>[cache]</code> and route options are ignored, with an info line.
        </li>
        {/* source: packages/brust/src/actions/prefix.ts:10-24 (prefixError: root only for actions-only), packages/brust/src/build/config.ts:256-257 and packages/brust/src/build/index.ts:118 (a normal build refuses "/") */}
        <li>
          <code>prefix = "/"</code> is allowed only here (and in a page-only build that points at such a deployment), so <code>https://api.example.com/team</code> is the app's <code>/team</code>. A normal build refuses it: its page routes would be unreachable.
        </li>
        {/* source: packages/brust/src/actions/prefix.ts:12-23 (the prefix rules) */}
        <li>
          Any other prefix starts with <code>/</code>, has no trailing <code>/</code>, uses only <code>[A-Za-z0-9._~-]</code> segments (never <code>.</code> or <code>..</code>), and stays out of <code>/_brust/</code>; the default <code>/_brust/action</code> is the one exception.
        </li>
        {/* source: docs/actions.md §11 (request.url is the real URL; the server's own paths stay the server's) */}
        <li>
          Your routes are still written without the prefix and <code>request.url</code> is the real URL. The server's own paths (<code>/ping</code>, <code>/_brust/...</code>, <code>/public/...</code>) stay the server's.
        </li>
      </ul>

      <h3 id="base-url">The pages deployment</h3>
      {/* source: packages/brust/src/build/config.ts:14 and :280-284 (base_url and credentials under [actions], validated at build), packages/brust/src/actions/prefix.ts:28-45 (an origin only; the three credentials values) */}
      <p>
        On the pages side, <code>[actions] base_url</code> tells the browser client where the actions live, and <code>credentials</code> sets the default <code>RequestInit.credentials</code> of every call.
      </p>
      <CodeBlock code={blocks.webToml.code} lang={blocks.webToml.lang} file={blocks.webToml.file} html={blocks.webToml.html} />
      <ul>
        {/* source: packages/brust/src/config.ts:5-7 and :115-116 (env BRUST_ACTIONS_BASE_URL > run({ config }) > toml; credentials: run({ config }) > toml) */}
        <li>
          Both are runtime settings, like <code>[cors]</code>: each environment points at its own API without a rebuild. <code>base_url</code> comes from the env <code>BRUST_ACTIONS_BASE_URL</code>, then <code>run({'{ config: { actionsBaseUrl } }'})</code>, then the toml. <code>credentials</code> comes from <code>run({'{ config: { actionsCredentials } }'})</code>, then the toml.
        </li>
        {/* source: crates/brust-core/src/config.rs:157-185 (JSON string literal, <, >, &, U+2028, U+2029 escaped; prefix tag only when not the default, credentials tag only when not same-origin) */}
        <li>The server injects them into every page, next to the prefix, as JSON string literals that are safe inside a script:</li>
      </ul>
      <CodeBlock code={blocks.injected.code} lang={blocks.injected.lang} file={blocks.injected.file} html={blocks.injected.html} />
      <ul>
        {/* source: packages/brust/src/actions/client.ts:42-51 (base: opts.baseUrl, then __BRUST_ACTION_BASE__, then relative) and :32-39 (prefix order) */}
        <li>
          The client resolves the base as <code>client({'{ baseUrl }'})</code>, then the page's injected base, then the page's own origin. The typed client keeps importing <code>type App</code> from the shared source, so calls stay typed across the two deployments.
        </li>
        {/* source: packages/brust/src/actions/client.ts:58-60 (opts.init wins over the page's credentials default) */}
        <li>
          <code>init</code> passed to <code>client()</code> overrides the credentials default for that client.
        </li>
        {/* source: packages/brust/src/build/index.ts:113-118 (page-only: base_url set, the default entry file absent, entry not named in the toml) */}
        <li>
          <b>A page-only build.</b> With a <code>base_url</code> and no <code>actions.ts</code>, the build bundles no actions and mounts no local app; the base and prefix are still injected. A missing file that <code>entry</code> names explicitly is an error, never a page-only build.
        </li>
        {/* source: docs/actions.md §11 (with --target static the base is baked into the rendered pages, from the build's environment) */}
        <li>
          With <code>--target static</code>, the base is baked into the rendered pages from the build's environment. That is how static pages on Pages call actions on their own domain. See <a href="/docs/deployment">Deployment</a>.
        </li>
      </ul>

      <Step n={7} id="cross-origin" title="Calling across origins" />
      {/* source: docs/actions.md §11 ("credentials and cookies") and §9 (the cross-site guard) */}
      <p>
        Three things decide whether a cross-origin call works: the actions server's <code>[cors]</code>, its cross-site guard, and the browser's rule for credentials. Change the settings below to see each step.
      </p>
      <Frame title="runs in your browser, sends nothing" label="CrossOriginCheck · react">
          <CrossOriginCheck />
        
      </Frame>
      <ul>
        {/* source: docs/actions.md §8 (Eden's GET carries content-type: application/json, so a cross-origin GET is preflighted) and crates/brust-core/src/pipeline.rs:84-94 (Rust answers an allowed origin's preflight with a 204) */}
        <li>
          Every cross-origin call is preflighted, GET included: the client sends JSON. Rust answers the preflight of a listed origin with a 204 and the CORS headers. Any other origin gets no CORS headers, and the browser never sends the call.
        </li>
        {/* source: crates/brust-core/src/actions.rs:112-147 and cors.rs:101-107 (a cross-site POST passes only if its Origin is listed by name; "*" never counts) */}
        <li>
          A cross-site POST from an origin not listed by name in <code>[cors] origins</code> is a <code>403 CrossSiteRejected</code>, before the body is read. A wildcard <code>"*"</code> does not count; <code>cross_site = "allow"</code> turns the guard off.
        </li>
        {/* source: crates/brust-core/src/config.rs:46-58 (credentials with a wildcard is a boot error) and docs/actions.md §11 (credentials include needs the exact origin and credentials = true) */}
        <li>
          <code>credentials = "include"</code> needs the exact page origin in <code>[cors] origins</code> and <code>credentials = true</code>. <code>credentials = true</code> with <code>"*"</code> is a boot error.
        </li>
        {/* source: docs/actions.md §11 (SameSite=None; Secure; localhost counts as secure) */}
        <li>A cookie that must travel cross-site needs <code>SameSite=None; Secure</code>. Browsers treat <code>http://localhost</code> and <code>http://127.0.0.1</code> as secure, so this works in development.</li>
      </ul>
      <CodeBlock code={blocks.cookie.code} lang={blocks.cookie.lang} file={blocks.cookie.file} html={blocks.cookie.html} />
    </>
  )
}
