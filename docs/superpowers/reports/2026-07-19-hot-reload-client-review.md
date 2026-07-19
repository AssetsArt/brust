# Hot Reload Client Review

Task: `hot-reload-client-review`  
Reviewer: Armin  
Date: 2026-07-19  
Scope: browser dev client, dev WS protocol, injection parity, and test coverage. Investigation only; no production or test edits.

## Intent

The hot-reload client is trying to keep a dev browser connected to `/_brust/dev`, receive exactly one server-side decision per change, then either reload the document, hot-swap CSS, or show/clear an error overlay.

Simpler alternative check: the architecture is already the small version. A single inline script plus a Rust-owned WS control channel is simpler than worker-local relays or a served client asset. The smaller improvement is not a redesign; it is to close two missing protocol guarantees with focused tests: dev-client presence on error documents, and observable fresh content after reload.

## Confirmed Findings

### 1. React pre-shell error pages lose the dev client, so a fixed file may not auto-recover

Finding: `runtime/render/stream.ts:304-312` renders the `errorBoundary` HTML and sends it directly through `encodeFirstChunk` without `injectDevClient(...)`.

Why it matters: if a hot reload lands the browser on a React render error page, that document has no `/_brust/dev` client. After the developer fixes the file, the page cannot receive the next `building` / `reload` / `ok` frame; the user remains on the stale error page until a manual refresh.

Evidence:

- Normal buffered documents inject the dev client at `runtime/render/stream.ts:183-189`.
- React streaming documents prepend the dev tag at `runtime/render/stream.ts:251-272`.
- The pre-shell error path bypasses both and sends `encoder.encode(html)` directly at `runtime/render/stream.ts:304-312`.
- Existing test `runtime/render/stream.test.ts:84-105` only checks `500 + errorBoundary + final`; it does not assert the dev client survives.
- Deterministic probe run from repo root configured `configureDevClientSnippet('<script>devclient</script>')`, rendered a throwing component, and decoded the error response:

```text
"<html><head><title>err</title></head><body>boom</body></html>"
contains devclient false
```

Disproof attempt: React streaming and normal buffered paths were checked separately; the dev client was present there. The loss is isolated to `onShellError` and the plain-text fallback when the error boundary also throws.

Suggested change: in dev mode, run the error-boundary HTML through the same document injection stack used for successful buffered output: at minimum `injectDevClient(body, getDevClientSnippet())`, and likely generator/shell/action/store parity if those are expected on error documents. For the plain-text fallback, either accept manual recovery or return a minimal HTML error document in dev with the dev client injected.

Smallest regression-test seam: extend `runtime/render/stream.test.ts` pre-shell crash coverage to configure a dev snippet and assert the decoded 500 HTML contains it. Add a second test for `errorBoundary` throwing if the intended behavior is auto-recovery even from the fallback.

### 2. Current reload integration tests can pass without proving fresh user-visible content

Finding: `tests/dev-reload.test.ts:75-98` and `tests/dev-reload-option.test.ts:79-97` assert that a WS client receives `reload` and that `/ping` still works, but they do not fetch the changed page or inspect a browser after the reload. This falls short of the original acceptance test in `docs/superpowers/specs/2026-05-27-brust-dev-tooling-design.md:393-397`, which required fetching `/` and asserting the response reflects the new file content.

Why it matters: the class of failures now being investigated is "protocol receipt succeeded, but the page still shows stale content." These tests would pass if `reload` is delivered while jinja, island chunks, CSS, or worker state remain stale.

Evidence:

- `tests/dev-reload.test.ts:89-98` writes a probe file, awaits a `reload` frame, then checks only `/ping`.
- `tests/dev-reload-option.test.ts:93-97` follows the same pattern.
- Coordinator unit tests verify call order, including `reEmitJinja` before worker restart at `runtime/dev/coordinator.test.ts:61-91`, but do not prove the served route body changed after the reload.
- The design's integration section explicitly calls for "Fetch `/`, assert response reflects the new file content" at `docs/superpowers/specs/2026-05-27-brust-dev-tooling-design.md:395`.

Disproof attempt: I traced `runtime/index.ts:925-965` and `runtime/dev/coordinator.ts:49-69`; the intended pipeline does rebuild islands, re-emit jinja, restart workers, then broadcast reload. That makes the implementation plausible, but the tests still do not observe the final user-visible effect.

Suggested change: add deterministic fixture routes whose visible output changes when a watched source file changes. After receiving `reload`, fetch or browser-inspect the affected React, native jinja, and Markdown URLs and assert the new text/chunk is visible.

Smallest regression-test seam: update the existing dev reload integration pattern to edit a real route dependency rather than a throwaway unused file, then assert the route response includes a unique timestamp/string after the reload.

## Inferred Risks / Coverage Gaps

### 3. Reconnect has no catch-up handshake for missed one-shot frames

Finding: `runtime/dev/client.ts:9-13` reconnects one second after `onclose`, and `docs/superpowers/specs/2026-05-27-brust-dev-tooling-design.md:159` says initial connection sends nothing. If the browser is disconnected when `runtime/dev/coordinator.ts:69` sends the one-shot `reload`, reconnect succeeds but the stale page is not told to reload.

Why it matters: a network blip, laptop sleep, browser process pause, or transient WS close during a rebuild can leave the browser connected but stale. This is lower confidence because the current hot-reload worker restart is designed to preserve the Rust-owned WS connection; it is still a protocol hole when the socket itself is gone.

Suggested change: track a monotonic dev generation on the server and send the latest generation on WS open; the client reloads if its page generation is older. If that is too much surface for now, add a protocol-level test documenting that missed frames are not recovered and classify it as accepted behavior.

Smallest regression-test seam: fake a client that connects only after `Coordinator.handleChange()` completes and assert the chosen contract: either it receives a catch-up reload or it deliberately receives nothing.

### 4. `building` is intentionally ignored by the browser client

Finding: `runtime/dev/ws-channel.ts:5` includes `{ type: 'building' }`, and `runtime/dev/coordinator.ts:37` broadcasts it, but `runtime/dev/client.ts:15-21` has no `building` case. The design marks it optional at `docs/superpowers/specs/2026-05-27-brust-dev-tooling-design.md:185`.

Why it matters: this is not a correctness failure; it is only a UX blind spot. During slow Tailwind/native compiles, the browser has no in-page sign that the server is rebuilding. The TUI still reports progress.

Suggested change: leave as-is unless user feedback says in-page build progress matters. A minimal future test would assert that ignoring `building` does not clear an existing error overlay before an `ok` frame.

## Coverage Matrix

| Area | Current evidence | Missing seam |
|---|---|---|
| Initial dev WS route | `runtime/dev/ws-channel.test.ts:11-15`; `tests/dev-reload.test.ts:69-73` opens real WS | Browser page actually executes injected client and connects |
| Reconnect/backoff | `runtime/dev/client.ts:12` only by code inspection | Fake WS/browser test for close -> reconnect, plus missed-frame contract |
| `reload` after worker restart | `tests/dev-reload.test.ts:75-98` receives frame and server survives | Post-reload React/native/md page contains changed content |
| Programmatic `run({ dev: true })` | `tests/dev-reload-option.test.ts:52-98` receives frame and `/ping` survives | Same fresh-content assertion under option-only dev |
| CSS hot swap | `runtime/dev/coordinator.test.ts:94-106` checks message; `runtime/dev/client.ts:23-28` swaps matching links | Browser/protocol test that the link href changes and no document reload occurs |
| Component CSS | `runtime/dev/coordinator.test.ts:154-199` checks css-update vs reload decision | Browser-level test for content-only CSS update and exports-set reload |
| Error overlay | `runtime/dev/coordinator.test.ts:139-152` checks error frame; client code at `runtime/dev/client.ts:29-42` shows/hides overlay | Browser/client test that `error` displays and later `ok` removes it |
| React buffered injection | `runtime/render/stream.ts:183-189`; covered indirectly by render tests | Add explicit dev-client assertion if not already covered by live docs probe |
| React streaming injection | `runtime/render/stream.ts:251-272`; stream tests assert prepended metadata but not dev client | Add dev-client-specific streaming assertion |
| React error injection | Missing; `runtime/render/stream.ts:304-312` bypasses injection | Add failing pre-shell error test with dev snippet |
| Native jinja injection | `tests/dev-reload.test.ts:101-119` checks native HTML contains `/_brust/dev` | Add fresh native content after source edit |
| Markdown injection | `runtime/md/emit.ts:404-405` and design docs; no dev-reload integration assertion found | Add md content edit -> reload -> fresh rendered md |
| Duplicate clients on SPA navigation | SPA swaps `<main>` only, while injection lives in document head/body | Browser test: count open dev sockets before/after SPA nav |

## Gates Run

```text
bun test runtime/dev/*.test.ts runtime/render/inject-dev-client.test.ts runtime/render/stream.test.ts
77 pass, 0 fail

bun test tests/dev-reload.test.ts tests/dev-reload-option.test.ts
3 pass, 0 fail
```

Additional deterministic probe:

```text
React pre-shell error with dev snippet configured:
contains devclient false
```

## Verdict

Fix-then-ship for hot-reload reliability: React error documents can drop the dev client and strand the browser after a failed build; the existing integration tests do not assert fresh user-visible content after reload.
