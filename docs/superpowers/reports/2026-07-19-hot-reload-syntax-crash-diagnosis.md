# Hot reload syntax-crash diagnosis

Date: 2026-07-19
Scope: investigation only; no production or test changes retained
Matrix HEAD: `5af6877f9ee6`
Debugger HEAD: `117f394` (no changes under `runtime/` or `tests/fixtures/app` since the matrix HEAD)

## Executive conclusion

The crash boundary is the default-size Bun worker-pool replacement that follows a render-affecting hot reload. An invalid `routes.tsx` reaches the full reload path, completes island scanning/building and native-template re-emission, terminates the old Brust workers, and then creates ten fresh Bun `Worker`s. The failure is probabilistic: this diagnosis crashed 2/3 default-worker full-fixture attempts (one of two ordinary runs and the single LLDB run), while the preceding audit crashed 2/2.

`BRUST_WORKERS=1` is the smallest established discriminator. The same invalid-route trigger survived 2/2 full-fixture attempts and 2/2 no-native minimal-fixture attempts with one worker. An invalid island source was instead rejected by the island build and kept the server alive. LLDB caught `EXC_BAD_ACCESS` on `Bun Pool 9` in `_platform_memmove`; the first caller was a stripped Bun frame, while the visible Brust native/Tokio threads were parked.

Confidence is **high** that the fatal instruction executes inside Bun's concurrent pool work and **medium** that fresh multi-worker module loading is the complete trigger. The stripped Bun binary prevents resolving the internal caller, and a default-worker no-native minimal case was not run before the investigation was closed. Native template re-emission is therefore not proven necessary or unnecessary.

Recommended containment: validate the reload's worker entry/import graph before terminating the healthy generation or spawning replacements. A validation failure must stay inside `Coordinator.handleChange()`'s catch path, broadcast `error`, and leave the old worker pool serving. `BRUST_WORKERS=1` is a temporary operational mitigation, not a correctness fix: surviving runs incorrectly broadcast `reload → ok` for invalid source.

## Environment

- macOS 26.5.1 (25F80), arm64
- Bun `1.4.0-canary.1+f8723b190`
- Default worker count: 10 (`hw.logicalcpu` and the Brust banner)
- Full fixture: disposable same-depth copy of `tests/fixtures/app`
- Minimal fixture: same-depth app containing only `index.ts`, `routes.tsx`, and one leaf `Page.tsx`; no native routes or islands
- Trigger: append `export const syntaxDiagnosisBroken = @@@` after startup
- Liveness proof: fetch `/ping` after the terminal hot-reload observation
- Crash proof: Bun panic or LLDB `EXC_BAD_ACCESS` plus loss of HTTP service; `Bun.Subprocess.exitCode` can remain `null` after the panic

## Exact reproduction

From the repository root, create a disposable same-depth fixture, then start it from inside that fixture:

```sh
cp -R tests/fixtures/app tests/fixtures/syntax-crash-repro
cd tests/fixtures/syntax-crash-repro
BRUST_NO_TUI=1 bun ../../../runtime/cli/index.ts dev index.ts --port 3882
```

Keep a dev WebSocket open in another terminal:

```sh
bun -e 'const ws=new WebSocket("ws://127.0.0.1:3882/_brust/dev");ws.onmessage=e=>console.log(String(e.data));await new Promise(()=>{})'
```

Then append invalid syntax from the repository root:

```sh
printf '\nexport const syntaxDiagnosisBroken = @@@\n' >> tests/fixtures/syntax-crash-repro/routes.tsx
sleep 3
curl -fsS http://127.0.0.1:3882/ping
```

The observed crash sequence is `building`, `hotreload …/routes.tsx`, `native templates — 0 compiled, 14 unchanged (skipped)`, then a Bun segmentation fault. Because the crash is probabilistic, a single surviving attempt does not falsify it. In a surviving attempt the current implementation emits `reload → ok` despite the invalid source, which is also incorrect.

To exercise the containment control, start the same fixture with `BRUST_WORKERS=1`. It survived 2/2 full-fixture invalid-route attempts in this diagnosis.

## Minimization table

| Case | Workers | Native/islands | Trigger | Crash rate | Terminal messages | Interpretation |
| --- | ---: | --- | --- | ---: | --- | --- |
| Full fixture, diagnosis matrix | 10 | 14 native templates, 3 island chunks | Invalid `routes.tsx` | 1/2 | Crash: `building`; survivor: `building → reload → ok` | Default configuration reproduces probabilistically. |
| Full fixture under LLDB | 10 | Same | Invalid `routes.tsx` | 1/1 | `building`, then `EXC_BAD_ACCESS` | Second matching crash in this diagnosis; debugger localizes the executing thread. |
| Full fixture, preceding audit | 10 | Same | Invalid `routes.tsx` | 2/2 | `building`, then Bun panic at `0x30` | Confirms the rate varies across small samples; it is not deterministic. |
| Full fixture control | 1 | Same | Invalid `routes.tsx` | 0/2 | `building → reload → ok` | Worker count/concurrency is the strongest discriminator. Survival does not mean correct error handling. |
| Minimal no-native fixture | 1 | None; 0 island chunks | Invalid `routes.tsx` | 0/2 | `building → reload → ok` | Native routes and islands are not required for the surviving one-worker behavior. |
| Full fixture leaf page | 10 | Same | Invalid `pages/HelloWorld.tsx` | 0/1 | `building → reload → ok` | A leaf syntax error did not reproduce in the bounded sample. |
| Full fixture island | 10 | Same | Invalid `components/Counter.tsx` | 0/1 | `building → error` | `buildIslands()` catches this syntax error before worker churn; server remains alive. |
| Minimal leaf control | 1 | None | Invalid `Page.tsx` | 0/1 | `building → reload → ok` | One-worker leaf case survives, again without a useful syntax error. |
| Minimal valid edit control | 1 | None | Valid `Page.tsx` edit | 0/1 | `building → reload → ok` | Ordinary reload control remains healthy. |

The investigation stopped at the requested boundary. It did not run a broader default-worker minimal matrix, so the fixture has not been reduced to a content-minimal crashing app. The established minimum is an axis: default ten-worker replacement versus `BRUST_WORKERS=1` for the same full fixture.

## Fail path

For `ts`, `html`, `islands`, and `md`, `runtime/dev/coordinator.ts` performs this ordered transaction:

1. Broadcast `building`.
2. Clear the island cache.
3. Run `buildIslands()`.
4. Run `reEmitJinja()`.
5. Reset the native render worker pool and await `worker-registry.terminateAll()`.
6. Await `worker-registry.spawnAll()`.
7. Broadcast `reload`, then `ok`.

The invalid trailing token in `routes.tsx` does not change native component inputs: the last external marker before each full-fixture crash was `native templates — 0 compiled, 14 unchanged (skipped)`. `scanIslandChunks()` is import/usage scanning rather than a complete route-module parse, so this trigger can pass the earlier island phase. The next boundary creates `state.count` new Bun workers in a tight loop and waits for their `brust-worker-ready` messages.

The crash occurs before `spawnAll()` resolves and before either `reload` or `error` can be broadcast. It therefore bypasses the coordinator's JavaScript exception handler: this is a native process fault, not a rejected worker-ready promise.

## LLDB evidence

The debugger launched the ordinary ten-worker fixture and caught the first invalid-route edit:

```text
Process stopped
* thread #16, name = 'Bun Pool 9', stop reason = EXC_BAD_ACCESS (code=1, address=0x33)
  * frame #0: libsystem_platform.dylib`_platform_memmove + 52
    frame #1: bun`___lldb_unnamed_symbol_1010b7568 + 3252
    frame #2: bun`___lldb_unnamed_symbol_10189d910 + 2796
    frame #3: bun`___lldb_unnamed_symbol_10189c40c + 12
    frame #4: bun`___lldb_unnamed_symbol_10189c510 + 56
```

`thread backtrace all` showed the Rust `brust.darwin-arm64.node` Tokio threads waiting in their scheduler/condition-variable paths. This does not prove native state could not have corrupted memory earlier, but it rules out a visible Brust native frame as the executing crash site. Bun's release/canary executable is stripped, so LLDB could not name the Bun functions below `memmove`.

## Ranked hypotheses and disproof ledger

| Rank | Hypothesis | Evidence and disproof | Status |
| ---: | --- | --- | --- |
| 1 | Concurrent Bun worker startup/loading of an invalid import graph faults during pool replacement. | Default ten-worker full fixture crashed 2/3 in this diagnosis; same fixture with one worker survived 2/2. LLDB stopped on `Bun Pool 9` in `memmove`. | Best fit; medium confidence on complete trigger. |
| 2 | Terminate-old then spawn-invalid ordering is required. | Every crash followed the completed native re-emission marker and occurred before new workers reported ready. No direct spawn-without-terminate probe was retained. | Plausible, not isolated. |
| 3 | Brust native/NAPI work is the immediate crash site. | LLDB's faulting stack is Bun/system only and visible Brust Tokio threads are parked. However, a default-worker no-native crashing control was not completed. | Lowered, not eliminated. |
| 4 | `buildIslands()` crashes on arbitrary invalid syntax. | Invalid island source produced `building → error` and preserved HTTP service. Invalid routes reached the later native-template marker. | Falsified as the general crash mechanism. |
| 5 | WebSocket broadcast or the coordinator itself faults independently of workers. | The coordinator catches an island build failure correctly; fatal runs end during the worker-replacement interval before `reload`/`error`. | Low confidence. |

## Root-cause confidence and ownership

- **Observed crash site — high confidence:** Bun pool thread, system `memmove`, during the reload transaction.
- **Brust trigger boundary — high confidence:** destructive worker-generation replacement after earlier build/re-emission phases complete.
- **Multiple-worker requirement — medium confidence:** 10-worker runs crashed and four invalid-route one-worker runs survived, but the sample is bounded and no intermediate worker counts were run.
- **Underlying Bun defect — medium confidence:** the native fault and stripped Bun-only top stack are consistent with a Bun runtime bug. The exact Bun function and whether earlier Brust native state contributes remain unresolved.
- **Native templates required — unknown:** one-worker no-native cases are controls for survival, not a default-worker crash comparison.

Brust owns containment even if Bun owns the underlying fault. Invalid source should be rejected before the currently healthy worker generation is destroyed.

## Containment boundary

Add a preflight immediately before `workers.terminateAll()` in the coordinator's full-reload branch. It must validate the actual worker entry/import graph against the edited files without mutating the live generation. On failure it should throw a normal JavaScript error so the existing catch block broadcasts `error`; it must not reset the native worker pool or terminate existing workers.

Do not treat `BRUST_WORKERS=1` as the final fix. It is a useful emergency mitigation for the crash, but all four one-worker invalid-route attempts reported `reload → ok` rather than `error`. That can preserve stale/cached code while telling the browser the rebuild succeeded.

## Regression-test seam

The regression belongs at the dev-server boundary, not only in a mocked `Coordinator` unit test:

1. Start a fresh disposable fixture with the default worker count (or at least two workers) and keep the dev WebSocket connected.
2. Confirm `/ping` is healthy.
3. Write invalid syntax into `routes.tsx`.
4. Require `building → error`, forbid `reload` and `ok`, and require the original generation to keep serving `/ping`.
5. Restore valid source.
6. Require a fresh `building → reload → ok` cycle and verify the corrected route output.
7. Repeat the invalid/repair sequence enough times to catch the previously probabilistic multi-worker fault.

A focused coordinator test should additionally assert ordering: validation failure occurs before native-pool reset, `terminateAll()`, and `spawnAll()`. The process-level test is still required because a JavaScript mock cannot reproduce a Bun worker-pool native crash.

## Investigation limits

- No production or committed test files were edited.
- Disposable fixtures and matrix scripts were removed from the repository/work area after collection.
- No direct default-worker no-native crash case, intermediate worker-count sweep, or symbolized Bun build was run after the lead closed the investigation.
- The reported rates are observations from small samples, not estimates of a stable crash probability.
