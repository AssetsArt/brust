---
title: Agents
description: The built-in MCP server and window.Brust browser runtime — typed tools, route resources, and a framework-aware UI surface.
nav: { group: "Reference", order: 10 }
---

Every brust app is also an MCP server. The framework already knows what an
agent needs — your [actions](/docs/actions) are typed endpoints and your route
loaders return structured data — so it exposes both over the Model Context
Protocol (revision `2025-06-18`) at:

```text
POST /_brust/mcp        (JSON-RPC 2.0)
```

There is nothing to enable: `brust.run()` builds the manifest at boot and
wires the server into every worker. The transport is plain HTTP POST — no SSE
notifications or streaming (deferred) — which any MCP client that speaks
Streamable HTTP can use, as can `curl`:

```bash
curl -s -X POST http://localhost:1337/_brust/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Tools — from defineActions

Each endpoint registered on the `defineActions` chain in your `actions.ts`
becomes one tool, named `<method>_<path-slug>`: `POST /notes` → `post_notes`,
`GET /notes/{id}` → `get_notes_by_id`, a root path → `get_root`. Two
endpoints slugging to the same name fail the build; an endpoint with a
non-literal path string is skipped with a warning.

Schemas are **extracted from your TypeScript** — no hand-written JSON Schema:

| Schema part | Source |
|---|---|
| `inputSchema.params` | `{x}` segments in the path — each a required string. |
| `inputSchema.body` | The endpoint's `body` validator, via the handler ctx type. |
| `inputSchema.query` | The endpoint's `query` validator, likewise. |
| `outputSchema` | The handler's return type (`Promise` unwrapped). |
| `description` | The endpoint's `description` option. |

`tools/call` arguments nest by routing role — `{ params?, query?, body? }` —
and dispatch through the **same path as a real HTTP request**: body/query
validation (422 on failure), the endpoint middleware chain, and the typed
error contract all apply identically. The same auth that protects users
protects agents. The tool result carries the response body as text, with
`isError: true` for any status ≥ 400.

## Resources — from route loaders

Every route with a `loader` is listed as a resource at
`brust://<path-template>` (e.g. `brust:///pokemon/{name}`). `resources/read`
matches the URI against the route table — `{param}` segments capture — runs
the loader, and returns its result as JSON. Output schemas for resources are
not extracted yet.

## The manifest

A boot-time extractor walks `actions.ts` and `routes.tsx` with the TypeScript
compiler API and caches the result as `.brust/mcp-manifest.json`.
`brust build` ships it as `dist/mcp-manifest.json`, so a deployed dist serves
agents without doing any type analysis at boot. An app with no `actions.ts`
exposes zero tools — loaders still become resources.

## Protocol surface

| Method | Behavior |
|---|---|
| `initialize` | Protocol `2025-06-18`; capabilities: tools, resources, prompts, logging. |
| `tools/list`, `tools/call` | As above. |
| `resources/list`, `resources/read` | As above. |
| `prompts/list` | Always empty (no prompts surface). |
| `logging/setLevel` | Accepted; no notifications are emitted. |

That is the whole surface today: tools and resources derived from code you
already wrote, over POST. There is no separate agent SDK, CLI command, or
configuration file.

## Driving the UI — window.Brust

MCP is the server-side surface. When an agent is driving a real browser,
`window.Brust` gives its JavaScript evaluator a framework-aware view of the
current page and actions that dispatch normal DOM events. The results are
plain JSON, so the same calls work through Playwright, CDP, or an in-browser
`eval` tool.

The runtime is opt-in outside development:

| Mode | Activation |
|---|---|
| `brust dev` | On automatically. |
| Programmatic production | `run({ ai: true })` or `BRUST_AI=1`. |
| Prebuilt production | `brust build --ai` (or build with `BRUST_AI=1`). |

When it is off, the runtime chunk, manifest routes, and document script tag
are absent. There is no client cost.

### See the app

`pages()` reads the app's route manifest without crawling. Each entry includes
the route template, params, page kind, and shell id:

```js
const pages = await Brust.pages()
// [{ path: '/notes/{id}', params: ['id'], kind: 'react', shellId: 'L:…', … }]
```

`struct()` describes the page that is currently rendered: headings, links,
buttons, forms and fields, standalone inputs, React islands, and native
`x-data` behaviors. Every actionable element has a short opaque ref:

```js
await (async () => {
  const page = await Brust.struct({ maxText: 120 })
  if ('ok' in page && page.ok === false) return page
  return page.buttons.find((button) => button.text === 'Create note')
})()
// { ref: 'e7', text: 'Create note', disabled: false, kind: 'button' }
```

Scope a snapshot with either a ref or a CSS selector:

```js
await Brust.struct({ within: '#account-settings', maxText: 80 })
```

Refs remain valid while their element remains attached, but every navigation
invalidates the whole generation. A stale ref returns `code: 'stale-ref'`;
run `Brust.struct()` again before the next action.

### Act on the page

Every action target accepts a ref or a CSS selector. Actions scroll the target
into view, dispatch bubbling and cancelable DOM events, wait for the page to
settle, then return the resulting URL and any errors raised during the action.

| Method | Use |
|---|---|
| `action.click(target)` | Pointer down/up/click sequence. |
| `action.focus(target)`, `action.blur(target)` | Move focus. |
| `action.fill(target, value)` | Fill input, textarea, select, or contenteditable. |
| `action.form(nameOrRef, values, options?)` | Fill named fields and submit with `requestSubmit()`. |
| `action.press(target, key)` | Keydown/keypress/keyup sequence. |
| `action.select(target, valueOrLabel)` | Select an option by value or label. |
| `action.check(target, boolean)` | Set a checkbox or radio. |

The form name comes from `data-ai-name`, then `name`, then `id`:

```js
await Brust.action.form('new-note', {
  title: 'Release notes',
  body: 'Document the browser runtime',
})
```

`form()` matches fields by their `name` attribute. If a controlled React input
has no name, take its ref from `struct()` and fill it directly:

```js
await (async () => {
  const page = await Brust.struct({ within: '#new-note' })
  if ('ok' in page && page.ok === false) return page
  const unnamed = page.forms[0]?.fields.find((field) => field.name === '')
  if (!unnamed) return { ok: false, error: { code: 'not-found', message: 'field not found' } }
  return Brust.action.fill(unnamed.ref, 'Release notes')
})()
```

### Navigate and settle

```js
const result = await Brust.navigate('/notes', { struct: true })
// same-shell: { ok: true, status: 'spa', url: '…', struct: { … } }

await Brust.back()
await Brust.reload()
```

`navigate()` waits for a successful SPA transition and newly mounted islands
before resolving. `{ struct: true }` includes a fresh snapshot in the same
round-trip. A cross-shell destination returns `status: 'full-load'` before the
document unloads; the browser harness observes the load and evaluates again in
the new page. External destinations report `status: 'external'`.

### Errors and redaction

Public methods resolve instead of throwing across the evaluator boundary. An
error has one envelope:

```js
{
  ok: false,
  error: {
    code: 'stale-ref',
    message: 'ref e7 is no longer valid',
    hint: 're-run Brust.struct()'
  }
}
```

`struct()` returns `null` instead of the value of password inputs and fields
marked `data-ai-redact`. A subtree marked `data-ai-ignore` is omitted entirely.

The browser loads the runtime from `/_brust/ai.js`; `pages()` fetches
`/_brust/ai/manifest.json` once and caches it. These routes exist only when the
runtime is enabled.

`Brust.wait`, `Brust.state`, `Brust.nav`, `Brust.api.list`, `Brust.api.call`,
and `Brust.errors` are declared for the next phase but currently resolve a
`disabled` error. The P1 surface is `pages`, `struct`, actions, and navigation.
