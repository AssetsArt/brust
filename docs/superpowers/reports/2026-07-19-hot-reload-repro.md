# Hot reload deterministic reproduction audit

Date: 2026-07-19
Repository: `/Users/detoro/code/brust`
HEAD tested: `24bd9b28e458428988a0424107e04c4ff72e6a6b`
Scope: investigation only; no production or test changes were retained

## Environment

- macOS 26.5.1 (25F80), Darwin 25.5.0, arm64
- Bun `1.4.0-canary.1+f8723b190` (`bun --version` reports `1.4.0`)
- Fixture: a disposable same-depth copy of `tests/fixtures/app`
- Dev command, run from inside the disposable fixture:

  ```sh
  BRUST_NO_TUI=1 bun ../../../runtime/cli/index.ts dev index.ts --port 3867
  ```

- One `ws://127.0.0.1:3867/_brust/dev` connection remained open throughout each matrix run. Each trigger was followed through its terminal WebSocket message and then verified by fetching the affected page/CSS or inspecting the emitted island chunk. Distinct ports were used for fresh-process repeats.

## Executive result

Three reliable failures reproduced.

| Rank | Symptom | Rate | User-visible result |
| --- | --- | ---: | --- |
| 1 — critical | A syntax error during hot reload crashes Bun | 2/2 fresh processes | The WebSocket receives only `building`; Bun prints a segmentation fault, the server stops accepting connections, no `error` message reaches the browser, and a correcting edit cannot recover without restarting `brust dev`. |
| 2 — high | An island source edit reports success but leaves the emitted island chunk stale | 2/2 | The client receives `building → reload → ok`, but the rebuilt `Counter_*.js` does not contain the edited marker. Reloading the page therefore loads stale island code. |
| 3 — high | A second edit arriving during an in-flight rebuild is silently dropped | 5/5 | A TSX rebuild followed by `app.css` after the `building` message finishes with `reload → ok`, but served `app.css` lacks the second edit. A later standalone CSS touch makes the missing edit appear. |

No fix or root-cause ruling is proposed in this audit. The observations are consistent with the early return while `Coordinator` is already building, but server/client fail-path ownership is covered by the parallel trace tasks.

## Baseline gate

Exact command:

```sh
bun test tests/dev-reload.test.ts tests/dev-reload-option.test.ts
```

Observed on the tested HEAD:

```text
3 pass
0 fail
5 expect() calls
Ran 3 tests across 2 files. [9.33s]
```

The existing regression cases for a normal TS hot reload, native-page dev-client injection, and programmatic `run({ dev: true })` all passed. This audit therefore did not reproduce those previously fixed failures in the ordinary path.

## Reproduction matrix

| Axis | Trigger | Expected messages and proof | Actual result | Repeats | Rules in/out |
| --- | --- | --- | --- | ---: | --- |
| TSX page edit | Change the `<h1>` literal in `pages/HelloWorld.tsx` | `building → reload → ok`; fetched `/` contains marker | Passed; marker served, HTTP 200 | 1/1 | Ordinary page rebuild and worker replacement work. |
| Island edit | Change rendered text in `components/Counter.tsx` | `building → reload → ok`; emitted `Counter_*.js` contains marker | Messages claimed success, but emitted chunk lacked marker | 2/2 | Reliable stale-island defect; not an SSR-only assertion because the generated client chunk was inspected directly. |
| `app.css` | Append a unique rule | `building → css-update → ok`; `/_brust/css/app.css` contains marker | Passed | 1/1 | Standalone app-CSS rebuild works. |
| CSS module, unchanged exports | Change declarations under an existing `.probe` export | `building → css-update → ok`; message target contains exact custom-property marker | Passed | 2/2 | Same-export fast path works; the first exploratory assertion used normalized RGB text and was discarded, then exact markers passed twice. |
| CSS module, changed exports | Add `.addedAudit` | `building → reload → ok`; rebuilt component CSS contains new export | Passed | 1/1 | Export-set change selects full reload and emits fresh CSS. |
| HTML create/edit | Create and then edit `audit.html` | `building → reload → ok`; current page remains fetchable | Passed; server remained live | 1/1 each | Watcher/coordinator HTML path works. The fixture has no content-bearing `.html` import seam, so this proves event handling and survival, not rendered HTML freshness. |
| Markdown | Append marker to `content/docs/index.md` with fixture cwd so MD routes are active | `building → reload → ok`; fetched `/docs` contains marker | Passed, HTTP 200 | 1/1 | MD re-splice and worker restart serve fresh content. |
| File create | Create an unreferenced `.tsx` source | `building → reload → ok`; file exists and `/ping` is 200 | Passed | 1/1 | Recursive watcher sees creation and server survives. |
| File rename | Rename that `.tsx` source | `building → reload → ok`; old path absent, new path present, `/ping` 200 | Passed | 1/1 | Rename is observed and server survives. |
| File delete | Delete renamed `.tsx` source | `building → reload → ok`; file absent and `/ping` 200 | Passed | 1/1 | Delete is observed and server survives. |
| Two edits during rebuild | Edit page TSX; after its WS `building`, append unique `app.css` rule | The second edit must eventually be served | Only the TSX cycle appeared (`building → reload → ok`); CSS marker absent | 5/5 | Rules out debounce coalescing: second write occurs after `building`. Rules out CSS-builder failure: a later CSS-only touch recovered the missing marker 5/5. |
| Standalone recovery after dropped edit | Touch `app.css` again | `building → css-update → ok`; prior missing marker becomes served | Passed | 5/5 | Confirms the file contents were present on disk and only the in-flight event was lost. |
| Syntax/build failure | Append unequivocally invalid `export const auditBroken = @@@` to `routes.tsx` | `building → error`; process and old workers remain usable | Failed: only `building`, then Bun segmentation fault; HTTP refused | 2/2 fresh processes | Reliable crash; no browser overlay can appear because no `error` broadcast is delivered. |
| Correcting edit after failure | Restore valid `routes.tsx` while the same process should still run | New `building`, then `reload → ok`; HTTP recovers | Failed: process no longer served or watched the correction | 2/2 | Recovery requires a full dev-server restart. |

Every claimed defect has at least two matching runs. Timing-sensitive in-flight loss was repeated five times.

## Ranked reliable repros

### 1. Syntax error crashes the dev process

The two runs used ports 3869 and 3870 and fresh disposable fixtures. Both produced the same sequence:

1. WebSocket: `building` only.
2. Server log: `hotreload …/routes.tsx`, then `native templates — 0 compiled, 14 unchanged (skipped)`.
3. Bun crash report with `panic: Segmentation fault at address 0x30`.
4. `curl /ping` refused connections.
5. Restoring valid source did not produce another WebSocket cycle or recover HTTP.

The crash report's feature line included terminated and spawned workers (`workers_spawned(20)` and `workers_terminated(15)` or `(18)`). This is recorded as correlation, not a root-cause conclusion.

Runnable setup from repository root:

```sh
AUDIT_FIXTURE=tests/fixtures/hot-reload-report-repro
cp -R tests/fixtures/app "$AUDIT_FIXTURE"
cd "$AUDIT_FIXTURE"
BRUST_NO_TUI=1 bun ../../../runtime/cli/index.ts dev index.ts --port 3869
```

After the server is ready, keep a WebSocket observer open in another terminal:

```sh
bun -e 'const ws=new WebSocket("ws://127.0.0.1:3869/_brust/dev");ws.onmessage=e=>console.log(String(e.data));await new Promise(()=>{})'
```

Trigger from a third terminal at repository root:

```sh
printf '\nexport const auditBroken = @@@\n' >> tests/fixtures/hot-reload-report-repro/routes.tsx
sleep 3
curl -fsS http://127.0.0.1:3869/ping
```

Expected current result: observer prints only `{"type":"building"}`; the server terminal prints the Bun segmentation-fault report; `curl` fails. Because this is a disposable copy, remove it after stopping any surviving process.

### 2. Island edit emits a stale chunk despite `ok`

Use the same disposable-fixture setup with a fresh server. Connect the WebSocket observer, then edit the island source:

```sh
perl -0pi -e 's/\{label\}: \{n\}/\{label\}: \{n\} island-repro-marker/' \
  tests/fixtures/hot-reload-report-repro/components/Counter.tsx
```

After `building → reload → ok`, inspect the generated artifact:

```sh
rg -n 'island-repro-marker' \
  tests/fixtures/hot-reload-report-repro/.brust/islands/Counter_*.js
```

Expected current result: `rg` finds no marker. This occurred 2/2 times; the chunk filename remained `Counter_d3b36583.js` in both audit runs even though logs said `built 3 island chunk(s) + ai runtime` at boot and the hot-reload cycle returned `ok`.

### 3. In-flight CSS edit is dropped

Start a fresh disposable fixture on port 3867. From repository root, run this one-shot trigger; it edits TSX, waits until the server has entered the build, then appends CSS:

```sh
bun -e '
import {appendFileSync,readFileSync,writeFileSync} from "node:fs";
const page="tests/fixtures/hot-reload-report-repro/pages/HelloWorld.tsx";
const css="tests/fixtures/hot-reload-report-repro/app.css";
const marker="audit-inflight-repro";
const ws=new WebSocket("ws://127.0.0.1:3867/_brust/dev");
let injected=false;
ws.onopen=()=>writeFileSync(page,readFileSync(page,"utf8").replace("Hello from Brust","Hello from Brust repro"));
ws.onmessage=e=>{
  const msg=JSON.parse(String(e.data)); console.log(msg);
  if(msg.type==="building"&&!injected){injected=true;appendFileSync(css,`\n.${marker}{color:red}\n`)}
  if(msg.type==="ok") process.exit(0);
};
await new Promise(()=>{});
'
curl -fsS http://127.0.0.1:3867/_brust/css/app.css | rg 'audit-inflight-repro'
```

Expected current result: WebSocket prints `building`, `reload`, `ok`; the final `rg` has no match. Touching `app.css` once more causes `building → css-update → ok`, after which the same fetch contains the marker.

## Cases that did not reproduce

- No loss of `reload` occurred for an isolated TSX edit.
- No ordinary-edit server crash occurred for TSX, island, app CSS, CSS module, HTML, Markdown, create, rename, or delete triggers.
- No stale output occurred for page TSX, app CSS, either CSS-module branch, or Markdown.
- The existing programmatic `run({ dev: true })` regression remained green.
- The exploratory island assertion against SSR HTML was intentionally discarded because the client island text is not guaranteed to appear there; the final claim is based on inspecting the emitted island chunk.
- The exploratory CSS-module check against RGB formatting was intentionally discarded because Lightning CSS normalizes color syntax; exact custom-property markers passed in the final runs.

## Breadcrumb conclusion

The baseline tests cover a successful, isolated reload but not successful-message freshness, a second event while a build is active, or failure recovery. Those three uncovered paths respectively produced stale island code, a silently dropped CSS edit, and a fatal Bun crash.
