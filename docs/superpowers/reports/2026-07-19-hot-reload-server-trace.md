# Hot Reload Server Trace

Conclusion: the dev hot-reload pipeline is mostly ordered correctly, but there is one confirmed loss mode in the coordinator: any change that lands while `Coordinator.state === 'building'` is dropped with no replay, so a single save during a long rebuild can vanish until another edit arrives.

## Call / State Diagram

```text
fs.watch(root)
  -> watcher.coalesce(debounce)
  -> classifyPath(absPath, root, hasMdRoutes)
  -> Coordinator.handleChange({ paths, kind })
       if state === 'building' -> return immediately (drop)
       state = 'building'
       broadcast({ type: 'building' })
       append TUI start line
       switch kind
         ts/html/islands/md:
           clearIslandCache?
           buildIslands()
           reEmitJinja()
           terminateAll()
           spawnAll()
           broadcast({ type: 'reload' })
         css:
           buildCss()
           broadcast({ type: 'css-update', href })
         component-css:
           snapshot before
           buildComponentCss()
           snapshot after
           broadcast({ type: 'reload' } | css-update per chunk)
       broadcast({ type: 'ok' })
     catch error
       broadcast({ type: 'error', message, stack })
     finally
       state = 'idle'
```

## Knobs / Boundaries

- `watcher.ts` gates `.md` edits behind `hasMdRoutes`; ignored dirs and test files are skipped.
- `createWatcher()` coalesces by dominant kind: `islands > ts > md > html > css > component-css`.
- `Coordinator.handleChange()` is single-flight only; it has no queue for a second event that arrives while building.
- `worker-registry.spawnAll()` waits for each worker to send `brust-worker-ready`, but falls back after 5s if a worker never signals.
- `ws-channel.broadcast()` sends through the Rust-owned `/__brust/dev` channel; worker-local relaying only handles the worker-side message fanout.
- `runtime/index.ts` wires the whole dev graph in one place: watcher, coordinator, worker pool reset/spawn, `reEmitJinja`, island cache clear, and the broadcast hook.
- `runtime/cli/dev.ts` emits native templates before boot, registers the Jinja re-emit callback, and then imports the entry.
- `runtime/cli/native-routes-emit.ts` injects the dev client into native templates and also injects AI when enabled.
- `runtime/islands/build.ts` unconditionally removes the islands output dir before rebuilding chunks and bootstraps.

## Ranked Hypotheses

1. Confirmed defect: a change that arrives while the coordinator is already building is lost.
- Evidence: `runtime/dev/coordinator.ts:32-34` returns immediately when `state === 'building'`; there is no pending queue or replay, and `state` only resets in `finally` at `runtime/dev/coordinator.ts:106-107`.
- End-to-end symptom: if a save lands during a long rebuild window, the watcher debounces it, the coordinator ignores it, and no subsequent `reload` is broadcast for that edit unless the user edits again.
- Executable evidence: `runtime/dev/coordinator.test.ts` has `single-flight: change-while-building is dropped`, which passes and documents the drop behavior.
- Simplest disproof: add a queue or replay path; absent that, the current code and test both show the loss.

2. Residual risk: `spawnAll()` is fail-open after a 5s readiness grace, so a crashed or hung worker can still let the reload path complete.
- Evidence: `runtime/dev/worker-registry.ts:53-84` waits for `brust-worker-ready` but resolves each worker after a 5s timeout even if it never signaled.
- End-to-end symptom: coordinator reaches `reload` even though one of the fresh workers may not actually be ready to relay `/__brust/dev` messages or serve requests.
- Prediction: a worker that crashes before posting ready leaves the server with a nominally successful reload but a degraded pool.
- Simplest disproof: reproduce a worker that never emits `brust-worker-ready` and show the coordinator still reports success after the timeout.

3. Residual risk: a build failure during `buildIslands()` can leave the reload path with partially rewritten islands artifacts before the coordinator bails out.
- Evidence: `runtime/islands/build.ts:135-141` deletes the islands output dir before rebuilding; `runtime/dev/coordinator.ts:59-69` awaits that rebuild before re-emitting Jinja or restarting workers.
- End-to-end symptom: if the rebuild throws after the dir is removed, the coordinator catches the error and broadcasts `error`, but no restart/reload happens, so the current browser session keeps old workers while the islands dir may already be empty or partial.
- Prediction: the next request for a previously served island chunk can 404 until a later successful edit rebuilds the dir.
- Simplest disproof: force `buildIslands()` to fail after the rm step and verify the old chunk URLs still exist and the old worker pool stays internally consistent.

4. Disproved concern: the Jinja reload happens after worker restart and could serve stale templates to new workers.
- Evidence against it: `runtime/dev/coordinator.test.ts` explicitly asserts the order `buildIslands -> reEmitJinja -> terminateAll -> spawnAll -> reload`, and the test passes.
- Source support: `runtime/dev/coordinator.ts:60-69` matches that order in code.
- Result: this specific stale-Jinja race is not present in the current implementation.

5. Disproved concern: the dev WebSocket reload path was still worker-owned and would lose `reload` across restarts.
- Evidence against it: `tests/dev-reload.test.ts` passes end to end, proving `/__brust/dev` receives `reload` across a ts hot reload and the server survives the worker restart.
- Source support: `runtime/dev/ws-channel.ts:84-97` now broadcasts through the Rust-owned channel instead of the old worker relay.
- Result: the lost-reload/UAF bug is closed in the current tree.

## Confirmed Defect

- `runtime/dev/coordinator.ts:32-34, 106-107` is the only confirmed loss mode I found: the coordinator drops edits that land while it is already building, with no queue to replay them after the current cycle finishes.

## Disproof Results

- `runtime/dev/coordinator.test.ts` disproves the stale-Jinja ordering concern.
- `tests/dev-reload.test.ts` disproves the old worker-owned `/__brust/dev` reload-loss path.
- `tests/dev-reload-option.test.ts` proves the programmatic `run({ dev: true })` hot-reload path is now registered correctly; it is not part of the current failure surface.

## Sources

- `runtime/dev/watcher.ts:10-36, 86-118`
- `runtime/dev/coordinator.ts:32-69, 99-107`
- `runtime/dev/worker-registry.ts:32-84`
- `runtime/dev/ws-channel.ts:60-97`
- `runtime/dev/jinja-reload.ts:17-25`
- `runtime/index.ts:864-965`
- `runtime/cli/dev.ts:64-153`
- `runtime/cli/native-routes-emit.ts:267-287, 995-1008`
- `runtime/islands/build.ts:131-214`
- `runtime/dev/coordinator.test.ts`
- `runtime/dev/watcher.test.ts`
- `runtime/dev/ws-channel.test.ts`
- `tests/dev-reload.test.ts`
- `tests/dev-reload-option.test.ts`
