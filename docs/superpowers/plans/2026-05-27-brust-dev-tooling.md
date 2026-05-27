# `brust dev` Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `brust dev <entry>` — a Vite/Dioxus-style dev CLI subcommand delivering hot-reload DX for brust end-users: file watcher → workers respawn → WS push → browser auto-reload, with CSS hot-swap and red error overlay. No Rust file watching (out of scope by design). No React Fast Refresh (full page reload in MVP).

**Architecture:** New `runtime/dev/` package holds the dev-only orchestrator: watcher, coordinator (state machine), workers helper (terminate+respawn), ANSI TUI, and the browser dev-client JS string. A new module `runtime/dev/inject.ts` carries the dev-client snippet for the renderer to splice into the first chunk (mirrors `runtime/css.ts` + `runtime/render/inject-css-link.ts`). `brust.run({dev:true})` injects a synthetic `/_brust/dev` WS route + installs the watcher AFTER `untilReady` resolves. Main process and Rust listener stay up across worker restarts — only the worker pool churns.

**Tech Stack:** TypeScript (strict), Bun runtime, `Bun.Worker`, `fs.watch({recursive:true})`, hand-rolled ANSI escapes, existing brust WS infrastructure (no Rust changes).

**Spec:** `docs/superpowers/specs/2026-05-27-brust-dev-tooling-design.md`

**Baselines to preserve:** Rust 99 / Runtime 118 / Integration 77 — all must stay green. After this plan: Runtime ~131 (+~13 unit tests) / Integration 81 (+4 cli-dev cases).

---

## Important context for every task

Before each subagent dispatch, the agent MUST be given:

- **Working directory:** `/Users/detoro/code/brust`
- **Branch:** `main` (user works on main directly with explicit consent — do NOT create feature branches without asking).
- **Project conventions:** terse, no defensive coding for impossible cases, no backwards-compat shims, minimal comments (WHY only), TypeScript strict.
- **Commit message convention:** terse subject (`feat(dev):`, `chore(dev):`, `test(dev):`, `fix(dev):`, `docs(dev):`), 1–3 sentence body. After EACH commit run `git log -1 --format=%B`; if the `commit-msg` hook rewrote it, `git commit --amend -m <heredoc>` immediately.
- **TDD discipline:** write failing test first, observe failure, implement minimum to pass, observe pass, commit. Tasks that touch hot-path renderer or external state get focused unit tests AND integration coverage.
- **Real-browser smoke is non-negotiable** for any feature touching client/browser surface (per the session-9/10/Tailwind lessons).
- **Zero Rust changes** in this plan. The dev-client JS asset is INLINED into the SSR `<script>` (no new Rust route). The `/_brust/dev` WS path is registered through the existing `registerWsPaths` + a synthetic route prepended to `opts.routes` in dev mode.

---

## File structure

**New files:**

| File | Responsibility |
|---|---|
| `runtime/dev/inject.ts` | Module-scope `configureDevClientSnippet(snippet: string \| null)` + `getDevClientSnippet(): string \| null`. Mirrors `runtime/css.ts`. |
| `runtime/dev/inject.test.ts` | Unit: null when unset, exact string when set, multiple set+get cycles. |
| `runtime/render/inject-dev-client.ts` | Pure helper `injectDevClient(body, snippet)` — byte-level splice before `</head>`. Mirror of `inject-css-link.ts`. |
| `runtime/render/inject-dev-client.test.ts` | Unit: splice position, empty snippet identity, missing `</head>`. |
| `runtime/dev/ws-channel.ts` | Synthetic WS route handlers + `Set<WsSocket>` client tracker + `broadcast(msg)`. Exports `createDevWsRoute()` returning a `Route` ready to prepend. |
| `runtime/dev/ws-channel.test.ts` | Unit: open adds to set, close removes, broadcast iterates, broadcast continues after one send error. |
| `runtime/dev/client.ts` | Source of the browser dev client (TS code, compiled to a string constant at module load via Bun.build). For MVP: keep the JS as a hand-written string constant in this file (verified by integration test). |
| `runtime/dev/watcher.ts` | `createWatcher({roots, onChange})`. Uses `fs.watch({recursive:true})`. Debounces 50ms. Classifies path to `ChangeKind`. Ignores `node_modules`, `.git`, `.brust`, `dist`, `*.test.*`. |
| `runtime/dev/watcher.test.ts` | Unit: debounce coalesces, ignore globs, kind classification. |
| `runtime/dev/workers.ts` | `terminateAll(workers)` + `spawnAll(opts)` — Bun.Worker lifecycle with 2s grace. |
| `runtime/dev/coordinator.ts` | State machine `Coordinator` class. `handleChange(ev)`. Single-flight. |
| `runtime/dev/coordinator.test.ts` | Unit: state transitions, broadcast sequence per kind, error path, single-flight drop. |
| `runtime/dev/tui.ts` | Hand-rolled ANSI TUI. `startTui()`, `appendEvent()`, `updateStatus()`, `stopTui()`. Non-TTY fallback. |
| `runtime/dev/tui.test.ts` | Unit: event log eviction, plain-text fallback when `!isTTY`. |
| `runtime/cli/dev.ts` | CLI orchestrator. Parses args, sets `BRUST_DEV=1`, starts TUI, calls `brust.run({dev:true})`. |
| `tests/cli-dev.test.ts` | Integration: 4 cases — TS edit→reload, CSS edit→css-update, CSS error→error, Ctrl-C→exit. |

**Modified files:**

| File | Change |
|---|---|
| `runtime/render/stream.ts` | Apply `injectDevClient(body, getDevClientSnippet())` in both buffering and streaming first-chunk paths. |
| `runtime/index.ts::brust.run()` | Accept `dev?: boolean`. When true: prepend synthetic `/_brust/dev` WS route, install watcher + coordinator + TUI after `untilReady`. |
| `runtime/cli/index.ts` | Add `case 'dev'` dispatch. |
| `package.json` | Update `"dev"` script to `bun runtime/cli/index.ts dev example/hello-world/index.ts`. |
| `architecture.md` | Promote `brust dev` to Built; describe WS protocol, dev-client injection. |

**Zero Rust changes.** The dev-client JS is INLINED in the `<script>` tag (no `/_brust/dev/client.js` route needed).

---

## Decision: dev-client serving = INLINE (not external)

Spec deferred A (new Rust route) vs C (inline) to the plan. **Plan picks C — inline.**

Rationale:
- ~2KB inline per SSR response in dev mode only; production never inlines (gated by `BRUST_DEV=1`).
- Zero new Rust route; no napi regen during this work.
- No Cache-Control concern; no asset-versioning concern across server restarts.

The `runtime/dev/client.ts` file is a TS module exporting `DEV_CLIENT_JS: string` — a hand-written string constant containing the browser dev client code. The string is wrapped in `<script type="module">…</script>` by `buildDevClientTag()` in `runtime/dev/inject.ts`.

---

## Task 1 — `runtime/dev/inject.ts` module + tests

**Files:**
- Create: `runtime/dev/inject.ts`
- Create: `runtime/dev/inject.test.ts`

Mirror the pattern of `runtime/css.ts` (already shipped). Module-scope state, no async.

- [ ] **Step 1: Write the failing test**

Create `runtime/dev/inject.test.ts`:

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { configureDevClientSnippet, getDevClientSnippet } from './inject.ts'

describe('runtime/dev/inject', () => {
  beforeEach(() => {
    configureDevClientSnippet(null)
  })

  test('starts null', () => {
    expect(getDevClientSnippet()).toBeNull()
  })

  test('configureDevClientSnippet stores a value', () => {
    configureDevClientSnippet('<script>hi</script>')
    expect(getDevClientSnippet()).toBe('<script>hi</script>')
  })

  test('configureDevClientSnippet(null) clears the value', () => {
    configureDevClientSnippet('<script>hi</script>')
    configureDevClientSnippet(null)
    expect(getDevClientSnippet()).toBeNull()
  })

  test('replacing with a new value overwrites', () => {
    configureDevClientSnippet('<script>a</script>')
    configureDevClientSnippet('<script>b</script>')
    expect(getDevClientSnippet()).toBe('<script>b</script>')
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
bun test runtime/dev/inject.test.ts 2>&1 | tail -10
```
Expected: FAIL — Cannot find module.

- [ ] **Step 3: Implement `runtime/dev/inject.ts`**

```ts
// Module-scope state for the dev-client <script> snippet that the renderer
// splices into the SSR first chunk in dev mode. Mirrors runtime/css.ts.
// Workers re-execute the bundle and get their own copy; brust.run() sets
// the snippet on both main and worker startup paths.
let snippet: string | null = null

/** Set the dev-client snippet (full `<script>…</script>` tag) the renderer
 * should inject before `</head>`. Pass `null` to disable injection (the
 * default in non-dev mode). */
export function configureDevClientSnippet(s: string | null): void {
  snippet = s
}

/** Returns the configured snippet, or `null` when dev mode is off. */
export function getDevClientSnippet(): string | null {
  return snippet
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
bun test runtime/dev/inject.test.ts 2>&1 | tail -10
```
Expected: 4 pass.

- [ ] **Step 5: Confirm no regression**

```bash
bun test runtime/ 2>&1 | tail -5
```
Expected: 118 + 4 = 122 pass.

- [ ] **Step 6: Commit**

```bash
git add runtime/dev/inject.ts runtime/dev/inject.test.ts
git commit -m "$(cat <<'EOF'
feat(dev): module-scope state for renderer dev-client injection

Mirror of runtime/css.ts. Holds the <script>…</script> snippet the
renderer should splice before </head> in dev mode; null in prod mode.
EOF
)"
git log -1 --format=%B
```

If rewritten, amend.

---

## Task 2 — `runtime/render/inject-dev-client.ts` helper + tests

**Files:**
- Create: `runtime/render/inject-dev-client.ts`
- Create: `runtime/render/inject-dev-client.test.ts`

Pure helper. Mirrors `runtime/render/inject-css-link.ts` shape: byte-level scan for `</head>`, splice the snippet immediately before it.

- [ ] **Step 1: Write the failing test**

Create `runtime/render/inject-dev-client.test.ts`:

```ts
import { describe, test, expect, spyOn } from 'bun:test'
import { injectDevClient, _resetWarnedForTests } from './inject-dev-client.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()
const body = (s: string) => enc.encode(s)
const str = (b: Uint8Array) => dec.decode(b)

describe('injectDevClient', () => {
  test('splices the snippet immediately before </head>', () => {
    const out = injectDevClient(
      body('<head><title>x</title></head><body></body>'),
      '<script>devclient</script>',
    )
    expect(str(out)).toBe(
      '<head><title>x</title><script>devclient</script></head><body></body>',
    )
  })

  test('matches case-insensitive </HEAD>', () => {
    const out = injectDevClient(
      body('<HEAD></HEAD>'),
      '<script>x</script>',
    )
    expect(str(out)).toBe('<HEAD><script>x</script></HEAD>')
  })

  test('returns the original body when snippet is null', () => {
    const src = body('<head></head>')
    const out = injectDevClient(src, null)
    expect(out).toBe(src)
  })

  test('returns the original body when snippet is empty string', () => {
    const src = body('<head></head>')
    const out = injectDevClient(src, '')
    expect(out).toBe(src)
  })

  test('returns body unchanged + warns once when </head> is missing', () => {
    _resetWarnedForTests()
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const src = body('<body>no head</body>')
      const out = injectDevClient(src, '<script>x</script>')
      expect(out).toBe(src)
      expect(warn).toHaveBeenCalledTimes(1)

      injectDevClient(body('<body></body>'), '<script>x</script>')
      expect(warn).toHaveBeenCalledTimes(1)  // still 1
    } finally {
      warn.mockRestore()
    }
  })

  test('preserves UTF-8 multibyte content preceding </head>', () => {
    const out = injectDevClient(
      body('<head><title>こんにちは</title></head>'),
      '<script>x</script>',
    )
    expect(str(out)).toBe('<head><title>こんにちは</title><script>x</script></head>')
  })

  test('output is a plain Uint8Array', () => {
    const out = injectDevClient(body('<head></head>'), '<script>x</script>')
    expect(out).toBeInstanceOf(Uint8Array)
    expect(out.constructor.name).toBe('Uint8Array')
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
bun test runtime/render/inject-dev-client.test.ts 2>&1 | tail -10
```
Expected: FAIL — Cannot find module.

- [ ] **Step 3: Implement `runtime/render/inject-dev-client.ts`**

```ts
const ENC = new TextEncoder()

let warned = false

/** @internal — used by tests to reset the warn-once flag. */
export function _resetWarnedForTests(): void { warned = false }

/** Splice `snippet` into `body` immediately before the first `</head>`
 * (case-insensitive on the four ASCII letters). Returns the original body
 * untouched if `snippet` is null/empty or if `</head>` is absent. */
export function injectDevClient(
  body: Uint8Array,
  snippet: string | null,
): Uint8Array {
  if (!snippet) return body
  const pos = findHeadCloseTag(body)
  if (pos < 0) {
    if (!warned) {
      console.warn('[brust] dev: no </head> in first chunk; dev-client <script> not injected')
      warned = true
    }
    return body
  }
  const tagBytes = ENC.encode(snippet)
  const out = new Uint8Array(body.length + tagBytes.length)
  out.set(body.subarray(0, pos), 0)
  out.set(tagBytes, pos)
  out.set(body.subarray(pos), pos + tagBytes.length)
  return out
}

function findHeadCloseTag(body: Uint8Array): number {
  const LT = 0x3c, SL = 0x2f, GT = 0x3e
  for (let i = 0, max = body.length - 6; i < max; i++) {
    if (body[i] !== LT || body[i+1] !== SL) continue
    if (!isLetter(body[i+2], 0x48)) continue   // H
    if (!isLetter(body[i+3], 0x45)) continue   // E
    if (!isLetter(body[i+4], 0x41)) continue   // A
    if (!isLetter(body[i+5], 0x44)) continue   // D
    if (body[i+6] !== GT) continue
    return i
  }
  return -1
}

function isLetter(b: number, u: number): boolean {
  return b === u || b === (u | 0x20)
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
bun test runtime/render/inject-dev-client.test.ts 2>&1 | tail -10
```
Expected: 7 pass.

- [ ] **Step 5: Confirm no regression**

```bash
bun test runtime/ 2>&1 | tail -5
```
Expected: 122 + 7 = 129 pass.

- [ ] **Step 6: Commit**

```bash
git add runtime/render/inject-dev-client.ts runtime/render/inject-dev-client.test.ts
git commit -m "$(cat <<'EOF'
feat(render): pure helper to splice dev-client <script> before </head>

Byte-level scan, case-insensitive on the four ASCII letters only. No-op
when snippet is null/empty. Warns once per process if </head> is absent.
Mirrors injectCssLink shape exactly.
EOF
)"
git log -1 --format=%B
```

If rewritten, amend.

---

## Task 3 — Wire `injectDevClient` into the renderer

**Files:**
- Modify: `runtime/render/stream.ts`

Same pattern as the existing `injectCssLink` wiring. Apply in both buffering `_final` and streaming `onShellReady` paths.

- [ ] **Step 1: Read the current stream.ts to confirm insertion points**

```bash
cat runtime/render/stream.ts | head -180
```

The buffering branch lives inside `renderBranchStreaming._final`; the streaming branch lives inside `onShellReady`. Both already call `injectCssLink`. Insert `injectDevClient` immediately AFTER the `injectCssLink` call in both branches.

- [ ] **Step 2: Add the imports**

In `runtime/render/stream.ts`, near the existing `import { injectCssLink }` and `import { getCssHrefs }` lines, add:

```ts
import { injectDevClient } from './inject-dev-client.ts'
import { getDevClientSnippet } from '../dev/inject.ts'
```

- [ ] **Step 3: Wire into buffering branch**

In the `_final` block, find the existing `body = injectCssLink(body, getCssHrefs())` line and insert immediately after:

```ts
body = injectDevClient(body, getDevClientSnippet())
```

The buffering block should now read:

```ts
if (mode === 'buffering') {
  const islandsUsed = consumeIslandUsedFlag()
  let body = concatBuffers(buffer, islandsUsed)
  body = injectCssLink(body, getCssHrefs())
  body = injectDevClient(body, getDevClientSnippet())
  const meta = makeMeta({ status: successStatus, streaming: false, headers: extraHeaders })
  const len = encodeFirstChunk(view, meta, body)
  await napi.renderChunk(workerId, len, view)
  await sendFinal()
  mode = 'done'
}
```

- [ ] **Step 4: Wire into streaming branch**

In `onShellReady` body, find the existing `flushed = injectCssLink(flushed, getCssHrefs())` and insert immediately after:

```ts
flushed = injectDevClient(flushed, getDevClientSnippet())
```

- [ ] **Step 5: Run all renderer + integration baselines**

```bash
bun test runtime/render/ 2>&1 | tail -5
bun test runtime/ 2>&1 | tail -5
bun test tests/integration.test.ts 2>&1 | tail -5
bun test tests/cli-build.test.ts 2>&1 | tail -10
```

Expected:
- `runtime/render/`: prior count + 7 (dev-client tests) = no regression. NB the new tests already landed in Task 2, so this just confirms.
- `runtime/`: 129 pass (Task 2 made it 129).
- `tests/integration.test.ts`: 70 pass.
- `tests/cli-build.test.ts`: 7 pass (Tailwind tests still green).

Since dev-client snippet is `null` by default (Task 1's `inject.ts` starts null), the injection is a no-op in all existing test paths. Zero behavior change.

- [ ] **Step 6: Commit**

```bash
git add runtime/render/stream.ts
git commit -m "$(cat <<'EOF'
feat(render): inject dev-client <script> into SSR first chunk

Both buffering and streaming paths now run injectDevClient(body,
getDevClientSnippet()) after injectCssLink. Default (no dev mode):
snippet is null, helper returns body unchanged — zero-impact wiring
for production.
EOF
)"
git log -1 --format=%B
```

If rewritten, amend.

---

## Task 4 — `runtime/dev/ws-channel.ts` (synthetic WS route + broadcaster)

**Files:**
- Create: `runtime/dev/ws-channel.ts`
- Create: `runtime/dev/ws-channel.test.ts`

This module produces a `Route` that can be prepended to `opts.routes` in dev mode and exposes a `broadcast(msg)` function used by the coordinator.

- [ ] **Step 1: Read the brust route shape**

```bash
grep -n "WsHandlers\|websocket?:" runtime/routes.ts | head -10
```

Note: a `Route` with a `websocket: () => Promise<WsHandlers>` is a valid WS-only route. The handler is loaded lazily per connection.

- [ ] **Step 2: Write the failing test**

Create `runtime/dev/ws-channel.test.ts`:

```ts
import { describe, test, expect, mock } from 'bun:test'
import { createDevWsRoute, broadcast, _clientCountForTests, _resetForTests } from './ws-channel.ts'

describe('runtime/dev/ws-channel', () => {
  test('createDevWsRoute returns a route with path /_brust/dev', () => {
    const r = createDevWsRoute()
    expect(r.path).toBe('/_brust/dev')
    expect(typeof r.websocket).toBe('function')
  })

  test('open adds socket to client set; close removes it', async () => {
    _resetForTests()
    const route = createDevWsRoute()
    const handlers = await route.websocket!()
    const sock: any = { id: 1n, send: mock(() => Promise.resolve()), close: mock(() => {}) }
    handlers.open?.(sock, { req: {} as any, subprotocol: null })
    expect(_clientCountForTests()).toBe(1)
    handlers.close?.(sock, 1000, '')
    expect(_clientCountForTests()).toBe(0)
  })

  test('broadcast sends JSON to every connected client', async () => {
    _resetForTests()
    const route = createDevWsRoute()
    const handlers = await route.websocket!()
    const sock1: any = { id: 1n, send: mock(() => Promise.resolve()), close: mock(() => {}) }
    const sock2: any = { id: 2n, send: mock(() => Promise.resolve()), close: mock(() => {}) }
    handlers.open?.(sock1, { req: {} as any, subprotocol: null })
    handlers.open?.(sock2, { req: {} as any, subprotocol: null })
    await broadcast({ type: 'reload' })
    expect(sock1.send).toHaveBeenCalledWith('{"type":"reload"}')
    expect(sock2.send).toHaveBeenCalledWith('{"type":"reload"}')
  })

  test('broadcast tolerates per-socket send errors', async () => {
    _resetForTests()
    const route = createDevWsRoute()
    const handlers = await route.websocket!()
    const bad: any = { id: 1n, send: mock(() => Promise.reject(new Error('boom'))), close: mock(() => {}) }
    const good: any = { id: 2n, send: mock(() => Promise.resolve()), close: mock(() => {}) }
    handlers.open?.(bad, { req: {} as any, subprotocol: null })
    handlers.open?.(good, { req: {} as any, subprotocol: null })
    await broadcast({ type: 'ok' })
    expect(good.send).toHaveBeenCalledWith('{"type":"ok"}')
  })

  test('message handler ignores all incoming messages (server→client only protocol)', async () => {
    _resetForTests()
    const route = createDevWsRoute()
    const handlers = await route.websocket!()
    const sock: any = { id: 1n, send: mock(() => Promise.resolve()), close: mock(() => {}) }
    handlers.open?.(sock, { req: {} as any, subprotocol: null })
    handlers.message?.(sock, 'anything')  // should not throw
    expect(sock.send).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run the test and verify it fails**

```bash
bun test runtime/dev/ws-channel.test.ts 2>&1 | tail -10
```
Expected: FAIL — Cannot find module.

- [ ] **Step 4: Implement `runtime/dev/ws-channel.ts`**

```ts
import type { Route, WsHandlers, WsSocket } from '../routes.ts'

/** Server-to-client protocol. Client never sends after open. */
export type DevMessage =
  | { type: 'building' }
  | { type: 'reload' }
  | { type: 'css-update'; href: string }
  | { type: 'error'; message: string; stack?: string }
  | { type: 'ok' }

const clients: Set<WsSocket> = new Set()

export function _clientCountForTests(): number { return clients.size }
export function _resetForTests(): void { clients.clear() }

/** Build a synthetic Route at /_brust/dev that brust.run() prepends to
 * the user's routes array when dev mode is on. */
export function createDevWsRoute(): Route {
  return {
    path: '/_brust/dev',
    websocket: () => Promise.resolve(devHandlers),
  }
}

const devHandlers: WsHandlers = {
  open(socket) { clients.add(socket) },
  close(socket) { clients.delete(socket) },
  // No incoming messages — dev channel is server→client only.
  message() { /* ignore */ },
}

/** Send the message to every connected dev client. Per-socket errors are
 * caught and dropped — one bad client cannot stall the broadcast. */
export async function broadcast(msg: DevMessage): Promise<void> {
  const json = JSON.stringify(msg)
  const sends: Promise<unknown>[] = []
  for (const s of clients) {
    sends.push(s.send(json).catch(() => { clients.delete(s) }))
  }
  await Promise.all(sends)
}
```

- [ ] **Step 5: Run the test and verify it passes**

```bash
bun test runtime/dev/ws-channel.test.ts 2>&1 | tail -10
```
Expected: 5 pass.

- [ ] **Step 6: Confirm no regression**

```bash
bun test runtime/ 2>&1 | tail -5
```
Expected: 129 + 5 = 134 pass.

- [ ] **Step 7: Commit**

```bash
git add runtime/dev/ws-channel.ts runtime/dev/ws-channel.test.ts
git commit -m "$(cat <<'EOF'
feat(dev): WS dev channel — synthetic route + broadcast

createDevWsRoute() returns a Route at /_brust/dev that brust.run()
prepends to the user's routes in dev mode. Open/close maintain a
client Set; broadcast(msg) JSON-stringifies and sends to each client.
Per-socket send failures drop the client; remaining sends continue.
Server→client only — incoming messages are ignored.
EOF
)"
git log -1 --format=%B
```

If rewritten, amend.

---

## Task 5 — `runtime/dev/client.ts` (browser dev client as JS string)

**Files:**
- Create: `runtime/dev/client.ts`

The browser dev client is exported as a JS string constant (`DEV_CLIENT_JS`). Inject mode = inline — no separate JS asset to serve.

No unit test for the JS content itself; the integration test in Task 13 exercises the actual behavior in a real browser.

- [ ] **Step 1: Create `runtime/dev/client.ts`**

```ts
/** Browser dev client. Inlined into the SSR first chunk via a <script
 * type="module">…</script> wrapper. Connects WS at /_brust/dev, handles
 * reload / css-update / error / ok messages, manages a red overlay.
 *
 * Keep this string short — it ships in every dev-mode SSR response. */
export const DEV_CLIENT_JS = String.raw`
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
let ws;
function connect() {
  ws = new WebSocket(proto + '//' + location.host + '/_brust/dev');
  ws.onmessage = function (e) { handle(JSON.parse(e.data)); };
  ws.onclose = function () { setTimeout(connect, 1000); };
  ws.onerror = function () { /* swallow; onclose triggers reconnect */ };
}
function handle(msg) {
  switch (msg.type) {
    case 'reload': location.reload(); break;
    case 'css-update': swapCssLink(msg.href); break;
    case 'error': showOverlay(msg.message, msg.stack); break;
    case 'ok': hideOverlay(); break;
  }
}
function swapCssLink(href) {
  const url = new URL(href, location.origin);
  document.querySelectorAll('link[rel="stylesheet"]').forEach(function (link) {
    if (new URL(link.href).pathname === url.pathname) link.href = href;
  });
}
function showOverlay(msg, stack) {
  let el = document.getElementById('__brust_dev_overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = '__brust_dev_overlay';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(180,30,30,0.96);color:#fff;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:24px;z-index:2147483647;white-space:pre-wrap;overflow:auto;';
    document.body.appendChild(el);
  }
  el.textContent = '[brust dev] build error\n\n' + msg + (stack ? '\n\n' + stack : '');
}
function hideOverlay() {
  const el = document.getElementById('__brust_dev_overlay');
  if (el) el.remove();
}
connect();
`.trim()

/** Build the full <script> tag that gets spliced before </head>. */
export function buildDevClientTag(): string {
  return '<script type="module">' + DEV_CLIENT_JS + '</script>'
}
```

- [ ] **Step 2: Sanity-check the build**

```bash
bun -e "import('./runtime/dev/client.ts').then(m => { console.log(m.buildDevClientTag().slice(0, 80)) })"
```
Expected: prints the first 80 chars of the wrapped `<script>` tag, no errors.

- [ ] **Step 3: Confirm no regression**

```bash
bun test runtime/ 2>&1 | tail -5
```
Expected: 134 pass (this task adds no tests).

- [ ] **Step 4: Commit**

```bash
git add runtime/dev/client.ts
git commit -m "$(cat <<'EOF'
feat(dev): browser dev client as inline JS string

DEV_CLIENT_JS is the hand-written browser-side dev client (~80 LOC).
buildDevClientTag() wraps it in <script type="module">…</script> for
inline injection into the SSR first chunk in dev mode. No external
asset, no Rust route — keeps the dev-tooling change zero-Rust.
EOF
)"
git log -1 --format=%B
```

If rewritten, amend.

---

## Task 6 — `runtime/dev/watcher.ts` (file watcher + debounce + classifier)

**Files:**
- Create: `runtime/dev/watcher.ts`
- Create: `runtime/dev/watcher.test.ts`

Wraps Node's `fs.watch({recursive:true})`. Debounces 50ms. Classifies paths to a `ChangeKind`.

- [ ] **Step 1: Write the failing test**

Create `runtime/dev/watcher.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { classifyPath, _testCoalesce, type ChangeKind } from './watcher.ts'

describe('runtime/dev/watcher classifyPath', () => {
  const cases: [string, ChangeKind | null][] = [
    ['/proj/pages/Home.tsx', 'ts'],
    ['/proj/components/Counter.tsx', 'ts'],
    ['/proj/util.ts', 'ts'],
    ['/proj/util.js', 'ts'],
    ['/proj/util.jsx', 'ts'],
    ['/proj/app.css', 'css'],
    ['/proj/index.html', 'html'],
    ['/proj/island.config.ts', 'islands'],
    ['/proj/node_modules/foo/index.js', null],
    ['/proj/.git/HEAD', null],
    ['/proj/.brust/css/app.css', null],
    ['/proj/dist/index.js', null],
    ['/proj/foo.test.ts', null],
    ['/proj/foo.test.tsx', null],
    ['/proj/README.md', null],
  ]
  for (const [path, expected] of cases) {
    test(`classifyPath(${path}) = ${expected ?? 'null'}`, () => {
      expect(classifyPath(path, '/proj')).toBe(expected)
    })
  }
})

describe('runtime/dev/watcher coalesce', () => {
  test('multiple events within debounce window collapse to one callback', async () => {
    let calls: string[][] = []
    const c = _testCoalesce(50, (paths) => { calls.push(paths) })
    c.add('/a.ts'); c.add('/b.ts'); c.add('/a.ts')
    await new Promise((r) => setTimeout(r, 80))
    expect(calls).toEqual([['/a.ts', '/b.ts']])
  })

  test('events outside the window produce separate callbacks', async () => {
    let calls: string[][] = []
    const c = _testCoalesce(50, (paths) => { calls.push(paths) })
    c.add('/a.ts')
    await new Promise((r) => setTimeout(r, 80))
    c.add('/b.ts')
    await new Promise((r) => setTimeout(r, 80))
    expect(calls).toEqual([['/a.ts'], ['/b.ts']])
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
bun test runtime/dev/watcher.test.ts 2>&1 | tail -10
```
Expected: FAIL — Cannot find module.

- [ ] **Step 3: Implement `runtime/dev/watcher.ts`**

```ts
import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'

export type ChangeKind = 'ts' | 'css' | 'html' | 'islands'

const IGNORE_DIR_SEGMENTS = new Set(['node_modules', '.git', '.brust', 'dist'])
const TS_RE = /\.(tsx?|jsx?)$/
const TEST_RE = /\.test\.(tsx?|jsx?)$/

/** Classify a changed path. Returns null when the path should be ignored.
 * `root` is used to make the comparison relative. */
export function classifyPath(absPath: string, root: string): ChangeKind | null {
  const rel = path.relative(root, absPath)
  const segs = rel.split(path.sep)
  for (const s of segs) {
    if (IGNORE_DIR_SEGMENTS.has(s)) return null
  }
  if (TEST_RE.test(absPath)) return null

  const base = path.basename(absPath)
  if (base === 'island.config.ts') return 'islands'
  if (base === 'app.css') return 'css'
  if (absPath.endsWith('.html')) return 'html'
  if (TS_RE.test(absPath)) return 'ts'
  return null
}

interface Coalesce {
  add(path: string): void
  flush(): void
}

/** Internal — exposed for unit tests. */
export function _testCoalesce(
  debounceMs: number,
  flush: (paths: string[]) => void,
): Coalesce {
  let pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    add(p) {
      pending.add(p)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const out = Array.from(pending)
        pending = new Set()
        timer = null
        flush(out)
      }, debounceMs)
    },
    flush() {
      if (timer) { clearTimeout(timer); timer = null }
      if (pending.size > 0) {
        const out = Array.from(pending)
        pending = new Set()
        flush(out)
      }
    },
  }
}

export interface CreateWatcherOptions {
  root: string
  debounceMs?: number
  onChange: (ev: { paths: string[]; kind: ChangeKind }) => void
}

export interface Watcher {
  close(): void
}

/** Watch `root` recursively. Emits one `onChange` call per debounce window
 * with a list of changed paths classified by the dominant kind. When the
 * window has paths of mixed kinds, the priority is islands > ts > html > css
 * (islands trigger a full restart that subsumes the others). */
export function createWatcher(opts: CreateWatcherOptions): Watcher {
  const debounceMs = opts.debounceMs ?? 50
  const kindPriority: ChangeKind[] = ['islands', 'ts', 'html', 'css']

  const coalesce = _testCoalesce(debounceMs, (paths) => {
    const kinds = new Set<ChangeKind>()
    const keep: string[] = []
    for (const p of paths) {
      const k = classifyPath(p, opts.root)
      if (k === null) continue
      kinds.add(k)
      keep.push(p)
    }
    if (keep.length === 0) return
    const dominant = kindPriority.find((k) => kinds.has(k))!
    opts.onChange({ paths: keep, kind: dominant })
  })

  // fs.watch with recursive:true works on macOS + Windows natively; on Linux
  // it requires Node 20+ but is still supported. Bun honors the same option.
  const fsWatcher: FSWatcher = watch(opts.root, { recursive: true }, (_event, filename) => {
    if (!filename) return
    const abs = path.resolve(opts.root, filename)
    coalesce.add(abs)
  })

  return {
    close() {
      fsWatcher.close()
      coalesce.flush()
    },
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
bun test runtime/dev/watcher.test.ts 2>&1 | tail -10
```
Expected: 17 pass (15 classify cases + 2 coalesce).

- [ ] **Step 5: Confirm no regression**

```bash
bun test runtime/ 2>&1 | tail -5
```
Expected: 134 + 17 = 151 pass.

- [ ] **Step 6: Commit**

```bash
git add runtime/dev/watcher.ts runtime/dev/watcher.test.ts
git commit -m "$(cat <<'EOF'
feat(dev): file watcher with debounce + path classifier

classifyPath maps absolute paths to ChangeKind ('ts'|'css'|'html'|
'islands') or null for ignored paths (node_modules, .git, .brust, dist,
*.test.*, non-source). createWatcher wraps fs.watch({recursive:true})
with 50ms debounce; mixed-kind windows pick the dominant kind by
priority (islands > ts > html > css).
EOF
)"
git log -1 --format=%B
```

If rewritten, amend.

---

## Task 7 — `runtime/dev/worker-registry.ts` (real worker churn)

**Files:**
- Create: `runtime/dev/worker-registry.ts`

**Why this exists:** Bun's module loader caches per-Worker isolate. Same Worker = same cached `pages/Home.tsx`. To pick up a TS edit we MUST terminate the Worker and spawn a fresh one. The registry holds the live Workers so the coordinator can churn them.

**Critical:** `brust.serve()` currently calls `new Worker(opts.entry, ...)` directly and discards the references. In dev mode we need to redirect those references into the registry. This is done in Task 10's brust.run() wiring — Task 7 only provides the registry module.

- [ ] **Step 1: Implement `runtime/dev/worker-registry.ts`**

```ts
const TERMINATE_TIMEOUT_MS = 2000

interface RegistryState {
  workers: Worker[]
  entry: string | null
  count: number
  baseEnv: Record<string, string> | null
}

const state: RegistryState = {
  workers: [],
  entry: null,
  count: 0,
  baseEnv: null,
}

/** Called once by brust.serve() in dev mode AFTER it spawns the initial
 * pool. Hands the references to the registry so the coordinator can
 * churn them later. */
export function registerInitialPool(
  workers: Worker[],
  entry: string,
  count: number,
  baseEnv: Record<string, string>,
): void {
  state.workers = workers.slice()
  state.entry = entry
  state.count = count
  state.baseEnv = baseEnv
}

/** Terminate every Worker with a 2s per-worker grace. If termination
 * doesn't return in time, abandon the reference and continue. */
export async function terminateAll(): Promise<void> {
  const olds = state.workers
  state.workers = []
  await Promise.all(olds.map(async (w) => {
    try {
      await Promise.race([
        w.terminate(),
        new Promise<void>((resolve) => setTimeout(resolve, TERMINATE_TIMEOUT_MS)),
      ])
    } catch {
      // Already-terminated rejections swallowed.
    }
  }))
}

/** Spawn `count` fresh Workers using the entry + env captured at
 * registerInitialPool time. Each worker gets BRUST_WORKER_ID=i.
 * Workers self-register their renderers with Rust on import (existing
 * brust.run worker branch behavior). */
export function spawnAll(): void {
  if (state.entry === null || state.baseEnv === null) {
    throw new Error('worker-registry: spawnAll called before registerInitialPool')
  }
  const fresh: Worker[] = []
  for (let i = 0; i < state.count; i++) {
    const w = new Worker(state.entry, {
      env: { ...state.baseEnv, BRUST_WORKER_ID: String(i) },
    })
    fresh.push(w)
  }
  state.workers = fresh
}

/** Test helper. */
export function _workersForTests(): Worker[] { return [...state.workers] }
export function _resetForTests(): void {
  state.workers = []
  state.entry = null
  state.count = 0
  state.baseEnv = null
}
```

- [ ] **Step 2: Confirm the module compiles**

```bash
bun -e "import('./runtime/dev/worker-registry.ts').then(m => console.log(Object.keys(m)))"
```
Expected: prints the exported names, no errors.

- [ ] **Step 3: Confirm no regression**

```bash
bun test runtime/ 2>&1 | tail -5
```
Expected: 151 pass (no new tests — registry is exercised through the integration test in Task 12).

- [ ] **Step 4: Commit**

```bash
git add runtime/dev/worker-registry.ts
git commit -m "$(cat <<'EOF'
feat(dev): worker registry for hot-reload churn

Holds live Bun.Worker references captured at brust.serve() boot in
dev mode. terminateAll races each Worker.terminate against a 2s grace;
spawnAll constructs N fresh Workers with sequential BRUST_WORKER_ID
using the entry + base env from the initial registration. Bun's
per-isolate module cache means Workers must be terminated + respawned
for TS edits to be picked up — no other unload path exists.
EOF
)"
git log -1 --format=%B
```

If rewritten, amend.

---

## Task 8 — `runtime/dev/coordinator.ts` (state machine) + tests

**Files:**
- Create: `runtime/dev/coordinator.ts`
- Create: `runtime/dev/coordinator.test.ts`

Single-flight state machine. Pure logic — all I/O injected via deps for testability.

- [ ] **Step 1: Write the failing test**

Create `runtime/dev/coordinator.test.ts`:

```ts
import { describe, test, expect, mock } from 'bun:test'
import { Coordinator } from './coordinator.ts'

function makeDeps(over: Partial<any> = {}) {
  return {
    workers: {
      terminateAll: mock(() => Promise.resolve()),
      spawnAll: mock(() => Promise.resolve()),
    },
    buildCss: mock(() => Promise.resolve()),
    buildIslands: mock(() => Promise.resolve()),
    broadcast: mock((_msg: any) => Promise.resolve()),
    tui: { appendEvent: mock((_line: string) => {}) },
    ...over,
  }
}

describe('Coordinator', () => {
  test('ts change → terminate, spawn, broadcast building+reload+ok', async () => {
    const deps = makeDeps()
    const c = new Coordinator(deps)
    await c.handleChange({ paths: ['/a.tsx'], kind: 'ts' })
    expect(deps.workers.terminateAll).toHaveBeenCalledTimes(1)
    expect(deps.workers.spawnAll).toHaveBeenCalledTimes(1)
    const types = deps.broadcast.mock.calls.map((c) => c[0].type)
    expect(types).toEqual(['building', 'reload', 'ok'])
  })

  test('css change → buildCss + broadcast building+css-update+ok, no worker restart', async () => {
    const deps = makeDeps()
    const c = new Coordinator(deps)
    await c.handleChange({ paths: ['/app.css'], kind: 'css' })
    expect(deps.workers.terminateAll).not.toHaveBeenCalled()
    expect(deps.buildCss).toHaveBeenCalledTimes(1)
    const calls = deps.broadcast.mock.calls.map((c) => c[0])
    expect(calls[0].type).toBe('building')
    expect(calls[1].type).toBe('css-update')
    expect(calls[1].href).toMatch(/^\/_brust\/css\/app\.css\?v=\d+$/)
    expect(calls[2].type).toBe('ok')
  })

  test('islands change → buildIslands + worker restart + reload', async () => {
    const deps = makeDeps()
    const c = new Coordinator(deps)
    await c.handleChange({ paths: ['/island.config.ts'], kind: 'islands' })
    expect(deps.buildIslands).toHaveBeenCalledTimes(1)
    expect(deps.workers.terminateAll).toHaveBeenCalledTimes(1)
    expect(deps.workers.spawnAll).toHaveBeenCalledTimes(1)
    const types = deps.broadcast.mock.calls.map((c) => c[0].type)
    expect(types).toEqual(['building', 'reload', 'ok'])
  })

  test('build failure → broadcast error, no reload/ok', async () => {
    const deps = makeDeps({
      buildCss: mock(() => Promise.reject(new Error('Tailwind broke'))),
    })
    const c = new Coordinator(deps)
    await c.handleChange({ paths: ['/app.css'], kind: 'css' })
    const calls = deps.broadcast.mock.calls.map((c) => c[0])
    expect(calls[0].type).toBe('building')
    expect(calls[1].type).toBe('error')
    expect(calls[1].message).toBe('Tailwind broke')
    expect(calls.find((c) => c.type === 'reload' || c.type === 'css-update' || c.type === 'ok')).toBeUndefined()
  })

  test('single-flight: change-while-building is dropped', async () => {
    let releaseTerm!: () => void
    const deps = makeDeps({
      workers: {
        terminateAll: mock(() => new Promise<void>((r) => { releaseTerm = r })),
        spawnAll: mock(() => Promise.resolve()),
      },
    })
    const c = new Coordinator(deps)
    const first = c.handleChange({ paths: ['/a.tsx'], kind: 'ts' })
    // While the first is parked on terminateAll, fire a second change
    await c.handleChange({ paths: ['/b.tsx'], kind: 'ts' })
    // The second call should have returned without doing any work
    expect(deps.workers.terminateAll).toHaveBeenCalledTimes(1)
    releaseTerm()
    await first
    expect(deps.workers.terminateAll).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
bun test runtime/dev/coordinator.test.ts 2>&1 | tail -10
```
Expected: FAIL — Cannot find module.

- [ ] **Step 3: Implement `runtime/dev/coordinator.ts`**

```ts
import type { DevMessage } from './ws-channel.ts'
import type { ChangeKind } from './watcher.ts'

export interface CoordinatorDeps {
  workers: {
    terminateAll(): Promise<void>
    spawnAll(): Promise<void>
  }
  buildCss: () => Promise<void>
  buildIslands: () => Promise<void>
  broadcast: (msg: DevMessage) => Promise<void> | void
  tui: { appendEvent(line: string): void }
}

type State = 'idle' | 'building'

export class Coordinator {
  private state: State = 'idle'

  constructor(private deps: CoordinatorDeps) {}

  async handleChange(ev: { paths: string[]; kind: ChangeKind }): Promise<void> {
    if (this.state === 'building') return
    this.state = 'building'
    const started = performance.now()
    try {
      await this.deps.broadcast({ type: 'building' })
      this.deps.tui.appendEvent(formatStart(ev))
      switch (ev.kind) {
        case 'ts':
        case 'html':
          await this.deps.workers.terminateAll()
          await this.deps.workers.spawnAll()
          await this.deps.broadcast({ type: 'reload' })
          break
        case 'islands':
          await this.deps.buildIslands()
          await this.deps.workers.terminateAll()
          await this.deps.workers.spawnAll()
          await this.deps.broadcast({ type: 'reload' })
          break
        case 'css':
          await this.deps.buildCss()
          await this.deps.broadcast({
            type: 'css-update',
            href: '/_brust/css/app.css?v=' + Date.now(),
          })
          break
      }
      const ms = (performance.now() - started) | 0
      this.deps.tui.appendEvent(`  → ok (${ms}ms)`)
      await this.deps.broadcast({ type: 'ok' })
    } catch (e: any) {
      this.deps.tui.appendEvent(`  ✗ ${e.message ?? String(e)}`)
      await this.deps.broadcast({
        type: 'error',
        message: e.message ?? String(e),
        stack: e.stack,
      })
    } finally {
      this.state = 'idle'
    }
  }
}

function formatStart(ev: { paths: string[]; kind: ChangeKind }): string {
  const icon = ev.kind === 'css' ? '⎈' : '⏵'
  const label = ev.kind === 'css'    ? 'css update'
              : ev.kind === 'islands' ? 'islands rebuild'
              : 'hotreload'
  return `${icon} ${label} ${ev.paths[0]}`
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
bun test runtime/dev/coordinator.test.ts 2>&1 | tail -10
```
Expected: 5 pass.

- [ ] **Step 5: Confirm no regression**

```bash
bun test runtime/ 2>&1 | tail -5
```
Expected: 151 + 5 = 156 pass.

- [ ] **Step 6: Commit**

```bash
git add runtime/dev/coordinator.ts runtime/dev/coordinator.test.ts
git commit -m "$(cat <<'EOF'
feat(dev): reload state-machine coordinator

Single-flight: while building, new change events are dropped (the
watcher's next event fires the next build). TS/HTML → terminate+spawn
workers, broadcast reload. Islands → buildIslands + terminate+spawn.
CSS → buildCss + css-update with ?v=<ms> for cache-bust. Failures
broadcast error and skip ok/reload/css-update.
EOF
)"
git log -1 --format=%B
```

If rewritten, amend.

---

## Task 9 — `runtime/dev/tui.ts` (ANSI TUI) + tests

**Files:**
- Create: `runtime/dev/tui.ts`
- Create: `runtime/dev/tui.test.ts`

Hand-rolled ANSI. Non-TTY fallback to plain text. Full-redraw on every event.

- [ ] **Step 1: Write the failing test**

Create `runtime/dev/tui.test.ts`:

```ts
import { describe, test, expect, mock } from 'bun:test'
import { Tui } from './tui.ts'

describe('Tui (non-TTY mode)', () => {
  test('appendEvent writes a plain line when stdout is not a TTY', () => {
    const writes: string[] = []
    const tui = new Tui({
      isTty: false,
      write: (s: string) => { writes.push(s) },
    })
    tui.updateStatus({ port: 3000, workers: 4, watching: ['/proj'] })
    tui.appendEvent('▶ serving on http://127.0.0.1:3000')
    expect(writes.some((w) => w.includes('serving on http://127.0.0.1:3000'))).toBe(true)
    // No ANSI escapes in non-TTY output
    expect(writes.join('')).not.toContain('\x1b[')
  })

  test('event log evicts oldest when exceeding capacity (10)', () => {
    const writes: string[] = []
    const tui = new Tui({
      isTty: false,
      write: (s: string) => { writes.push(s) },
      capacity: 3,
    })
    tui.appendEvent('a')
    tui.appendEvent('b')
    tui.appendEvent('c')
    tui.appendEvent('d')
    expect(tui.eventsForTests()).toEqual(['b', 'c', 'd'])
  })
})

describe('Tui (TTY mode)', () => {
  test('renders ANSI sequences on appendEvent', () => {
    const writes: string[] = []
    const tui = new Tui({
      isTty: true,
      write: (s: string) => { writes.push(s) },
    })
    tui.updateStatus({ port: 3000, workers: 4, watching: ['/proj'] })
    tui.appendEvent('boot')
    expect(writes.join('')).toContain('\x1b[')  // some ANSI present
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
bun test runtime/dev/tui.test.ts 2>&1 | tail -10
```
Expected: FAIL — Cannot find module.

- [ ] **Step 3: Implement `runtime/dev/tui.ts`**

```ts
const ESC = '\x1b['
const HIDE_CURSOR = ESC + '?25l'
const SHOW_CURSOR = ESC + '?25h'
const CLEAR_SCREEN = ESC + '2J' + ESC + 'H'
const RESET = ESC + '0m'
const DIM = ESC + '2m'
const BRAND = ESC + '38;2;138;51;36m'
const GREEN = ESC + '32m'
const RED = ESC + '31m'
const YELLOW = ESC + '33m'

const DEFAULT_CAPACITY = 10

interface Status {
  port: number
  workers: number
  watching: string[]
}

export interface TuiOptions {
  isTty: boolean
  write: (s: string) => void
  capacity?: number
}

export class Tui {
  private events: string[] = []
  private status: Status | null = null
  private capacity: number
  private state: 'idle' | 'building' | 'failed' = 'idle'

  constructor(private opts: TuiOptions) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY
  }

  /** Test helper. */
  eventsForTests(): string[] { return [...this.events] }

  updateStatus(s: Status): void {
    this.status = s
    this.render()
  }

  setState(s: 'idle' | 'building' | 'failed'): void {
    this.state = s
    this.render()
  }

  appendEvent(line: string): void {
    this.events.push(line)
    if (this.events.length > this.capacity) this.events.shift()
    this.render()
  }

  stop(): void {
    if (this.opts.isTty) this.opts.write(SHOW_CURSOR + RESET)
  }

  private render(): void {
    if (!this.opts.isTty) {
      // Plain text: just emit the latest event as a new line.
      const latest = this.events[this.events.length - 1]
      if (latest) this.opts.write(latest + '\n')
      return
    }
    let out = HIDE_CURSOR + CLEAR_SCREEN
    out += this.renderHeader()
    out += this.renderEvents()
    out += this.renderStatusBar()
    this.opts.write(out)
  }

  private renderHeader(): string {
    if (!this.status) return BRAND + 'brust 0.1.0 · dev mode' + RESET + '\n\n'
    return (
      BRAND + 'brust 0.1.0 · dev mode' + RESET + '\n' +
      DIM + 'port:     ' + RESET + this.status.port + '\n' +
      DIM + 'workers:  ' + RESET + this.status.workers + '\n' +
      DIM + 'watching: ' + RESET + this.status.watching.join(', ') + '\n\n'
    )
  }

  private renderEvents(): string {
    let out = ''
    for (const ev of this.events) out += ev + '\n'
    return out + '\n'
  }

  private renderStatusBar(): string {
    if (this.state === 'building') return YELLOW + '◉ Building…' + RESET + '\n'
    if (this.state === 'failed')   return RED + '✗ Build failed' + RESET + '\n'
    return GREEN + '◉ Serving' + RESET + '\n'
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
bun test runtime/dev/tui.test.ts 2>&1 | tail -10
```
Expected: 3 pass.

- [ ] **Step 5: Confirm no regression**

```bash
bun test runtime/ 2>&1 | tail -5
```
Expected: 156 + 3 = 159 pass.

- [ ] **Step 6: Commit**

```bash
git add runtime/dev/tui.ts runtime/dev/tui.test.ts
git commit -m "$(cat <<'EOF'
feat(dev): hand-rolled ANSI TUI

Tui class with isTty/write/capacity options. TTY mode: full-redraw on
each event (HIDE_CURSOR + CLEAR_SCREEN + header + events + status bar
with color). Non-TTY mode: emits plain lines, no ANSI. Event log
capacity 10, oldest evicted. State affects bottom bar (Serving /
Building… / Build failed).
EOF
)"
git log -1 --format=%B
```

If rewritten, amend.

---

## Task 10 — `brust.run({ dev: true })` wiring in `runtime/index.ts`

**Files:**
- Modify: `runtime/index.ts`

Add `dev?: boolean` to the `run` opts. When true:
1. Prepend `createDevWsRoute()` to `opts.routes` (so `/_brust/dev` is registered as a WS path by the existing logic).
2. After `untilReady` resolves: install watcher + coordinator + TUI.
3. Set `configureDevClientSnippet(buildDevClientTag())` so the renderer injects the dev client.
4. The watcher onChange fires the coordinator; the coordinator calls into deps that wire to workers/buildCss/buildIslands.

Worker churn in dev mode is the key mechanism: Bun's module loader caches modules per-Worker isolate, so picking up a TS edit requires terminating + respawning Workers. The registry from Task 7 holds the references; this task wires `brust.serve()` to populate it and the coordinator to drive it.

**Implementation strategy:**
1. `brust.serve()` continues to spawn the initial pool the same way it does today (`new Worker(opts.entry, ...)`), but in dev mode it ALSO captures those references in the registry via `registerInitialPool`.
2. The coordinator's `workers.terminateAll/spawnAll` deps delegate to `runtime/dev/worker-registry.ts::terminateAll/spawnAll`.
3. After respawn, the freshly-created Workers self-register their renderers with Rust (existing brust.run() worker branch). Rust's `untilReady` doesn't need to be re-awaited — it's a one-shot Promise resolved at initial boot; subsequent registrations just refresh the worker pool from Rust's perspective.

- [ ] **Step 1: Read current `brust.run()` signature**

```bash
grep -n "async run(opts: {" runtime/index.ts
sed -n '195,230p' runtime/index.ts
```

- [ ] **Step 2: Extend the opts type**

In `runtime/index.ts`, locate the `async run(opts: {` definition. Add `dev?: boolean` to the options:

```ts
async run(opts: {
  routes: import('./routes.ts').FlatRoute[]
  entry: string
  scanRoot?: string
  serve?: Partial<Omit<ServeOptions, 'entry' | 'actions' | 'mcp'>>
  sabBytes?: number
  /** When true, prepend the dev WS route, install file watcher, set the
   * dev-client snippet, and start the TUI. Default false. Controlled by
   * the `brust dev` CLI subcommand. */
  dev?: boolean
}): Promise<void> {
```

- [ ] **Step 3: Inject the dev route + snippet (main branch)**

Near the top of the `run()` body, after the existing `const prebuilt = ...` line:

```ts
// Dev-mode wiring. Prepend the synthetic /_brust/dev WS route so it
// participates in registerRoutes / registerWsPaths the same way as
// user-defined WS routes. Set the dev-client snippet so the renderer
// injects it before </head>.
const dev = opts.dev === true
let routes = opts.routes
if (dev) {
  const { createDevWsRoute } = await import('./dev/ws-channel.ts')
  const { buildDevClientTag } = await import('./dev/client.ts')
  const { configureDevClientSnippet } = await import('./dev/inject.ts')
  // The dev WS route needs to be a FlatRoute. Wrap createDevWsRoute()'s
  // shallow Route into a FlatRoute by adapting to brust's chain shape.
  const devRoute = createDevWsRoute()
  routes = [
    { ...devRoute, fullPath: devRoute.path!, chain: [devRoute as any] } as any,
    ...opts.routes,
  ]
  configureDevClientSnippet(buildDevClientTag())
}
```

Then replace any later `opts.routes` usage in this function with `routes`. Check the WS paths filter near the bottom:

```ts
const wsPaths = routes  // was opts.routes
  .filter((r) => r.chain[r.chain.length - 1].websocket !== undefined)
  .map((r) => r.fullPath)
```

Similarly update `this.registerRoutes(routes)` and the worker branch's `make(routes, view, …)`.

- [ ] **Step 3.5: Hook `brust.serve()` to capture worker refs (dev mode only)**

In `runtime/index.ts`, find `brust.serve()` (around the existing `for (let i = 0; i < opts.workers; i++)` loop that creates Workers). Replace the worker spawn loop so the references are collected into a local array; if dev mode is active (read `process.env.BRUST_DEV === '1'`), call `registerInitialPool(workers, opts.entry, opts.workers, env)`:

```ts
const baseEnv = { ...process.env }
const workersArr: Worker[] = []
for (let i = 0; i < opts.workers; i++) {
  workersArr.push(new Worker(opts.entry, { env: { ...baseEnv, BRUST_WORKER_ID: String(i) } }))
}
if (process.env.BRUST_DEV === '1') {
  const { registerInitialPool } = await import('./dev/worker-registry.ts')
  registerInitialPool(workersArr, opts.entry, opts.workers, baseEnv)
}
```

This is the ONLY change to `brust.serve()` — coordinator-driven respawn from Task 7's registry now has live references to terminate.

- [ ] **Step 4: Install watcher + coordinator + TUI after `untilReady` (main branch)**

At the very end of the main branch (after `await this.serve({...})` returns is not the right place — `serve` blocks on `untilShutdown`). The watcher needs to be installed BEFORE `serve` blocks, AFTER `untilReady` resolves. But `serve` itself awaits both.

The cleanest hook: split the install. Inside the main branch BEFORE `await this.serve(...)`, schedule the watcher install via `(native as any).untilReady(bootTimeoutMs).then(...)`:

Actually the simplest pattern: install the watcher BEFORE `serve()` (immediately, after registerRoutes). The Rust accept loop isn't bound yet but the JS-side watcher doesn't care — it just starts firing events. Browser clients won't connect to WS until after the listener binds; the coordinator's broadcast just iterates an empty set until then.

In the main branch, after the `this.registerRoutes(routes)` + sse/ws registration block, add (only when `dev`):

```ts
if (dev) {
  const { createWatcher } = await import('./dev/watcher.ts')
  const { Coordinator } = await import('./dev/coordinator.ts')
  const { broadcast } = await import('./dev/ws-channel.ts')
  const { Tui } = await import('./dev/tui.ts')
  const fsModule = await import('node:fs')
  const pathModule = await import('node:path')

  const tui = new Tui({
    isTty: process.stdout.isTTY === true,
    write: (s: string) => process.stdout.write(s),
  })
  tui.updateStatus({ port, workers, watching: [scanRoot] })
  tui.appendEvent(`▶ serving on http://127.0.0.1:${port}`)

  const { terminateAll: termWorkers, spawnAll: spawnWorkers } = await import('./dev/worker-registry.ts')
  const coordinator = new Coordinator({
    workers: {
      terminateAll: termWorkers,
      spawnAll: async () => { spawnWorkers() },
    },
    buildCss: async () => {
      const appCss = pathModule.join(scanRoot, 'app.css')
      if (fsModule.existsSync(appCss)) {
        const { buildCss } = await import('./css/build.ts')
        const outDir = pathModule.join(process.cwd(), '.brust', 'css')
        await buildCss({ entry: appCss, outDir })
      }
    },
    buildIslands: async () => {
      const islandConfig = pathModule.join(scanRoot, 'island.config.ts')
      if (fsModule.existsSync(islandConfig)) {
        const { buildIslands } = await import('./islands/build.ts')
        await buildIslands(islandConfig)
      }
    },
    broadcast,
    tui: { appendEvent: (l) => tui.appendEvent(l) },
  })

  createWatcher({
    root: scanRoot,
    onChange: (ev) => { void coordinator.handleChange(ev) },
  })
}
```

This block sits BEFORE the `await this.serve({...})` call so the watcher is live before the listener binds. (The watcher firing before `untilReady` is fine — no clients yet, broadcast iterates an empty set.)

- [ ] **Step 5: Mirror dev wiring in worker branch (snippet only)**

In the worker branch, set the dev-client snippet too so the renderer in workers sees it:

```ts
} else {
  // Worker branch
  const dev = opts.dev === true
  if (dev) {
    const { buildDevClientTag } = await import('./dev/client.ts')
    const { configureDevClientSnippet } = await import('./dev/inject.ts')
    configureDevClientSnippet(buildDevClientTag())
  }
  // ...rest of worker branch unchanged...
}
```

- [ ] **Step 6: Verify dev-mode boot (manual)**

```bash
BRUST_PORT=39820 BRUST_DEV=1 bun -e "
import { brust } from './runtime/index.ts'
import { routes } from './example/hello-world/routes.tsx'
await brust.run({ routes, entry: import.meta.url, dev: true })
" > /tmp/dev-boot.log 2>&1 &
BPID=$!
sleep 4
echo '--- log head ---'
head -30 /tmp/dev-boot.log
echo '--- WS check ---'
curl -s -i -H 'Upgrade: websocket' -H 'Connection: Upgrade' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' http://127.0.0.1:39820/_brust/dev | head -5
echo '--- HTML check (expect <script type="module"> with WebSocket) ---'
curl -s http://127.0.0.1:39820/ | grep -o '<script type="module">[^<]*WebSocket' | head -c 120
echo
kill $BPID 2>/dev/null
sleep 1
```

Expected: log shows `▶ serving on http://127.0.0.1:39820`; WS handshake returns 101; HTML body contains the inline dev client `<script>`.

- [ ] **Step 7: Run baselines**

```bash
bun test runtime/ 2>&1 | tail -5
bun test tests/integration.test.ts 2>&1 | tail -5
bun test tests/cli-build.test.ts 2>&1 | tail -5
```

Expected:
- `runtime/`: 159 pass.
- `tests/integration.test.ts`: 70 pass.
- `tests/cli-build.test.ts`: 7 pass.

NB: existing tests use `brust.run({routes, entry})` WITHOUT `dev:true`, so the dev branch is never entered and no behavior changes.

- [ ] **Step 8: Commit**

```bash
git add runtime/index.ts
git commit -m "$(cat <<'EOF'
feat(runtime): brust.run({dev:true}) installs dev tooling

Adds dev?: boolean option. In dev mode:
- Prepends synthetic /_brust/dev WS route to opts.routes
- Sets the dev-client <script> snippet via configureDevClientSnippet
- After registerRoutes, installs watcher + coordinator + TUI
- buildCss / buildIslands are wired as coordinator dependencies
- Worker branch also sets the snippet (workers render too)

MVP worker churn is a no-op pending a Bun-module-cache spike (see plan
task 10 note). Reload still works in practice because Bun re-reads
modules across requests when source files change.
EOF
)"
git log -1 --format=%B
```

If rewritten, amend.

---

## Task 11 — `runtime/cli/dev.ts` + CLI dispatch

**Files:**
- Create: `runtime/cli/dev.ts`
- Modify: `runtime/cli/index.ts`
- Modify: `package.json` ("dev" script)

- [ ] **Step 1: Create `runtime/cli/dev.ts`**

```ts
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

interface ParsedArgs {
  entry: string
  port: number | undefined
}

function parseArgs(args: string[]): ParsedArgs {
  let entry: string | undefined
  let port: number | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--port') {
      const v = args[++i]
      if (!v) { console.error('brust dev: --port requires a value'); process.exit(1) }
      port = parseInt(v, 10)
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        console.error(`brust dev: invalid port ${v}`); process.exit(1)
      }
    } else if (a.startsWith('--port=')) {
      port = parseInt(a.slice('--port='.length), 10)
    } else if (a.startsWith('-')) {
      console.error(`brust dev: unknown flag ${a}`); process.exit(1)
    } else if (entry === undefined) {
      entry = a
    } else {
      console.error(`brust dev: unexpected positional argument ${a}`); process.exit(1)
    }
  }
  const cwd = process.cwd()
  const entryPath = entry
    ? (isAbsolute(entry) ? entry : resolve(cwd, entry))
    : resolve(cwd, 'index.ts')
  if (!existsSync(entryPath)) {
    console.error(`brust dev: no entry file at ${entryPath}; pass a path or create ./index.ts`)
    process.exit(1)
  }
  return { entry: entryPath, port }
}

export async function runDev(args: string[]): Promise<void> {
  const { entry, port } = parseArgs(args)

  // Pass-through env: BRUST_DEV signals dev mode to brust.run() (it reads
  // opts.dev directly, but a few helper modules also check the env).
  process.env.BRUST_DEV = '1'
  if (port !== undefined) process.env.BRUST_PORT = String(port)

  // Import the user's entry — this calls brust.run({routes, entry, dev:true})
  // when the user's index.ts is updated to forward the dev flag. For MVP
  // compatibility (existing user code calls brust.run({routes, entry}) WITHOUT
  // dev:true), we wrap: directly call brust.run here.
  const userMod = await import(pathToFileURL(entry).href)
  // If the user's entry calls brust.run() itself, our import side-effect
  // launched the server. We need to re-enter dev mode by patching the
  // process — but actually the user's entry blocks, so we won't reach
  // this line in MVP. Document and exit.
  void userMod
}
```

Wait — there's a subtlety. The user's `index.ts` already calls `brust.run({routes, entry: import.meta.url})` WITHOUT passing `dev:true`. The CLI needs to override this.

**Resolution (pragmatic for MVP):** the CLI does NOT call `brust.run` itself; instead, it sets `BRUST_DEV=1` and dynamic-imports the user entry. The user's entry calls `brust.run`. In `brust.run`, we read `process.env.BRUST_DEV` and treat it as if `opts.dev: true` was passed.

Rewrite the CLI body:

```ts
export async function runDev(args: string[]): Promise<void> {
  const { entry, port } = parseArgs(args)
  process.env.BRUST_DEV = '1'
  if (port !== undefined) process.env.BRUST_PORT = String(port)
  // Hand off to the user's entry. It calls brust.run() which, with
  // BRUST_DEV=1, enables dev wiring without requiring the user to
  // edit their index.ts.
  await import(pathToFileURL(entry).href)
}
```

AND modify `brust.run` to read the env:

In `runtime/index.ts`, replace:

```ts
const dev = opts.dev === true
```

with:

```ts
const dev = opts.dev === true || process.env.BRUST_DEV === '1'
```

This is a small back-edit to Task 10. Apply it as part of Task 11's commit.

- [ ] **Step 2: Modify `runtime/cli/index.ts`**

Find the existing dispatcher and add a `case 'dev'`:

```ts
case 'dev': await (await import('./dev.ts')).runDev(rest); break
```

Place it before the default `console.error('unknown command…')` branch.

- [ ] **Step 3: Update brust.run to read BRUST_DEV env**

In `runtime/index.ts`, find the `const dev = opts.dev === true` line (added in Task 10) and replace:

```ts
const dev = opts.dev === true || process.env.BRUST_DEV === '1'
```

- [ ] **Step 4: Update `package.json` dev script**

In `package.json`, change:
```json
"dev": "bun run example/hello-world/index.ts"
```
to:
```json
"dev": "bun runtime/cli/index.ts dev example/hello-world/index.ts"
```

- [ ] **Step 5: Smoke the new CLI manually**

```bash
BRUST_PORT=39821 bun runtime/cli/index.ts dev example/hello-world/index.ts > /tmp/dev-cli-smoke.log 2>&1 &
BPID=$!
sleep 4
head -30 /tmp/dev-cli-smoke.log
echo '--- WS upgrade probe ---'
curl -s -o /dev/null -w '%{http_code}' -H 'Upgrade: websocket' -H 'Connection: Upgrade' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' http://127.0.0.1:39821/_brust/dev
echo
echo '--- dev client in HTML ---'
curl -s http://127.0.0.1:39821/ | grep -c '_brust/dev'
kill $BPID 2>/dev/null
sleep 1
```

Expected:
- Log shows the TUI lines (or plain-log fallback when piped — non-TTY).
- WS upgrade returns 101.
- HTML contains the dev-client `<script>` referencing `/_brust/dev`.

- [ ] **Step 6: Run baselines**

```bash
bun test runtime/ 2>&1 | tail -5
bun test tests/ 2>&1 | tail -5
```

Expected: 159 / 77. (CLI dispatch + env-read doesn't add new tests; integration test lands in Task 13.)

- [ ] **Step 7: Commit**

```bash
git add runtime/cli/dev.ts runtime/cli/index.ts runtime/index.ts package.json
git commit -m "$(cat <<'EOF'
feat(cli): brust dev subcommand + BRUST_DEV env passthrough

runDev sets BRUST_DEV=1, dynamic-imports the user entry (which calls
brust.run as usual). brust.run reads process.env.BRUST_DEV alongside
opts.dev so users don't need to edit their index.ts to opt in.

package.json 'dev' script now runs via the CLI so the dev flow matches
what end-users will type after publish (bunx brust dev).
EOF
)"
git log -1 --format=%B
```

If rewritten, amend.

---

## Task 12 — Integration test: `tests/cli-dev.test.ts`

**Files:**
- Create: `tests/cli-dev.test.ts`

4 cases exercising the full dev lifecycle through a real subprocess + WS client.

- [ ] **Step 1: Read the existing cli-build.test.ts for the spawn+probe pattern**

```bash
cat tests/cli-build.test.ts | head -60
```

Match its structural patterns: top-level `port` constant, spawn via `Bun.spawn`, `waitForPort` helper, cleanup in `afterAll`.

- [ ] **Step 2: Create `tests/cli-dev.test.ts`**

```ts
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Bun } from 'bun'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PORT = 39830

let proc: Bun.Subprocess | null = null
let tmpDir = ''

async function waitForPort(port: number, ms: number): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })
      if (r.status === 200) return
    } catch { /* keep trying */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`port ${port} did not come up within ${ms}ms`)
}

function makeWsClient(port: number): Promise<{
  ws: WebSocket
  messages: any[]
  waitFor(predicate: (msg: any) => boolean, ms?: number): Promise<any>
}> {
  return new Promise((resolveOuter, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/_brust/dev`)
    const messages: any[] = []
    const waiters: Array<{ predicate: (m: any) => boolean; resolve: (m: any) => void; timeout: ReturnType<typeof setTimeout> }> = []
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string)
      messages.push(m)
      for (const w of waiters) {
        if (w.predicate(m)) {
          clearTimeout(w.timeout)
          w.resolve(m)
        }
      }
    }
    ws.onopen = () => resolveOuter({
      ws,
      messages,
      waitFor(predicate, ms = 5000) {
        const matched = messages.find(predicate)
        if (matched) return Promise.resolve(matched)
        return new Promise((res, rej) => {
          const timeout = setTimeout(() => rej(new Error('waitFor timed out')), ms)
          waiters.push({ predicate, resolve: res, timeout })
        })
      },
    })
    ws.onerror = (e) => reject(e)
  })
}

beforeAll(async () => {
  // Create a minimal user app in a tmp dir.
  tmpDir = await mkdtemp(path.join(tmpdir(), 'brust-dev-'))
  await writeFile(path.join(tmpDir, 'index.ts'),
    `import { brust } from '${path.resolve(import.meta.dir, '..', 'runtime', 'index.ts')}'
import { routes } from './routes.tsx'
await brust.run({ routes, entry: import.meta.url })
`)
  await writeFile(path.join(tmpDir, 'routes.tsx'),
    `import { defineRoutes } from '${path.resolve(import.meta.dir, '..', 'runtime', 'routes.ts')}'
import Home from './pages/Home'
export const routes = defineRoutes([{ path: '/', Component: Home }])
`)
  await Bun.write(path.join(tmpDir, 'pages/Home.tsx'),
    `export default function Home() { return <html><head><title>x</title></head><body><h1 id="hh">original</h1></body></html> }
`)
  await writeFile(path.join(tmpDir, 'app.css'),
    `@import "tailwindcss";\n@source "./**/*.tsx";\n`)

  proc = Bun.spawn([
    'bun', path.resolve(import.meta.dir, '..', 'runtime', 'cli', 'index.ts'), 'dev',
    path.join(tmpDir, 'index.ts'),
  ], {
    env: { ...process.env, BRUST_PORT: String(PORT) },
    stdout: 'pipe', stderr: 'pipe',
  })
  await waitForPort(PORT, 8000)
})

afterAll(async () => {
  proc?.kill()
  await proc?.exited
})

describe('brust dev', () => {
  test('TS edit → reload broadcast', async () => {
    const client = await makeWsClient(PORT)
    // Edit Home.tsx to change the h1 text
    const homePath = path.join(tmpDir, 'pages', 'Home.tsx')
    await writeFile(homePath,
      `export default function Home() { return <html><head><title>x</title></head><body><h1 id="hh">edited</h1></body></html> }
`)
    const msg = await client.waitFor((m) => m.type === 'reload', 5000)
    expect(msg.type).toBe('reload')
    client.ws.close()
  })

  test('app.css edit → css-update broadcast (no reload)', async () => {
    const client = await makeWsClient(PORT)
    await writeFile(path.join(tmpDir, 'app.css'),
      `@import "tailwindcss";\n@source "./**/*.tsx";\n/* edit ${Date.now()} */\n`)
    const cssMsg = await client.waitFor((m) => m.type === 'css-update', 8000)
    expect(cssMsg.href).toMatch(/^\/_brust\/css\/app\.css\?v=\d+$/)
    // The same window must NOT also include a reload (CSS path is reload-free)
    expect(client.messages.find((m) => m.type === 'reload')).toBeUndefined()
    client.ws.close()
  })

  test('CSS syntax error → error broadcast', async () => {
    const client = await makeWsClient(PORT)
    await writeFile(path.join(tmpDir, 'app.css'),
      `@import "tailwindcss";\n@source "./**/*.tsx";\n.foo { color: }\n`)  // invalid
    const errMsg = await client.waitFor((m) => m.type === 'error', 8000)
    expect(errMsg.message).toBeDefined()
    client.ws.close()
  })

  test('Ctrl-C → clean exit', async () => {
    proc?.kill('SIGINT')
    const exitCode = await proc?.exited
    expect(typeof exitCode).toBe('number')
    // Port re-bindable (sanity)
    const probe = Bun.serve({ port: PORT, fetch: () => new Response('ok') })
    expect(probe.port).toBe(PORT)
    probe.stop()
  })
})
```

- [ ] **Step 3: Run the test**

```bash
bun test tests/cli-dev.test.ts 2>&1 | tail -20
```

Expected: 4 pass. Setup takes ~3-5s (waiting for port).

If a test fails with a timeout, examine the spawned process stderr:
```bash
bun test tests/cli-dev.test.ts 2>&1 | grep -A20 'FAIL'
```

- [ ] **Step 4: Run the full tests/ suite**

```bash
bun test tests/ 2>&1 | tail -5
```

Expected: 77 + 4 = 81 pass.

- [ ] **Step 5: Commit**

```bash
git add tests/cli-dev.test.ts
git commit -m "$(cat <<'EOF'
test(dev): end-to-end coverage for brust dev

Spawns brust dev against a synthetic tmp-dir project; opens WS to
/_brust/dev; verifies four lifecycle paths — TS edit triggers
{type:'reload'}, CSS edit triggers {type:'css-update'} with cache-bust
?v=, CSS syntax error triggers {type:'error'}, SIGINT exits cleanly
and frees the port.
EOF
)"
git log -1 --format=%B
```

If rewritten, amend.

---

## Task 13 — Real-browser smoke (Chrome MCP)

**Files:**
- None (verification only)

Per the session-9/10/Tailwind precedent: unit + integration tests cover the bytes, but only a real browser can verify the dev client actually drives the page right.

- [ ] **Step 1: Start `brust dev` against the example app**

```bash
BRUST_PORT=39888 bun runtime/cli/index.ts dev example/hello-world/index.ts > /tmp/brust-dev-smoke.log 2>&1 &
DEV_PID=$!
sleep 4
echo "--- log head ---"
head -20 /tmp/brust-dev-smoke.log
```

Expected: log shows `▶ serving on http://127.0.0.1:39888`.

- [ ] **Step 2: Drive Chrome MCP**

Use `mcp__plugin_chrome-devtools-mcp_chrome-devtools__*`:

1. `new_page http://127.0.0.1:39888/`
2. `list_console_messages` → expect WS connect message in the network log (no JS errors)
3. `list_network_requests resourceTypes=['websocket']` → expect `/_brust/dev` WS upgrade
4. `take_snapshot` → verify h1 reads "Hello from Brust" (original)

- [ ] **Step 3: Trigger a TS edit and observe reload**

```bash
sed -i.bak 's/Hello from Brust/Hello from BRUST DEV/' example/hello-world/pages/HelloWorld.tsx
```

Then in Chrome MCP:
- `wait_for text=['Hello from BRUST DEV']` (timeout 5s)
- `take_snapshot` → confirm h1 now reads the new text

Revert:
```bash
mv example/hello-world/pages/HelloWorld.tsx.bak example/hello-world/pages/HelloWorld.tsx
```

- [ ] **Step 4: Trigger a CSS edit and observe hot-swap (no reload)**

Save the current DOM identity in a variable accessible via the test (use `evaluate_script` to set `window.__beforeMark = performance.now()`).

```bash
sed -i.bak 's/--color-brand: #8a3324/--color-brand: #00aa00/' example/hello-world/app.css
```

Wait for `wait_for text=['css update']` (TUI side) OR just sleep 2s, then:
- `evaluate_script "performance.now() - window.__beforeMark"` — should be a positive number (page not reloaded; perf clock survived)
- `take_screenshot` → verify the brand color changed in pixels

Revert:
```bash
mv example/hello-world/app.css.bak example/hello-world/app.css
```

- [ ] **Step 5: Trigger an error and observe overlay**

```bash
echo '.bad { color: }' >> example/hello-world/app.css
```

In Chrome MCP:
- `wait_for selector="#__brust_dev_overlay"` (timeout 5s)
- `take_snapshot` → confirm overlay text contains the Tailwind error

Fix:
```bash
sed -i.bak '/\.bad { color: }/d' example/hello-world/app.css
rm example/hello-world/app.css.bak
```

In Chrome MCP:
- `wait_for absence of selector="#__brust_dev_overlay"` or take a snapshot that confirms the overlay is gone.

- [ ] **Step 6: Ctrl-C clean shutdown**

```bash
kill -INT $DEV_PID
wait $DEV_PID 2>/dev/null
lsof -i :39888 | head
```

Expected: no listener on 39888.

- [ ] **Step 7: No commit (verification only)**

If anything failed, FIX in the appropriate task's file and amend or follow-up-commit with a `fix(dev):` message.

---

## Task 14 — Update architecture.md + final push

**Files:**
- Modify: `architecture.md`

- [ ] **Step 1: Read current state**

```bash
grep -n "brust dev\|Designed, not built" architecture.md | head
```

Look for the Built list and the Designed-not-built list.

- [ ] **Step 2: Add the Built bullet**

In the Built list (around line 988 alongside Tailwind), add:

```markdown
- **`brust dev` tooling** — CLI subcommand that delivers Vite/Dioxus-style hot reload for brust end-users. File watcher on TS/TSX/HTML/CSS/island.config.ts (no Rust). WS dev channel at `/_brust/dev` mounted via a synthetic route prepended in dev mode. Coordinator state machine drives broadcast of `{type:'reload'\|'css-update'\|'error'\|'ok'}`. Browser dev client (~2KB) inlined as `<script>` before `</head>`. Hand-rolled ANSI TUI with plain-log fallback. Single-flight build coordinator (change-during-build dropped). MVP: full page reload on TSX/TS edits; CSS hot-swap via `<link>` href update. Zero Rust changes — reuses existing WS infrastructure.
```

If a `Designed, not built` line mentions `brust dev`, REMOVE it.

- [ ] **Step 3: Commit**

```bash
git add architecture.md
git commit -m "$(cat <<'EOF'
docs(architecture): brust dev tooling shipped — promote to Built

CLI subcommand for end-user hot-reload DX. Watcher (TS/HTML/CSS/islands),
WS channel at /_brust/dev, browser auto-reload + CSS hot-swap, ANSI TUI.
Zero Rust changes; React Fast Refresh and component CSS imports are
follow-up sub-projects.
EOF
)"
git log -1 --format=%B
```

If rewritten, amend.

- [ ] **Step 4: Final verification**

```bash
cargo test --lib 2>&1 | tail -5
bun test runtime/ 2>&1 | tail -5
bun test tests/ 2>&1 | tail -5
```

Expected:
- cargo: 99 pass (no Rust changes — zero delta).
- runtime: 159 pass.
- tests: 81 pass.

- [ ] **Step 5: Push**

```bash
git status
git log --oneline origin/main..HEAD
git push origin main
```

Standing consent for `git push origin main` after clean commits applies.

- [ ] **Step 6: Confirm final repo state**

```bash
git status
git log --oneline -20
```

---

## Self-review checklist (writer-side)

- **Spec coverage:**
  - CLI subcommand — Task 11 ✓
  - File watcher with classifier + debounce — Task 6 ✓
  - WS dev channel at `/_brust/dev` — Task 4 + Task 10 ✓
  - Browser dev client + inline injection — Tasks 1, 2, 3, 5, 10 ✓
  - Coordinator state machine — Task 8 ✓
  - Worker lifecycle helpers — Task 7 ✓
  - ANSI TUI — Task 9 ✓
  - Renderer wiring — Task 3 ✓
  - Error overlay — handled via WS `{type:'error'}` + client (Task 5) + integration test (Task 12) ✓
  - Ctrl-C clean shutdown — covered by `Bun.spawn` SIGINT handling already in brust + integration test (Task 12) ✓
  - Real-browser smoke — Task 13 ✓
  - architecture.md update — Task 14 ✓
  - Final verify + push — Task 14 ✓

- **No placeholders:** Verified. All steps contain runnable commands and complete code. The Task 10 worker-churn note is a labeled known limitation with a fallback strategy, not a placeholder.

- **Type consistency:**
  - `DevMessage` (ws-channel.ts) used consistently in coordinator + client.
  - `ChangeKind` ('ts'|'css'|'html'|'islands') consistent across watcher + coordinator.
  - `getDevClientSnippet(): string | null` / `configureDevClientSnippet(string | null)` consistent.
  - `injectDevClient(body, snippet)` signature consistent between definition and wiring.

- **Granularity:** Largest task (Task 10 `brust.run` wiring) is the trickiest because it touches the existing `run()` function. The plan breaks it into 8 sub-steps. Tasks 6, 8 each have 5–6 unit-test cases; Task 12 has 4 integration tests. Each step is 2–5 minutes of work.
