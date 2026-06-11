---
title: Agents
description: The built-in MCP server — defineActions endpoints as tools, route loaders as resources, schemas extracted from your types.
nav: { group: "Reference", order: 10 }
---

Every brust app is also an MCP server. The framework already knows what an
agent needs — your [actions](/docs/actions) are typed endpoints and your route
loaders return structured data — so it exposes both over the Model Context
Protocol (revision `2025-06-18`) at:

```
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
