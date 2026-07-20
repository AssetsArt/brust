# Programmatic AI production build diagnosis

Date: 2026-07-20

Brust: `0.1.66-alpha` at `13df71e`

Bun: `1.4.0-canary.1+f8723b190`

Host: macOS 26.5.1, arm64

## Outcome

The failure is deterministic. A literal `brust.run({ ..., ai: true })` and an
unflagged `brustjs build` disagree about whether AI is enabled:

- the build phase only considers CLI `--ai` and build-process `BRUST_AI=1`;
- the bundled app later considers `opts.ai === true`, sets `BRUST_AI=1`, adds the
  AI routes, and injects the browser script tag.

Consequently the unflagged build skips `dist/islands/ai.js`, but the prebuilt
server advertises and requests it. The document contains
`<script type="module" src="/_brust/ai.js"></script>`, the manifest route is
live, `/_brust/ai.js` is 404, and `window.Brust` remains `undefined`.

The `--ai` control also exposed a separate native-template defect. It does not
activate `BRUST_DEV`, but it bakes the entire dev WebSocket client into every
native document because the native emitter uses one helper for both AI and dev
injection. React and Markdown documents do not have this leak. Production
semantics otherwise remain active: no dev WS route, production cache headers,
and production/minified React browser bundles.

## Reproduction fixture

The disposable fixture lived at `/tmp/brust-ai-optin-repro` and resolved
`brustjs` to this checkout. Its tracked-equivalent source was:

```ts
// index.ts
import { brust } from 'brustjs'
import { routes } from './routes'

await brust.run({ routes, entry: import.meta.url, ai: true })
```

```tsx
// routes.tsx — React-path primary reproduction
import { defineRoutes } from 'brustjs/routes'
import Home from './Home'

export const routes = defineRoutes([{ path: '/', Component: Home }] as const)
```

```tsx
// Home.tsx
export default function Home() {
  return (
    <html>
      <head><title>AI opt-in repro</title></head>
      <body><main>AI opt-in repro</main></body>
    </html>
  )
}
```

The lane needed a current ignored native addon before the server could boot:

```sh
cd /Users/detoro/code/brust/.claude/worktrees/ai-build-opt-in-investigation
bun run build:debug
```

The first attempt with the older addon stopped before the target path with
`napiLoadJinjaTemplates` undefined. Rebuilding eliminated that environment
artifact; every result below then repeated deterministically.

### Failing no-flag run

```sh
cd /tmp/brust-ai-optin-repro
bun /Users/detoro/code/brust/.claude/worktrees/ai-build-opt-in-investigation/runtime/cli/index.ts \
  build index.ts --out-dir dist
test -f dist/islands/ai.js; echo $?          # 1
head -c 220 dist/index.js                    # BRUST_PREBUILT + BRUST_DIST_DIR only

BRUST_PORT=19437 BRUST_WORKERS=1 bun run ./dist/index.js
curl -sS -D - http://127.0.0.1:19437/
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19437/_brust/ai.js
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19437/_brust/ai/manifest.json
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19437/_brust/dev
```

Browser evaluation after the document settled:

```js
({ brustType: typeof window.Brust, scripts: [...document.scripts].map(s => s.src) })
// { brustType: "undefined",
//   scripts: ["http://127.0.0.1:19437/_brust/ai.js"] }
```

### Passing `--ai` control

```sh
cd /tmp/brust-ai-optin-repro
bun /Users/detoro/code/brust/.claude/worktrees/ai-build-opt-in-investigation/runtime/cli/index.ts \
  build index.ts --out-dir dist-ai --ai
test -f dist-ai/islands/ai.js; echo $?       # 0
head -c 260 dist-ai/index.js                 # also: process.env.BRUST_AI ??= '1'

BRUST_PORT=19438 BRUST_WORKERS=1 bun run ./dist-ai/index.js
curl -sS -D - http://127.0.0.1:19438/
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19438/_brust/ai.js
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19438/_brust/ai/manifest.json
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19438/_brust/dev
curl -sS -D - -o /dev/null http://127.0.0.1:19438/_brust/islands/_react.js
```

Browser evaluation returned `typeof window.Brust === "object"`, with the sole
document script equal to `/_brust/ai.js`.

### Native `--ai` dev-client leakage

Change the one route to
`{ path: '/', Component: Home, native: true }`, build with `--ai`, and boot it:

```sh
bun /Users/detoro/code/brust/.claude/worktrees/ai-build-opt-in-investigation/runtime/cli/index.ts \
  build index.ts --out-dir dist-ai-native --ai
BRUST_PORT=19439 BRUST_WORKERS=1 bun run ./dist-ai-native/index.js
curl -sS http://127.0.0.1:19439/ > /tmp/ai-native-root.html
rg -o 'new WebSocket|__brust_dev_overlay|/_brust/ai.js' /tmp/ai-native-root.html
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19439/_brust/dev
curl -sS -D - -o /dev/null http://127.0.0.1:19439/_brust/islands/_react.js
```

The HTML contains the AI tag plus the inline dev client, including
`new WebSocket(... '/_brust/dev')` and `__brust_dev_overlay`; the route is 404.

## Breadcrumb ledger

| Run | Changed axis | Observed | Rules in/out |
| --- | --- | --- | --- |
| Unflagged build, literal `ai: true` | Baseline | Build log says `islands: skipped`; `dist/islands/ai.js` absent; banner has no `BRUST_AI` | Build phase did not consume the programmatic opt-in |
| Unflagged prebuilt boot | Boot the same output | HTML has AI tag; manifest 200; AI JS 404; dev route 404; `window.Brust` undefined | Runtime did consume `opts.ai`; failure is missing producer output, not missing runtime intent |
| `--ai` build | Add only CLI flag | `ai.js` exists; banner sets only `BRUST_AI`; AI JS and manifest both 200 | AI producer and server consumer agree when the build-phase knob is present |
| `--ai` React page | Same control at runtime | Sole page script is AI; no dev-client markers; `window.Brust` object | `--ai` does not globally turn React rendering into dev mode |
| `--ai` asset headers | Inspect static React chunks | `Cache-Control: public, max-age=3600`, not `no-store` | Native server dev mode was not configured |
| `--ai` React bundle | Inspect `_react-dom.js` and builder | Minified production error indicator; builder defines `process.env.NODE_ENV` as `"production"` | Browser React is production mode |
| Native route + `--ai` | Change only route renderer | HTML contains AI tag and inline `/_brust/dev` reconnect/overlay client; WS route stays 404 | Dev-client code leaks at native template emission; `BRUST_DEV` itself is still off |

## Fail path

1. `parseArgs` initializes `ai` to false and can make it true only from `--ai`
   (`runtime/cli/build.ts:155-188`).
2. `runBuild` computes its single build-phase decision as
   `parsed.ai || process.env.BRUST_AI === '1'`
   (`runtime/cli/build.ts:245-255`). It never reads or extracts the entry's
   `brust.run` options.
3. That false value reaches every build-time producer:
   - Markdown template AI injection receives `aiEnabled: false`
     (`runtime/cli/build.ts:384-398`, `runtime/md/emit.ts:405-406`).
   - the islands build is skipped when the app has no islands
     (`runtime/cli/build.ts:403-440`), so `buildAiRuntime` never emits `ai.js`;
   - native template emission sees neither `BRUST_AI` nor `BRUST_DEV`, so it
     bakes no AI tag (`runtime/cli/native-routes-emit.ts:1005-1008`);
   - the server bundle banner omits `BRUST_AI`
     (`runtime/cli/build.ts:237-242,571-598`).
4. The route manifest is nevertheless emitted unconditionally
   (`runtime/cli/build.ts:350-359`), which is why the later manifest route can
   succeed despite the missing runtime chunk.
5. At boot the bundled literal survives. `brust.run` independently computes
   `dev || opts.ai === true || BRUST_AI`, then sets `BRUST_AI=1`, adds both AI
   routes, and points the runtime route at `<dist>/islands/ai.js`
   (`runtime/index.ts:510-537`).
6. React streaming reads that newly set environment value and injects the AI
   tag (`runtime/render/stream.ts:202,265`). Nothing at boot emits the missing
   browser artifact, because prebuilt mode only consumes build outputs.
7. Native and Markdown documents are compiled ahead of boot, so runtime
   `opts.ai` cannot repair their missing build-time tags either.

### `--ai` versus dev mode

`--ai` sets `BRUST_AI`, not `BRUST_DEV`, in the bundle banner. At runtime
`dev` is computed separately, and only true `dev` adds the WS route/dev snippet
and calls `configureDevMode(true)` (`runtime/index.ts:515-548,853-870`). The
control showed all those dev-mode indicators absent.

The native emitter violates the AI-only contract at a narrower seam:
`BRUST_AI=1` makes it call `injectDevClientIntoTemplate`, but that helper first
inserts `buildDevClientTag()` unconditionally and only then inserts the AI tag
(`runtime/cli/native-routes-emit.ts:267-287,1005-1008`). Thus `--ai` leaks dev
instrumentation into native HTML without enabling the watcher, dev route,
no-store caching, or development React. The browser consequently attempts a
pointless reconnect loop to a 404 `/_brust/dev` endpoint.

Markdown does not share this defect: `withDevClient` and `aiEnabled` select
separate injectors (`runtime/md/emit.ts:405-406`). React also uses separate
runtime injectors.

## Ranked hypotheses and disproofs

1. **Confirmed: build-time AI enablement ignores programmatic `ai: true`.**
   The exact decision has only the CLI/env inputs, while runtime has the extra
   `opts.ai` input. The no-flag versus `--ai` differential changes only that
   build-phase input and flips chunk emission.
2. **Disproved: Bun minification/tree shaking removes the literal option.**
   The unflagged prebuilt boot adds the AI routes and injects the AI tag, which
   can happen only after `opts.ai === true` survives into `brust.run`.
3. **Disproved: the browser chunk is emitted but served from the wrong path.**
   The file is absent and the build log explicitly says the islands build was
   skipped. With `--ai`, the same expected path exists and returns 200.
4. **Disproved as the primary cause: document injection is universally
   missing.** The React document contains the correct tag in the failing run.
   Native and Markdown have a related build-time omission, but even perfect
   injection cannot make an absent `ai.js` execute.
5. **Disproved as global state, refined to a second defect: `--ai` enables dev
   mode.** No `BRUST_DEV` banner assignment, dev WS route, dev cache policy, or
   development React bundle is present. Only native HTML leaks the dev client
   because its combined injection helper is called for `BRUST_AI` too.

Every observation in the breadcrumb table is explained by the two confirmed
causes; none requires a nondeterministic or platform-specific condition.

## Producer/consumer seams

| Seam | Producer decision | Consumer | Failure |
| --- | --- | --- | --- |
| AI browser chunk | `runBuild.aiEnabled` gates `buildIslands`; `buildIslands` gates `buildAiRuntime` | `/_brust/ai.js` reads `<dist>/islands/ai.js` | Runtime `opts.ai` enables the consumer after the producer was skipped |
| AI manifest | Build emits it unconditionally | `/_brust/ai/manifest.json` route enabled by runtime `opts.ai` | Works, masking the split decision because one AI artifact exists |
| React document tag | Runtime `BRUST_AI` controls stream injection | Browser module loader | Tag is correct but targets missing chunk |
| Native document tag | Build-process `BRUST_AI` controls template bake | Rust Jinja renderer/browser | Programmatic opt-in arrives too late; `--ai` additionally bakes dev client |
| Markdown document tag | Build `aiEnabled` controls template bake | Rust Jinja renderer/browser | Programmatic opt-in arrives too late; AI/dev injectors themselves are separate |
| Bundle banner | Build `aiEnabled` controls persisted `BRUST_AI` | Prebuilt main process and workers | No-flag programmatic build persists no build decision |
| Dev semantics | Runtime `dev` controls WS route, watcher, snippet, `configureDevMode` | Browser client/static cache | Correctly remains off under `--ai`; only native helper leaks client JS |
| React browser mode | `buildOne` defines `NODE_ENV="production"` and minifies | Import-map React chunks | Correctly remains production under `--ai` |

## Recommended minimal regression boundary

The primary regression must be tested at the real build boundary, not with
another `parseArgs` or `buildBanner` unit test; those units are exactly where
the missing input is invisible.

Use one temporary no-islands fixture whose entry contains literal
`brust.run({ routes, entry: import.meta.url, ai: true })`, invoke the real CLI
without `--ai`, and assert:

1. `<dist>/islands/ai.js` exists;
2. the prebuilt root document contains the AI tag;
3. `/_brust/ai.js` and `/_brust/ai/manifest.json` both return 200;
4. a browser evaluation observes `typeof window.Brust === "object"`.

Run the same harness with programmatic AI absent to assert no `ai.js`, no AI
tag/routes, and therefore zero browser-runtime cost. Keep the existing `--ai`
and `BRUST_AI=1` cases as passing compatibility controls.

Add one focused native-emitter regression beside
`runtime/cli/native-routes-emit.test.ts`: with AI enabled and dev disabled, a
full-document template must contain `aiScriptTag()` and must not contain
`buildDevClientTag()` or `/_brust/dev`. The existing Markdown AI test already
guards the correctly separated behavior and is a useful parity assertion.

## Scope and cleanup

No production or test source was changed. The only retained repository change
for this task is this report. The reproduction app and captured responses are
under `/tmp`; lane-local `node_modules` and the native addon are ignored build
artifacts used only to run the current checkout.
