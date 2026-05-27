# `brust dev` Tooling — Design

**Date:** 2026-05-27
**Status:** Designed, awaiting plan
**Scope:** New CLI subcommand `brust dev` that delivers Dioxus-style hot-reload DX for end-users of brust (people writing apps in TS/TSX/CSS). Watcher + WS dev channel + browser auto-reload + CSS hot-swap + hand-rolled ANSI TUI + error overlay. No Rust file watching (out of scope by design — brust users don't write Rust). No React Fast Refresh (full page reload is MVP; Fast Refresh is a downstream follow-up).

---

## Goal

Match the developer experience users get from `dx serve` (Dioxus) or `vite dev`: save a file → page reflects the change within ~250ms, no manual restart, no manual refresh. Specifically:

1. `brust dev <entry>` → boot brust in dev mode + watch the user's app dir.
2. Edit any `*.ts`, `*.tsx`, `*.jsx`, `*.js`, `*.html`, `island.config.ts` → workers respawn → browser auto-reloads via WebSocket push.
3. Edit `app.css` → Tailwind recompile → browser swaps the `<link href>` without reloading the page (CSS hot-swap, preserves state).
4. Build errors surface as a red fullscreen overlay in the browser AND in the TUI; fixing the error clears both.
5. Press `Ctrl-C` → graceful shutdown: workers drain, WS closes, cursor restored.

**Critical constraint**: the main process never dies during dev. Rust accept loop binds the port once and stays up. Workers terminate + respawn around it. WS connections to the dev channel persist across worker restarts (clients see the reload signal through the same socket).

---

## Non-goals

- React Fast Refresh / module-level HMR. Full page reload only in MVP. The WS protocol leaves room for `{type:'module-update'}` later.
- Watching `src/**/*.rs` or any framework internal. Brust end-users edit TS/TSX/CSS; the framework itself is a published binary dep.
- Watching `runtime/**/*.ts` (framework source). Same reason.
- Visual studio code-server integration / debug protocol bridge.
- Source map remapping or symbolication.
- Production-mode hot-reload. `BRUST_DEV=1` is the gate; production bundles never inject the dev client.
- Cross-machine dev (LAN exposure / tunneling).
- Watch globs configurable per project. Globs are conventionally fixed (overridable env vars for power users — not a per-project config file).
- React Server Components or RSC-style streaming patches.

---

## High-level architecture

```
brust dev <entry> [--port N]
─────────────────────────────────────────────────────────────
runtime/cli/dev.ts::runDev(args)
  ├─ parse args, set BRUST_DEV=1
  ├─ startTui({ status: 'booting…' })
  └─ await brust.run({ entry, routes, dev: true })
         │
         ├─ existing main-branch path runs (islands, MCP, CSS, registerRoutes, serve)
         ├─ NEW (only when dev:true):
         │     ├─ registerWsPaths(['/_brust/dev'])
         │     ├─ mount /_brust/dev → runtime/dev/ws-channel.ts handler
         │     ├─ configureDevClientSnippet(buildDevClientTag())
         │     └─ AFTER untilReady:
         │           ├─ createWatcher({ roots:[scanRoot], onChange })
         │           ├─ tui.updateStatus({ port, workers, watching:[…] })
         │           └─ install keypress handler (r,c,q) on stdin
         └─ blocks on untilShutdown() like today

REQUEST PATH (dev only):
─────────────────────────────────────────────────────────────
GET /_brust/dev          → WS upgrade, mount in dev-client set
GET /_brust/dev/client.js → JS asset (Rust serves from runtime/dev/client.js)

Renderer first-chunk path:
  body = injectCssLink(body, getCssHrefs())              ← already shipped
  body = injectDevClient(body, getDevClientSnippet())    ← NEW
  encodeFirstChunk(meta, body)

The injected snippet is:
  <script type="module" src="/_brust/dev/client.js" defer></script>


WATCH EVENT FLOW:
─────────────────────────────────────────────────────────────
fs.watch event (one of *.tsx, *.css, etc.)
  → debounce 50ms (coalesce burst-saves)
  → onChange({ paths, kind })  ← kind ∈ 'ts'|'css'|'html'|'islands'
  → coordinator.handleChange:
        ts/html/islands  → broadcastDev({type:'building'})
                         → workers.terminateAll() (2s grace per worker)
                         → workers.spawnAll() + wait for registerRenderer
                         → broadcastDev({type:'reload'})
                         → tui.appendEvent
        css              → broadcastDev({type:'building'})
                         → await buildCss({…})
                         → broadcastDev({type:'css-update', href:'…?v=ms'})
                         → tui.appendEvent
        ANY failure      → broadcastDev({type:'error', message, stack})
                         → tui.appendEvent('✗ …')
```

---

## CLI surface

```
brust dev [entry] [--port N]
```

| Arg / flag | Default | Notes |
|---|---|---|
| `entry` | `./index.ts` (cwd) | Resolved absolute path. Must exist. |
| `--port <n>` | `loadConfig().port` (typically 3000) | Override the configured port. |

No other flags in MVP. Watch globs are conventional, not configurable per-project. No auto-open behavior — TUI prints the URL, user clicks it (or copies it). Auto-open is a future polish that requires an OS-specific shell-out and isn't worth the scope expansion.

Implementation: `runtime/cli/index.ts` switch case adds `case 'dev'`. The CLI shebang (`#!/usr/bin/env bun`) already lets `bunx brust dev` work after publish.

---

## File structure

**New files:**

| File | Responsibility |
|---|---|
| `runtime/cli/dev.ts` | Orchestrator. `runDev(args: string[])`. Parses, sets `BRUST_DEV=1`, starts TUI, calls `brust.run({...dev: true})`. Owns no logic — delegates to dev/* helpers. |
| `runtime/dev/watcher.ts` | `createWatcher({roots, ignores, onChange})`. Wraps Bun's `fs.watch` (recursive). Debounces 50ms. Classifies path → `kind`. |
| `runtime/dev/coordinator.ts` | State machine. `handleChange({paths, kind})`. Coordinates: workers.restart, buildCss, buildIslands. Injected `broadcast` + `tui` callbacks for testability. |
| `runtime/dev/workers.ts` | `terminateAll(workers, opts)` + `spawnAll({entry, count, env})`. Wraps `Bun.Worker` lifecycle. Each spawned worker is awaited until it calls `registerRenderer` (signal observable via napi or via a timeout-based fallback). |
| `runtime/dev/ws-channel.ts` | WS endpoint handler at `/_brust/dev`. Holds `Set<WebSocket>`. Exports `mount(app)` and `broadcast(msg)`. Conforms to brust's `websocket: () => import('…')` route shape. |
| `runtime/dev/inject.ts` | Module-scope `configureDevClientSnippet(snippet: string \| null)` + `getDevClientSnippet(): string \| null`. Mirrors `runtime/css.ts` pattern. |
| `runtime/dev/client.ts` | Browser-side dev client. Compiles to `runtime/dev/client.js` (committed pre-built, ~2KB). Connects WS, dispatches messages, manages overlay DOM, reconnects on close. |
| `runtime/dev/tui.ts` | Hand-rolled ANSI TUI. `startTui()`, `appendEvent`, `updateStatus`, `stopTui`. Auto-detects non-TTY → plain logs. |
| `runtime/render/inject-dev-client.ts` | Pure helper. Same shape as `inject-css-link.ts`: byte-level scan for `</head>`, splice snippet before it. |
| `runtime/dev/watcher.test.ts` | Unit: debounce, ignores, multi-file coalescing. |
| `runtime/dev/coordinator.test.ts` | Unit: state-machine transitions, broadcast hooks, error paths. |
| `runtime/dev/inject.test.ts` | Unit: snippet present iff `BRUST_DEV=1`. |
| `runtime/dev/tui.test.ts` | Unit: event log eviction, status bar transitions, non-TTY fallback. |
| `runtime/render/inject-dev-client.test.ts` | Unit: splice position, multi-call idempotency, non-empty snippet check. |
| `tests/cli-dev.test.ts` | Integration: spawn `brust dev`, hit WS, edit file, assert reload received, assert workers respawn, assert css-update path, assert error path, assert clean shutdown. |

**Modified files:**

| File | Change |
|---|---|
| `runtime/cli/index.ts` | Add `case 'dev'` dispatch. |
| `runtime/index.ts::brust.run()` | Accept `dev?: boolean`. When true: register `/_brust/dev` as WS path, install watcher + coordinator + TUI handles. Wire `configureDevClientSnippet`. |
| `runtime/render/stream.ts` | Apply `injectDevClient(body, getDevClientSnippet())` in the same first-chunk paths that `injectCssLink` runs. |
| `package.json` | Update `"dev"` script to `bun runtime/cli/index.ts dev example/hello-world/index.ts`. |
| `architecture.md` | Promote `brust dev` to Built; document WS protocol; document dev-client injection mechanism. |

**No Rust changes.** Brust's existing `registerWsPaths` already handles literal paths. The dev-client JS asset gets a new branch in `src/server.rs`? — **see "Open question" below**.

---

## WS protocol

JSON messages, server → client only (client never sends after connect):

```ts
type DevMessage =
  | { type: 'building' }                               // server starting work
  | { type: 'reload' }                                 // refresh page
  | { type: 'css-update'; href: string }               // swap <link>
  | { type: 'error';     message: string; stack?: string }
  | { type: 'ok' }                                     // clear overlay
```

Initial connection sends nothing. Server keeps the WS alive with browser-driven pings.

Client-side reconnect: on `ws.onclose`, retry with 1s constant backoff, infinite. No exponential backoff — dev is interactive; 1s is fine.

---

## Browser dev client

Lives at `runtime/dev/client.ts`, pre-built to `runtime/dev/client.js`. Served by Rust at `GET /_brust/dev/client.js` (new branch in `src/server.rs`, mirrors `/_brust/css/`).

```ts
// (sketch — actual ~80 LOC)
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
let ws: WebSocket
function connect() {
  ws = new WebSocket(`${proto}//${location.host}/_brust/dev`)
  ws.onmessage = (e) => handle(JSON.parse(e.data))
  ws.onclose   = () => setTimeout(connect, 1000)
  ws.onerror   = () => { /* swallow; onclose triggers reconnect */ }
}
function handle(msg: DevMessage) {
  switch (msg.type) {
    case 'reload':     location.reload(); break
    case 'css-update': swapCssLink(msg.href); break
    case 'error':      showOverlay(msg.message, msg.stack); break
    case 'ok':         hideOverlay(); break
    case 'building':   /* optional: dim overlay or show spinner */ break
  }
}
function swapCssLink(href: string) {
  const url = new URL(href, location.origin)
  document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
    if (new URL(link.href).pathname === url.pathname) link.href = href
  })
}
function showOverlay(msg: string, stack?: string) {
  let el = document.getElementById('__brust_dev_overlay')
  if (!el) {
    el = document.createElement('div')
    el.id = '__brust_dev_overlay'
    Object.assign(el.style, {
      position:'fixed', inset:'0', background:'rgba(180,30,30,0.95)',
      color:'#fff', font:'14px/1.5 ui-monospace,monospace', padding:'24px',
      zIndex:'2147483647', whiteSpace:'pre-wrap', overflow:'auto',
    })
    document.body.appendChild(el)
  }
  el.textContent = msg + (stack ? '\n\n' + stack : '')
}
function hideOverlay() {
  document.getElementById('__brust_dev_overlay')?.remove()
}
connect()
```

Total bundle: ~2KB minified. Loaded via `<script type="module" src="/_brust/dev/client.js" defer>` injected by the renderer in dev mode.

---

## Reload coordinator

`runtime/dev/coordinator.ts` is a simple state machine, fully unit-testable:

```ts
type State = 'idle' | 'building'

interface CoordinatorDeps {
  workers:   { terminateAll(): Promise<void>; spawnAll(): Promise<void> }
  buildCss:  () => Promise<void>
  buildIslands: () => Promise<void>
  broadcast: (msg: DevMessage) => void
  tui:       { appendEvent(line: string): void }
}

class Coordinator {
  private state: State = 'idle'

  async handleChange(ev: { paths: string[]; kind: ChangeKind }) {
    // Single-flight: drop changes while a build is in flight. The next save
    // (which is moments away in a real dev session) will trigger the next
    // build. No queue, no retries — matches how Vite/Bun handle this.
    if (this.state === 'building') return
    this.state = 'building'
    try {
      this.broadcast({type:'building'})
      this.tui.appendEvent(formatStart(ev))

      const startedAt = performance.now()
      switch (ev.kind) {
        case 'ts': case 'html':
          await this.deps.workers.terminateAll()
          await this.deps.workers.spawnAll()
          this.broadcast({type:'reload'})
          break
        case 'islands':
          await this.deps.buildIslands()
          await this.deps.workers.terminateAll()
          await this.deps.workers.spawnAll()
          this.broadcast({type:'reload'})
          break
        case 'css':
          await this.deps.buildCss()
          this.broadcast({
            type: 'css-update',
            href: '/_brust/css/app.css?v=' + Date.now(),
          })
          break
      }
      const ms = (performance.now() - startedAt) | 0
      this.tui.appendEvent(`  → ok (${ms}ms)`)
      this.broadcast({type:'ok'})
    } catch (e: any) {
      this.tui.appendEvent(`  ✗ ${e.message}`)
      this.broadcast({
        type:'error',
        message: e.message,
        stack: e.stack,
      })
    } finally {
      this.state = 'idle'
    }
  }
}
```

Single-flight: while building, additional change events are dropped. Watcher's next event fires the next build. No queue, no dirty-tracking — pragmatic since real dev sessions don't hit this edge case often, and a queue only adds bugs.

---

## TUI (hand-rolled ANSI)

Layout matches Section 4 of the brainstorm:

```
brust 0.1.0 · dev mode
entry:    example/hello-world/index.ts
port:     3000
workers:  18 / 18 ready
watching: example/hello-world/**/*.{ts,tsx,jsx,js,html}, app.css

12:56:08 ▶  serving on http://127.0.0.1:3000
12:56:18 ⏵  hotreload pages/Home.tsx
12:56:18    → 18 workers respawned (217ms)
12:56:24 ⎈  css update app.css
12:56:24    → ok (147ms)

◉ Serving · 0 errors · last reload 4s ago · ⏎ to reload all clients
```

**Implementation primitives** (`runtime/dev/tui.ts`):

```ts
const ESC = '\x1b['
const HIDE_CURSOR = ESC + '?25l'
const SHOW_CURSOR = ESC + '?25h'
const CLEAR_SCREEN = ESC + '2J' + ESC + 'H'
const moveTo = (row: number, col: number) => `${ESC}${row};${col}H`
const fg = {
  dim:   '\x1b[2m',  brand: '\x1b[38;2;138;51;36m',
  green: '\x1b[32m', red:   '\x1b[31m', yellow:'\x1b[33m',
  reset: '\x1b[0m',
}
```

Full redraw on each event (cheap; event log ≤10 lines).

Non-TTY fallback (`!process.stdout.isTTY`): plain log lines, no ANSI.

Keyboard hotkeys via `process.stdin.setRawMode(true)`:
- `r` → force `broadcastDev({type:'reload'})`
- `c` → clear event log
- `q` / Ctrl-C → graceful shutdown

Restore cursor + raw-mode-off on shutdown.

---

## Error handling

| Failure | Behavior |
|---|---|
| Worker terminate hangs | 2s timeout per worker, abandon ref, spawn replacement anyway, log `⚠`. |
| Worker boot exceeds bootTimeoutMs | `broadcast({type:'error', message:'worker N boot timeout'})`. TUI `✗`. |
| `buildCss` throws | Catch + broadcast error. Prior good CSS still on disk (not overwritten on failure). Next save retries. |
| `buildIslands` throws | Same pattern as `buildCss`. Old island chunks still served. |
| WS broadcast — one client errored | Catch per-socket, drop from set, continue with others. |
| Port already in use | Rust bind fails; CLI exits 1 with `port N in use; pass --port`. |
| Watcher fd limit hit | Print hint about `ulimit -n`. Exit 1. |
| Non-TTY stdout | Plain logs. No ANSI. |
| `Ctrl-C` | Drain workers (2s grace), close WS, restore cursor, exit 0. |
| `process.stdout.on('resize')` | Re-clamp event log, full redraw. |
| Client connects before server is ready | Auto-reconnect with 1s backoff. |
| Server respawns workers while client connected | WS persists; client receives `reload` and refreshes. |

**Invariants:**
- Main process NEVER dies during dev (Ctrl-C is the only exit path apart from port-in-use / fd-limit init failures).
- Coordinator drops parallel builds — only one build at a time; subsequent changes coalesce.
- Old build artifacts on disk are not deleted on failure (last-good behavior).

---

## Backward compatibility

- `brust.run({ routes, entry })` without `dev: true` runs exactly as today.
- `brust build` is unaffected.
- Production bundles (those with `BRUST_PREBUILT=1` banner) never inject the dev client because `getDevClientSnippet()` only returns non-null when `process.env.BRUST_DEV === '1'`, and `BRUST_DEV` is set by `runtime/cli/dev.ts` only.
- The `package.json` script change is mechanical — the old `bun run example/hello-world/index.ts` still works directly if a user invokes it.

---

## Open question — dev-client JS asset serving

The dev client lives at `runtime/dev/client.js` (built artifact, ~2KB). Three ways to serve it:

1. **New Rust route `/_brust/dev/client.js`** mirroring `/_brust/css/` exactly. Static file, `Cache-Control: no-cache` (don't cache the dev client across server upgrades). Rust changes ~30 LOC.
2. **Reuse `/_brust/islands/` semantics** with a special `client.js` filename. Couples dev-client to islands lifecycle artificially. Rejected.
3. **Inline the dev client directly in the `<script>` tag** (no external fetch). Removes the new route + caching concern, but the snippet grows from ~80 bytes (`<script src="…">`) to ~2KB inline, pasted into every SSR response.

**Decision deferred to the implementation plan.** Plan picks option 1 (new Rust route) unless it discovers a simpler path during implementation. Spec commits to: in dev mode, the browser must load the dev client; in production mode, no dev client is loaded.

---

## Testing

### Unit (runtime/dev/)

- `watcher.test.ts`: debounce coalesces N rapid events into 1, ignore globs filter out, multi-file event payload is a union.
- `coordinator.test.ts`: state machine transitions, broadcast sequence per kind, error path doesn't reload, dirty-during-build flag.
- `inject.test.ts`: snippet null when `BRUST_DEV!=='1'`, valid `<script>` when set, splice via `injectDevClient` puts it before `</head>`.
- `tui.test.ts`: event log evicts oldest at capacity, status bar text per state, non-TTY fallback emits plain text only.
- `inject-dev-client.test.ts` (runtime/render/): splice position, idempotent identity when snippet empty, byte-exact output.

### Integration: `tests/cli-dev.test.ts`

Spawn `bun runtime/cli/index.ts dev <tmp>/index.ts --port N` against a tmp project. Open a WS client to `/_brust/dev`. Then:

1. **TS edit → reload**: write a new pages/Home.tsx, expect WS receives `{type:'building'}` then `{type:'reload'}` within 3s. Fetch `/`, assert response reflects the new file content.
2. **CSS edit → css-update, no reload**: write app.css change, expect `{type:'css-update', href:'/_brust/css/app.css?v=…'}`. Assert no `{type:'reload'}` was sent for this change.
3. **CSS syntax error → error broadcast**: write invalid CSS, expect `{type:'error', message:<Tailwind diagnostic>}`. Verify GET `/_brust/css/app.css` still returns the prior good content.
4. **Ctrl-C → exit 0 within 3s**: SIGINT the spawned process, expect clean exit and the port is immediately re-bindable.

### Real-browser smoke (Chrome MCP)

Mandatory before declaring done:

1. `brust dev example/hello-world/index.ts` running.
2. Open `http://127.0.0.1:3000/` in Chrome MCP. Verify dev client `<script>` present, WS connects.
3. Edit pages/HelloWorld.tsx h1 text. Verify TUI logs hotreload + duration. Verify browser auto-reloads with new text.
4. Edit app.css color. Verify TUI logs css update. Verify browser visual change WITHOUT page reload (use DOM snapshot to confirm).
5. Introduce CSS syntax error. Verify red overlay appears in browser; TUI logs `✗`.
6. Fix CSS. Verify overlay disappears; TUI logs `→ ok`.
7. Counter island clicks still work after each TSX edit (regression check).
8. `Ctrl-C`. Verify clean exit + cursor restored.

### Existing baselines

- Rust: 99 (no change).
- Runtime: 118 + ~14 new (`watcher` 4, `coordinator` 5, `inject` 2, `tui` 2, `inject-dev-client` 2 → ~129 actual; conservative estimate).
- Tests: 77 + 4 new (cli-dev cases) = 81.

---

## Documentation

- `architecture.md`:
  - Promote `brust dev` to Built; describe WS protocol, dev-client injection, watcher coverage, TUI fallback.
  - Mark `Designed, not built` line for `brust dev` as removed.
- `example/hello-world/README.md`: add a `bun runtime/cli/index.ts dev example/hello-world/index.ts` snippet for the dev flow.

---

## Risks & open questions

| Risk | Mitigation |
|---|---|
| Bun.Worker.terminate hangs on stuck worker | 2s per-worker timeout, abandon ref + spawn replacement, log `⚠`. |
| File watcher misses changes on macOS recursive fsevents | Bun's `fs.watch({recursive:true})` works on macOS. Linux inotify fd-limit handled by error path (with hint). |
| Worker respawn registers with Rust before old worker's slot is released | Coordinator awaits `Bun.Worker.terminate` Promise before spawning; Bun does the cleanup. |
| Tailwind v4 compile is slow on large apps | The progress bar in TUI; user can see something is happening. CSS hot-swap means no page reload during build. |
| Dev client `<script>` injected into prod bundle by mistake | `getDevClientSnippet()` reads `BRUST_DEV` env at request time, not at module init. Prod bundles run with `BRUST_PREBUILT=1` and never set `BRUST_DEV`. |
| Browser overlay covers important UI for hours during silent build hang | Overlay shows the WS-pushed error; if no error, no overlay. `Ctrl-C` + restart is the recovery path. |
| WS dev channel path collides with a user route | `/_brust/` prefix is reserved — same convention as `/_brust/islands/` and `/_brust/css/`. Users can't register routes under `/_brust/`. |

---

## Out of scope (explicit list)

- React Fast Refresh / module HMR.
- Rust file watching, cargo rebuild integration.
- Source maps.
- Multi-machine dev exposure (`--host 0.0.0.0`).
- Auto-open behavior beyond `--no-open`. (`open` package usage is optional.)
- Persistent dev session state across CLI invocations.
- File watching of dependency `node_modules` or `runtime/` (framework internals).
- Configurable watch globs per project.

---

## Acceptance criteria

1. `brust dev example/hello-world/index.ts` boots, prints `serving on http://127.0.0.1:3000`, opens the TUI.
2. WS connects from a browser to `/_brust/dev`; the dev client `<script>` is in the HTML.
3. Editing `example/hello-world/pages/HelloWorld.tsx` triggers `{type:'building'}` then `{type:'reload'}` within 3s. The browser auto-refreshes; the new h1 text is visible.
4. Editing `example/hello-world/app.css` triggers `{type:'css-update'}` with a `?v=…` query. The browser swaps the `<link>` href; no page reload happens.
5. Introducing a CSS syntax error triggers `{type:'error'}` with the Tailwind diagnostic. Red overlay appears in the browser. Fixing the error triggers `{type:'ok'}` and the overlay disappears.
6. `Ctrl-C` exits 0 within 3s; the port is immediately re-bindable; no orphan workers.
7. `brust build` and bare `brust.run()` (no `dev:true`) behave identically to today — no dev client injected, no watcher, no TUI.
8. Baselines: Rust 99 / Runtime ~129 / Integration 81 — all green.
