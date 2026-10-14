# Island hydration timing — when the React floor loads and hydrates (draft for the lead's ruling)

owner: 22499151-e133-4508-b358-d7fa4d2851c3 (Detoro) · authority: in-loop · author: Guetta · implementer: Guetta (proposed, lane `hydration-timing`, only after a ruling) · reviewer: Afrojack (runtime) + Mellow (only if option C is chosen: replay re-runs request-derived handlers) · gates: Illenium · flow: lane → PR → CI → lead merges · ledger rows: next free F183 (the lead renumbers) · governed by `docs/plans/2026-10-14-react-parity-north-star.md` (R34.3, "same behaviour as React")

Status: **DRAFT, measurement spike only. No compiler, runtime or server code was changed.** Base: origin/main a774f278 (after #234). R-numbers are proposals (R42.1–R42.8); the lead renumbers. Every number below comes from a real `brust build` + `brust start` of the shadcn fixture pages `accordion`, `select` and `chart`, driven by Chromium; the harness is in the session scratchpad (§9), not in the repo.

## 0. Short answer

1. **Today the island's `hydrate()` call waits for an idle period (≤250 ms), but the React floor itself is loaded eagerly**: the page's React chunk is a `<script type="module">` at the end of `<body>`, so the browser fetches and evaluates the floor chunk (90 KB gzip on `accordion`, 114 KB on `select`, 237 KB on `chart`) at page load. `requestIdleCallback` defers only the `hydrateRoot` call.
2. **Deferring the load (idle, visible, interaction) buys nothing we could measure on the main thread or on first paint.** On `accordion` and `select` at 4× CPU throttle and slow-4G, total blocking time is 0 ms, FCP is 332–344 ms for eager and every deferred variant, and hydration costs 70–140 ms of script. Only `chart` (828 KB raw) shows main-thread cost: TBT 129–133 ms with eager loading.
3. **What deferral does cost is time-to-interactive and fidelity.** The page answers a first click at FCP only after hydration: eager ≈ 860 ms (accordion) / 985 ms (select), idle ≈ 1170–1390 ms, interaction-triggered ≈ 1200–1960 ms (the floor is downloaded after the click). In every variant **a click that lands before `hydrateRoot` is lost** — including today's eager design, where the window is ≈ 480 ms (click at 380 ms, hydrated at 862 ms) on slow-4G.
4. **A replay buffer fixes the lost click but is not free of fidelity risk.** A synthetic re-dispatch recovered every lost click in the experiment, and it double-applies native default actions: a replayed click on a checkbox toggles it back, and a replayed click on a submit button submits the form twice (§4.3, measured in Chromium). React's own replay avoids this by feeding the *original* event to its handlers only (react-dom 19.3.0, `dispatchEvent`, lines 26140–26215); we cannot reuse that path for events that happened before `hydrateRoot` exists.
5. **A page whose island SSRs nothing visible cannot be deferred at all.** `chart` paints no content at server time (the SSR output is a `<style>` block), so its FCP *is* its hydration (1.8 s eager); a deferred variant leaves the page blank longer.
6. **Recommendation:** keep eager as the default (reject deferral by default), and spend the effort where the bytes are: the compile-to-static lanes remove the floor from whole pages (pagination 87 → 0 KB). Of this plan's options, do **A** (re-measure a `modulepreload` for the react chunk and the shared chunk it imports; a first crude try gained ≈ 50 ms of hydration time and cost ≈ 85 ms of FCP, so it is not yet a win) and write the pre-hydration-event test that pins today's behaviour. Decide **C** (opt-in per-island strategy) only after a replay spike (Q4). Do not build **B**.

## 1. Where it stands (confirmed from the code)

| Fact | Source |
|---|---|
| An island is `<brust-island data-id x-props>SSR HTML</brust-island>`; its chunk registers `[id, hydrate]` on `globalThis.__brustIslands`; the runtime drains the queue and hydrates each host once. | `packages/runtime-dom/src/island.ts` lines 1–30 |
| `hydrate` runs inside `requestIdleCallback(cb, { timeout: IDLE_TIMEOUT_MS })` with `IDLE_TIMEOUT_MS = 250`; fallback `setTimeout(cb, 1)`. Nothing else is scheduled: no `load`/`visible`/`interaction` strategy exists, and the plan that introduced the runtime ruled "one strategy only: idle, no per-component override (M3)". | `island.ts` lines 36–45, 63–70; `docs/plans/2026-10-09-m2-island-hydration.md` (Global Constraints) |
| The server appends `<script type="module" src=…>` for the runtime, each needed feature, each native chunk, then each React chunk, **before `</body>`**. | `crates/brust-core/src/render.rs` `inject_document_assets_into`, lines 436–525 |
| `<link rel="modulepreload">` is emitted for the runtime and the feature modules (L33, R35.2), **not** for the React chunks or the shared chunk they import. The browser discovers the floor only after it has fetched and parsed `react-<id>.js` (a two-step waterfall: 150 ms RTT each on slow-4G). | `render.rs` lines 526–543 |
| The island shim calls `hydrateRoot(host, element, { identifierPrefix })` synchronously inside `hydrate`; React attaches its root listeners in that call. | `packages/brust/src/build/bundle.ts` line 505 |

Scoreboard reading (`docs/shadcn-coverage.json`, main before #234; 64 pages): **41 pages ship the React floor** and 22 ship 0 KB. Over those 41: smallest 70 KB, median 97 KB, largest 240 KB gzip, **4 187 KB in total**. 37 of them have exactly one island, 4 have two. So the floor is a once-per-page cost, which is what makes a per-page load strategy attractive to think about and what makes it cheap to measure.

## 2. What was measured

Setup (all pages built with the real `brust build`, served by the real `brust start`, one worker, loopback):

| Item | Value |
|---|---|
| Browser | Playwright Chromium headless shell 1248, macOS arm64 (Apple M1 Pro), one fresh browser context per run |
| Throttling | CPU 4× (`Emulation.setCPUThrottlingRate`); network "slow 4G" = 150 ms RTT, 1.6 Mbit/s down, 750 kbit/s up (`Network.emulateNetworkConditions`); caches off (new context) |
| Runs | n = 3 per cell, median reported; run-to-run spread ≈ ±40 ms on hydrated-at |
| Variants | rewrites **only the served HTML**; runtime and chunks are byte-identical to what the server sends. `eager` = as served. `preload` = adds `<link rel=modulepreload>` for `react-<id>.js` and the shared chunk. `idle` = drops the React tag, imports it in `requestIdleCallback(…, {timeout: 2000})`. `visible` = `IntersectionObserver` on the island. `interaction` = first `pointerdown`/`keydown`/`touchstart`/`focusin`. `interaction-replay` = same, then re-dispatches `pointerdown, mousedown, pointerup, mouseup, click` on the original target once the island carries `data-hydrated`. |
| Metrics | FCP (paint timing), "hydrated at" = first `brust-island[data-hydrated="1"]`, long tasks → TBT (sum of `duration − 50`), CDP `ScriptDuration` and `TaskDuration`, JS bytes on the wire (raw), and whether the trigger responded to a click |

Client JS of the three pages (raw / gzip of the shared chunk that carries react + react-dom + the Radix tree): `accordion` 278 KB / **90 KB**, `select` 345 KB / **114 KB**, `chart` 828 KB / **237 KB**.

### 2.1 Load strategy vs first paint, blocking time and time-to-hydrated (click not involved)

`late` = a click 500 ms after `load` (so the table's "hydrated at" is the island's own readiness; ms).

| Page | Variant | FCP | hydrated at | TBT | ScriptDuration | TaskDuration |
|---|---|---|---|---|---|---|
| accordion | eager | 344 | 852 | 0 | 87 | 271 |
| accordion | preload | 436 | 802 | 0 | 87 | 267 |
| accordion | idle | 336 | 1392 | 0 | 74 | 212 |
| accordion | visible | 344 | 1396 | 0 | 76 | 219 |
| accordion | interaction (click at ~910) | 340 | 1956 | 0 | 75 | 211 |
| select | eager | 356 | 977 | 0 | 125 | 316 |
| select | preload | 420 | 920 | 0 | 116 | 284 |
| select | idle | 332 | 1288 | 0 | 85 | 217 |
| select | interaction (click at ~920) | 344 | 1876 | 0 | 97 | 248 |
| chart | eager | 1796 | 1665 | **133** | 340 | 612 |
| chart | preload | 1740 | 1611 | **129** | 352 | 626 |
| chart | interaction (click at ~900) | not painted | 2538 | 47 | 110 | 276 |

Reading:
- **FCP does not move** for `idle`/`visible`/`interaction` on the two pages that SSR their content (332–344 vs 344/356 ms). Module scripts do not block first paint here; deferring them does not help it.
- **TBT is 0 ms** on `accordion` and `select` with every strategy, at 4× CPU. Hydration is 70–140 ms of script and it is not a long task.
- **`chart` is the only page with main-thread cost**: 133 ms TBT, 340 ms of script with eager loading. Its FCP is 1.8 s, equal to hydration, because its server HTML paints no content (the island SSRs a `<style>` block only; `curl` of the page, confirmed). Deferring it makes the page *blank* until the island is touched (the `interaction` row has no FCP at all).
- **`preload` improves hydrated-at by 50–57 ms and costs ≈ 85 ms of FCP** in this crude form (the links sit at the top of the fragment, ahead of the stylesheet, so they compete with the CSS for the 1.6 Mbit/s). It is a lead, not a result: the real insertion point is after the CSS links (as L33 does for the runtime), and it needs a re-measure on a real document with a `<head>` (§7 Q2).
- Inferred from click timestamps (not separately instrumented): in the eager design `DOMContentLoaded` arrives only after the end-of-body module scripts have run (≈ 900 ms), while with the floor deferred it arrives at ≈ 360 ms. Anything keyed on `DOMContentLoaded` or `load` waits for the floor today.

### 2.2 The dead window: a click before `hydrateRoot` runs

A synthetic user click on the second accordion trigger (or the select trigger) is dispatched 30 ms after FCP. Cell = does the control respond; the number is the median "hydrated at" (ms), the click lands at ≈ 380.

| Page | eager | preload | idle | interaction-replay |
|---|---|---|---|---|
| accordion | **lost** (hydrated 863) | **lost** (806) | **lost** (1172) | **responds** (1206) |
| select | **lost** (985) | **lost** (948) | **lost** (1312) | **responds** (1352) |

(`interaction` without replay is lost in every run; not repeated in the table.)

- **The status quo already loses a click made between first paint and `hydrateRoot`**: ≈ 480 ms on accordion and ≈ 600 ms on select over slow-4G with 4× CPU; with no throttling at all it is ≈ 20 ms (FCP 24 ms, hydrated 42 ms; a separate smoke run). This is the same behaviour a React SSR page has: React attaches no listeners before `hydrateRoot`, so the event is lost there too. It is therefore **not an R34.3 violation to keep it**, and it also means the gate "do not change behaviour" does not require a fix.
- Every deferral strategy **widens** the window by the deferral itself: idle +300–530 ms, visible +540 ms, interaction = the whole download.
- Response latency of the interaction-replay variant (replayed click → responds): click at 380 ms, island hydrated at 1206 ms, so **≈ 830 ms** after the click on accordion and ≈ 970 ms on select.

## 3. What React itself does (confirmed, react-dom 19.3.0)

`react-dom-client.development.js` lines 26140–26215 and 31012: when an event reaches a React root listener and its target is still *blocked* (a dehydrated Suspense boundary or a dehydrated root), React keeps the **original native event**, raises the hydration priority of the blocked target, and after hydration calls `dispatchEventForPluginEventSystem(domEventName, …, nativeEvent, …)` — that runs React's own handlers, **not** a new DOM dispatch, so the browser's default action (toggling the checkbox, submitting the form, following the link) is not repeated. The replayable set is `discreteReplayableEvents` (`mousedown mouseup touchend touchstart auxclick dblclick pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset …`); continuous events (`mouseover`, `focusin`, `pointermove`, …) keep the *latest* one only.

Two consequences:
1. **Events before `hydrateRoot` are not covered by React's replay.** Its listeners do not exist yet. React's guarantee starts when `hydrateRoot` has been called (the dehydrated-root case at line 26172) and ends when hydration completes — a window of a few frames for a non-Suspense island. A brust page matches the React page that way.
2. **Any brust-side replay is a new mechanism**, not "same as React"; whether it is *better* than React is a product decision (Q3), and it can only be *safe* if it replays at handler level or re-runs only handlers that are known idempotent (§4.3).

## 4. Options

### 4.1 Option A — keep the eager load, make it faster and pin the behaviour (recommended now)

- Re-measure the `preload` idea properly (links after the CSS, a real document with a `<head>`, three throttle profiles). Ship it only if hydrated-at improves and FCP does not regress: R42.1.
- Add a Chromium test that pins the pre-hydration behaviour so a later change cannot silently widen it: "a click before `data-hydrated` is dropped and the next click works; `data-hydrated` appears within N ms of load on an unthrottled run". R42.2.
- Document the dead window in the docs site as known and equal to a React SSR page. R42.3.
- Cost: small. Risk: none for behaviour (no change to when `hydrateRoot` runs).

### 4.2 Option B — defer the load by default (idle or visible) — **not recommended**

Measured: FCP and TBT unchanged, hydrated-at +310–540 ms, dead window ×2–×3, no bytes saved (the idle variant downloads the same 283 KB). The only gain would be bandwidth contention with a late LCP resource on a very slow link, which this fixture (CSS only, no images) cannot show. Not built, not measured further; it widens the lost-click window for every page to buy a gain nobody has demonstrated.

### 4.3 Option C — opt-in per-island strategy (`hydrate: 'visible' | 'interaction'`), with replay — **decide after a spike**

The only strategy that saves *bytes* on a page the user never touches is `interaction` (or `visible` for below-the-fold islands): the floor is never downloaded. It is where a 90–237 KB saving sits for a read-only page that carries one idle accordion or a chart nobody scrolls to. The price is what §2.2 measured (first interaction answers ≈ 830–970 ms late on slow-4G) plus replay, and replay has hazards:

| Hazard | Evidence |
|---|---|
| A re-dispatched `click` re-runs native activation behaviour: a checkbox toggles back, a submit button submits twice. | measured in Chromium: `{"checkbox":{"afterRealClick":true,"afterReplay":false},"formSubmit":{"afterReal":1,"afterReplay":2}}` |
| A link click navigates natively on the first dispatch; a replay would navigate twice or fight the first navigation. | inferred from the same mechanism, not separately measured |
| Text typed into an input before hydration: React's behaviour for a controlled input hydrated with a typed value is not characterised here. | **not measured** |
| Hover/focus state (continuous events) is dropped by a click-only replay; React keeps only the latest one. | inferred |
| `pointerdown`-driven Radix controls (select, menus) need the whole `pointerdown…click` sequence; the replayed sequence worked for `select` here (3/3), but it is a synthetic sequence with `isTrusted: false`. | measured (select, 3/3), generalisation not claimed |

Mitigations a spike would test: (1) replay only at React-handler level by loading the chunk on the first event, calling `hydrateRoot`, and feeding the *stored original event* to the root's listener the way React does for a dehydrated root (does the root container accept a re-dispatched original event without re-running activation behaviour? unknown); (2) capture-and-restrict: replay only events whose default action the browser does not perform (`pointerdown`, `keydown`, custom) and refuse to defer islands that contain native form controls or links; (3) load on `pointerover`/`touchstart`/`focusin` as an early hint (hover precedes click by 100–300 ms on desktop) so the window shrinks without replay.

Rules it would need (proposed): R42.4 a deferred island must have non-empty SSR content (the `chart` case, §2.1); R42.5 no strategy may be the default; R42.6 the replay set is an explicit allow-list, never "all events"; R42.7 a deferred island carries a build-time warning when it contains a native form control or a link; R42.8 every strategy has a Chromium test for the event sequence that matters (click, keyboard, touch).

### 4.4 Out of scope (named so they are not mistaken for options)

- **Reducing the floor** (React's 70 KB + Radix) is the compile-to-static work already in flight; it removes JS and also removes the dead window, because a static page has nothing to hydrate. It is strictly better than any timing change and does not need this plan.
- **Selective hydration through `<Suspense>`** (React's own mechanism for hydrate-on-interaction with replay) needs the server to emit the Suspense markers around each island and the shim to hydrate under a boundary. It would give React-grade replay (§3) but changes the SSR output of every island; not investigated here beyond reading react-dom. Listed as the principled form of Option C (Q5).

## 5. Rules (proposals; the lead renumbers)

- **R42.1** A change to when or how the floor loads ships only with the §2 harness numbers on the three pages (accordion, select, chart) and three throttle profiles; "hydrated at" must not get worse, FCP must not get worse beyond run-to-run noise.
- **R42.2** The Chromium behaviour test for events before hydration (Option A) is part of every PR that touches `island.ts` scheduling.
- **R42.3** The docs state the dead window and that it equals a React SSR page.
- **R42.4–R42.8** only if Option C is chosen (§4.3).
- **The gate** (R34.3): a byte or timing win that changes behaviour is not accepted. Concretely, for a strategy to merge: every control that works after eager hydration works after the deferred one with the same state and the same number of effects per user action.

## 6. Test plan for the lane that follows (proposal)

1. `tests/server/island-events.chromium.test.ts` (Option A): serves the accordion fixture, throttled; asserts the dead-window behaviour above (a click at FCP + 30 ms is dropped; the next click after `data-hydrated` works) and the unthrottled window ≤ 200 ms.
2. If C: one test per strategy for click, keyboard (Enter/Space on the trigger), touch, and a native control (checkbox/form) proving **zero double activation**.
3. The harness becomes `scripts/hydration-bench.ts` (kept out of CI, run by hand like the load tests), so R42.1 is checkable by the reviewer.

## 7. Questions for the lead

- **Q1 Default.** Keep eager as the default and reject Option B? Recommended: yes.
- **Q2 Preload.** Is a small lane for `modulepreload` of the React chunks worth it, given the first crude try (hydrated −50 ms, FCP +85 ms) is not yet a win? Recommended: yes, as a measure-first lane that ships nothing unless R42.1 passes.
- **Q3 Is the dead window a bug?** It equals a React SSR page today. Do we want to be *better* than React here (replay), or equal? Recommended: equal, documented (R42.3), until a user reports it.
- **Q4 Replay spike.** If we ever do C: may I run a spike that tests React-level replay of a stored original event (§4.3 mitigation 1) before any design is committed? Recommended: only after Q1–Q3, no rush.
- **Q5 Suspense form.** Should the principled form of C (island under `<Suspense>` for React-native selective hydration) be investigated instead of a brust-side replay? It changes every island's SSR output, so it is the larger decision. Recommended: write it down, do not start.
- **Q6 Per-island API.** The M2 plan ruled "no per-component override (M3)". If C goes ahead, is the surface a prop on `<Island>`, a `brust.toml` rule, or a comment directive? Recommended: decide with C, not now.
- **Q7 Real-device numbers.** These are emulated (CPU throttle + network profile on an M1 Pro). Is a real low-end-device pass available/needed before a ruling that rests on "TBT 0"? Recommended: not needed for Q1–Q3, needed for C.
- **Q8 Ledger.** Open a ledger row for the dead window (documented, not fixed) and one for the `chart`-style "empty SSR island" (cannot be deferred)? Numbers renumbered by the lead.

## 8. Confirmed, inferred, not measured

**Confirmed (measured or read from code):** everything in §1 and §3; the cells of §2.1 and §2.2 (n = 3, one host, emulated); the `chart` SSR output has no visible content; the double-activation result in §4.3 (checkbox and submit); a replayed `pointerdown…click` sequence opened the select 3/3.

**Inferred:** that `DOMContentLoaded` waits for the end-of-body module scripts (from click timestamps, not a dedicated trace); the link/navigation double-effect; that hover/focus state is lost by a click-only replay; the bandwidth-contention benefit of deferral on a late LCP resource.

**Not measured:** LCP and INP on a page with images; post-hydration interaction latency (identical across variants by construction, since hydration has finished); real-device and real-network numbers; the SPA-navigation path (`mount()` after `applyStoreSnapshot` schedules islands the same way, not exercised); pages with two islands (4 of 41); typed-text preservation across hydration; memory; Safari/Firefox (Chromium only; `requestIdleCallback` is absent in Safari and the runtime falls back to `setTimeout(1)`).

## 9. Reproduction

Probes live in the session scratchpad of the author (not committed): `hyd-measure.ts` (one cell: `bun hyd-measure.ts <variant> <cpuRate> <runs>`, with `NET=slow4g`, `CLICK=late|early|fcp`, `PAGE`, `PORT`, `TRIG`, `IDX`, `SHARED`), `matrix.sh`/`matrix2.sh` (the tables above), `replay-hazard.ts` (§4.3). Pages were built with the lane-built napi addon of `spread-fed-analysis` (the fixture's `brust build` of a one-route entry per page) and served with `brust start --dist-dir`; no tree file was modified beyond git-ignored `.rows/`. If the lead rules for a lane, the harness moves to `scripts/hydration-bench.ts` (§6.3) with the numbers re-run on the lane's head.

## 10. Lead ruling (2026-10-15)

owner: Detoro · authority: in-loop. R-numbers R42.1–R42.3 are confirmed. Task `hydration-preload`.

- **Q1: eager stays the default. Option B is rejected.** It made no measurable difference to FCP or TBT, it widened the window where clicks are lost, and it saved no bytes.
- **Q2: yes, a measure-first lane, `hydration-preload` (Guetta).** It contains R42.1 (modulepreload, which ships only if hydrated-at improves with no FCP regression on all three throttle profiles; otherwise the lane ships only the test and the doc), R42.2 (the Chromium pin of pre-hydration behaviour) and R42.3 (the docs note).
- **Q3: equal to React, documented.** The dead window is not a bug while it equals a React SSR page.
- **Q4: no replay spike now.** It can be reopened only with a user report or a page where `interaction` deferral saves measured bytes. The spike then starts from mitigation 1, the React-level replay of the stored original event.
- **Q5: recorded only.** The Suspense form is the larger decision because it changes every island's SSR output. It is not started.
- **Q6: decided together with C, not now.** **Q7: no real-device pass needed** for Q1–Q3. It is required before any ruling on C.
- **Q8: yes.** Ledger **F184**: the dead window, documented and not fixed. Ledger **F185**: an island whose SSR output is empty (the `chart` shape) cannot be deferred to save its first paint.

## 11. Result of the `hydration-preload` lane (Guetta, 2026-10-15)

**R42.1 does not ship.** The criterion was written on the task before measuring: in every page × profile cell the median hydrated-at improves by at least 30 ms and the median FCP regresses by at most 15 ms. It fails, and the lead's wording ("hydrated-at improves with no FCP regression on all three throttle profiles") fails with it. Shipped instead: R42.2 (the Chromium pin) and R42.3 (the docs note).

Setup: the same three shadcn pages, now wrapped in a real `<html><head>` document so the existing L33 `modulepreload` links (runtime, `rt-island`) are present and the new links go right after them (a fragment page has no head and gets no links, `render.rs` `preload_insert_at`). Profiles: slow-4G + CPU 4× (150 ms RTT, 1.6 Mbit/s), regular-4G + CPU 2× (70 ms RTT, 9 Mbit/s), unthrottled. n = 7 per cell, runs interleaved across variants (rep-major) to cancel host drift, 0 failed runs. Variants: `eager` (control), `preload-react` (`react-<id>.js` only), `preload-both` (react chunk + the shared chunk it imports, placed after the existing preload links), `preload-both-late` (same two links placed just before the first module script). ms, median of 7; Δ against `eager` in the same profile.

| Page · profile | eager FCP / hydrated | preload-react Δ FCP / Δ hydrated | preload-both Δ FCP / Δ hydrated | preload-both-late Δ FCP / Δ hydrated |
|---|---|---|---|---|
| accordion · slow-4G | 348 / 866 | +0 / +2 | **+92** / −65 | **+68** / −61 |
| accordion · regular-4G | 144 / 291 | +0 / −1 | +16 / −64 | +20 / −61 |
| accordion · none | 32 / 49 | +0 / +0 | +4 / +1 | +0 / +0 |
| select · slow-4G | 348 / 976 | +0 / +11 | **+80** / −41 | **+80** / −56 |
| select · regular-4G | 140 / 316 | +8 / +1 | +16 / −63 | +12 / −64 |
| select · none | 32 / 54 | +0 / −1 | +0 / −5 | +0 / −2 |
| chart · slow-4G | none (blank) / 1696 | n/a / −10 | n/a / −83 | n/a / −64 |
| chart · regular-4G | 532 / 470 | +12 / +5 | −60 / −63 | −60 / −61 |
| chart · none | 120 / 85 | −4 / −4 | −8 / −8 | −12 / −9 |

Reading:
- **`preload-react` does nothing** (|Δ| ≤ 12 ms everywhere). Preloading only `react-<id>.js` does not start the shared chunk earlier; Chromium fetches the chunk's imports after it has parsed it, which is the same waterfall as today.
- **`preload-both` and `-late` shorten hydration by 41–65 ms on a throttled link and cost 68–92 ms of FCP on slow-4G** on the two pages whose server HTML paints content. The extra 90–114 KB (gzip) competes with the render-blocking stylesheet for a 1.6 Mbit/s link, so first paint moves later by about as much as hydration moves earlier. Placing the links later in the document (`-late`) does not change that. Unthrottled the effect is within noise (|Δ| ≤ 8 ms), so it cannot meet "improves" either.
- **`chart` improves in every cell because its FCP *is* its hydration** (the server paints nothing, F185); that is the shape where a preload helps, and it is one page out of 41.
- The trade is real but not a win under the ruling: faster hydration for a first paint that is later by the same amount on slow links. A sharper variant (preload only when the stylesheet is already cached, or `fetchpriority="low"`, which `modulepreload` supports) is the only lead left; it was not measured because the ruling asks for a measured win of the simple form, and a priority hint is a behaviour-affecting browser heuristic that would need its own three-profile run on more than one browser. Recorded as a possible follow-up, not started.

What shipped: `tests/server/hydration-timing.chromium.test.ts` (R42.2; 2 tests, 3/3 green runs) and a note in `website/pages/docs/RenderingTiers.tsx` (R42.3). No Rust, runtime or server code changed. Probes and raw runs stay in the session scratchpad: `hyd-measure2.ts`, `matrix3.sh`/`matrix4.sh`, `m3-first.jsonl`, `m4.jsonl` (189 + 126 runs).

