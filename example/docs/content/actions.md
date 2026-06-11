---
title: Actions
description: defineActions endpoints, validation, typed errors, and the treaty client.
nav: { group: "Concepts", order: 5 }
---

Actions are the server endpoints of a brust app: a fluent `defineActions`
builder declares them, the Rust router dispatches them, and a typed proxy
client (the *treaty* client) calls them from the browser with end-to-end
types — input, output, and a discriminated error union all inferred from the
builder.

## Defining actions

```ts
// actions.ts
import { defineActions, ActionError } from 'brustjs'
import { z } from 'zod'

export const actions = defineActions()
  .get('/notes', async ({ query }) => listNotes(query), {
    query: z.object({ tag: z.string().optional() }),
  })
  .post('/notes', async ({ body }) => createNote(body), {
    body: z.object({ title: z.string().min(1) }),
  })
  .delete('/notes/{id}', async ({ params, respond }) => {
    const ok = await deleteNote(params.id)
    if (!ok) throw new ActionError(404, 'NOT_FOUND', { data: { id: params.id } })
    return respond(null, { status: 204 })
  })

export type Actions = typeof actions
```

Register the builder with the server: `brust.run({ routes, actions, entry: import.meta.url })`.

The builder has one method per HTTP verb — `get`, `post`, `put`, `patch`,
`delete`, `head` — each taking `(path, handler, opts?)`, plus `use(middleware)`
which applies to every endpoint registered **after** it. Paths must start with
`/`; `{id}` and `{*rest}` segments become typed `params`. Duplicate
`METHOD path` pairs throw at build time.

Per-endpoint options:

| Option | Type | Description |
|---|---|---|
| `body` | Standard Schema | Validates the decoded body; the handler's `body` is the schema's output type. Failure → HTTP 422 with `{ error: { message, issues } }`. |
| `query` | Standard Schema | Same for the query string. |
| `middleware` | `Middleware[]` | Appended after any `use()` middleware for this endpoint. |
| `description` | `string` | Build-time description, surfaced to the MCP tool manifest. |
| `errors` | `Record<code, Schema>` | **Type-only**: declares the domain errors the endpoint can throw, typing the treaty client's error union. The runtime ignores it. |

Any schema implementing the [Standard Schema](https://standardschema.dev)
interface works — Zod, Valibot, ArkType.

### The handler context

| Field | Description |
|---|---|
| `req` | The structured `BrustRequest` (`method`, `url`, `headers`, `cookies`, `search`, `signal`). |
| `body` | The validated body (JSON, urlencoded, and multipart are all decoded). |
| `params` | Path params, typed from `{x}` segments in the path literal. |
| `query` | The validated query object. |
| `headers` | Request headers, lower-cased. |
| `respond` | Escape hatch for status/headers (below). |

A handler's plain return value is JSON-encoded as a 200. To control the
status or headers, return `respond(body, { status?, headers? })`. To signal a
domain error, throw an `ActionError`:

```ts
throw new ActionError(409, 'ALREADY_EXISTS', {
  message: 'a note with this title exists', // optional; defaults to the code
  data: { title },                          // optional payload
})
```

It maps to a non-2xx response with the flat body
`{ code, message, data? }`. An unexpected throw becomes a 500 with
`{ error: { message, name } }`.

## The treaty client

`client` from `brustjs/client` builds a proxy whose property path mirrors the
endpoint path; the terminal method performs the fetch:

```ts
import { client } from 'brustjs/client'
import type { Actions } from '../actions'

const api = client<Actions>()

const { data, error } = await api.notes.get({ query: { tag: 'work' } })
//      ^ typed as the handler's return type        (static paths are fully typed)

await api.notes.post({ title: 'hello' })       // body is type-checked

// param segments are filled by a call with an object (positional, in order):
await api.notes({ id: '42' }).delete({})
```

Every call resolves (never throws) to a `TreatyResponse`:

| Field | Type | Description |
|---|---|---|
| `data` | `Output \| null` | The parsed body on 2xx, else `null`. |
| `error` | `{ status, value } \| null` | On non-2xx: `value` is the parsed body — for a thrown `ActionError`, the typed `{ code, message, data }` union from the endpoint's `errors` option. `status: 0` means the fetch itself failed. |
| `status` | `number` | HTTP status (0 on network failure). |
| `headers` | `Record<string, string>` | Response headers. |
| `response` | `Response \| null` | The raw fetch `Response`. |

So error handling is a narrow, not a try/catch:

```ts
const res = await api.notes({ id }).delete({})
if (res.error) {
  if (res.error.value.code === 'NOT_FOUND') { /* typed via opts.errors */ }
  return
}
res.data // typed, non-null here
```

GET and HEAD take only an options object (`{ query?, headers? }`); the other
verbs take `(body?, options?)`. A body containing a `Blob`/`File` (or a
`FormData` instance) is sent as multipart automatically; everything else is
JSON. Client options: `client({ prefix?, headers?, fetch? })` — `headers` may
be a function evaluated per request (handy for auth tokens).

Paths with `{param}` segments fall back to a permissive (untyped) proxy for
the parameterized part; static paths get full inference.

## The action prefix

Actions mount under `/_brust/action` by default — `POST /notes` is really
`POST /_brust/action/notes`. Override it with
`brust.run({ actionPrefix: '/api' })`. On React-rendered pages a non-default
prefix is injected into the HTML as a global the client picks up
automatically; native (template) pages don't bake it, so a treaty client used
on a native page with a **custom** prefix should pass it explicitly:
`client({ prefix: '/api' })`.

## Actions are MCP tools

Every endpoint doubles as a Model Context Protocol tool: brust mounts an MCP
server at `POST /_brust/mcp` and generates the tool manifest from the same
builder — schemas, params, and the `description` option included. Tool calls
dispatch through the same validation, middleware, and error contract as HTTP.
See the Reference section for the agent surface.

## Next

Stylesheets, Tailwind, and CSS Modules: [Styling](/docs/styling).
