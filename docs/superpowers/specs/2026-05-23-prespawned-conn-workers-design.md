# Brust — Pre-spawned Connection Workers (Design)

**Date:** 2026-05-23
**Sub-project:** 3
**Status:** Approved, ready for implementation plan

## Goal

Replace the spawn-per-connection pattern in `src/server.rs` with a fixed pool of
pre-spawned TCP worker tasks that receive incoming streams over an MPMC channel.
The motivation is **throughput**: eliminate the per-connection `tokio::spawn`
allocation and keep workers hot in the runtime's poll list.

## Non-goals

- DoS protection / explicit concurrency cap as a feature (we get backpressure
  for free from a bounded channel, but it is not the design goal).
- Pinning TCP workers to specific napi workers — `handle_conn` still calls
  `pool.pick_least_busy()` for the napi worker.
- Graceful shutdown / drain — SIGINT is already handled on the TS side; Rust
  `src/shutdown.rs` is dead code today and stays dead code after this change.
- Dynamic worker resize, metrics, or configurable channel capacity. Hard-code
  `CONN_CHAN_CAP = 1024`.

## Current state (what changes)

```rust
// src/server.rs (today)
loop {
    let (stream, _peer) = listener.accept().await?;
    let pool = pool.clone();
    spawn(async move {
        handle_conn(stream, pool).await;
    });
}
```

Every connection allocates a fresh task. We replace this with:

```rust
let (tx, rx) = flume::bounded::<TcpStream>(CONN_CHAN_CAP);

for _ in 0..workers {
    let rx = rx.clone();
    let pool = pool.clone();
    spawn(async move {
        while let Ok(stream) = rx.recv_async().await {
            handle_conn(stream, pool.clone()).await;
        }
    });
}
drop(rx); // accept loop owns only the sender

loop {
    let (stream, _peer) = listener.accept().await?;
    if tx.send_async(stream).await.is_err() {
        error!("all conn workers died");
        std::process::exit(1);
    }
}
```

## Architecture

```
                   flume::bounded::<TcpStream>(1024)
                              │
   accept loop ──tx.send_async(stream).await──┐
                                              │
                                              │
   worker 0  ──rx.recv_async().await──> handle_conn(stream, pool)
   worker 1  ──rx.recv_async().await──> handle_conn(stream, pool)
   ...                                                 │
   worker N-1 ──...                              pool.pick_least_busy() (napi)
                                                       │
                                                       └─> render → write → tcp shutdown
```

**Single-thread runtime invariant.** Both backends (`tokio_uring::start` on
Linux, `new_current_thread()` on macOS) run on one OS thread. All
`flume::Sender`/`Receiver` clones and the `TcpStream` values they carry stay on
that thread; we never cross a thread boundary, so `T: Send` is not required by
this code path (only by `flume`'s type bounds — see Risks).

## Components changed

| File | Change |
|---|---|
| `Cargo.toml` | Add `flume = "0.11"` (default features). |
| `src/server.rs` | Rewrite `start()` accept loop. Add `workers: usize` parameter. Pre-spawn N receiver tasks. Replace per-conn `spawn(handle_conn(...))` with `tx.send_async(stream).await`. |
| `src/lib.rs::begin_serve` | Pass `opts.workers` into `server::start(...)` (currently passes only `addr, ready, pool`). |
| `src/pool.rs` | **No change.** `expected_count()` is **not** added — pool stays unchanged; `workers` flows from `begin_serve` → `start` directly. |
| `src/io/{linux,other}.rs` | **No change.** `spawn()` abstraction still used (now for worker tasks instead of per-conn tasks). |
| `src/http.rs` | **No change.** |
| `src/shutdown.rs` | **No change** in this sub-project (still dead code). |

## Data flow per request

```
T0   client connect
T1   listener.accept() → Ok((stream, _))
T2   tx.send_async(stream).await
       (channel has space → immediate; full → suspend until a worker drains)
T3   some worker's rx.recv_async() returns Ok(stream)
T4   handle_conn(stream, pool):
       read_full_request → parse → method/path check
       pool.pick_least_busy() → InFlightGuard
       entry.tsfn.call_async(path).await → Promise → html
       build_response(200, ...) → s.write_all(...)
       s.shutdown()
T5   worker loops back to rx.recv_async().await
```

No behavioral change inside `handle_conn`. The only difference is *which task
runs it*: a long-lived worker instead of a one-shot spawn.

## Channel parameters

- **Crate:** `flume = "0.11"` (chosen for raw throughput per Q3 decision)
- **Mode:** `flume::bounded::<TcpStream>(1024)` — MPMC, work-stealing
- **Capacity:** `1024` (hard-coded const `CONN_CHAN_CAP`). Not exposed.
- **Worker count:** `opts.workers` (same value passed to `serve()` for napi
  workers; 1:1 conceptual mapping)

## Error handling

| Condition | Behavior |
|---|---|
| Channel full | `tx.send_async().await` suspends. Accept loop pauses. Kernel TCP backlog fills → healthy backpressure. No timeout, no drop. |
| All workers died (Receivers dropped) | `tx.send_async()` returns `Err(SendError::Disconnected)`. Accept loop logs and `std::process::exit(1)`. Defensive only — workers never exit under current design (Sender lives forever). |
| Sender dropped (accept loop exited) | `rx.recv_async()` returns `Err(RecvError::Disconnected)`. Worker `while let Ok(_)` falls through cleanly. Currently unreachable (accept loop never exits without `process::exit`). |
| `handle_conn` internal errors | Unchanged from today (write 400/405/500/502/503 and continue). Worker loops to next stream. |

## Testing

**Pass-criteria for the sub-project:**

1. `cargo build` clean (no new warnings beyond existing dead-code ones).
2. `bun run test` (= `bun test tests/integration.test.ts`) passes.
3. Manual concurrency smoke:
   ```bash
   bun run dev &
   sleep 1
   for i in {1..100}; do curl -s http://localhost:3000/ > /dev/null & done; wait
   ```
   All requests return 200, no panic, no FD leak.

**Out of scope:**

- Benchmarks vs. spawn-per-conn (deferred to dedicated "Benchmark harness"
  sub-project — the throughput claim is the motivation, but quantifying it is
  separate work).
- Unit tests of the channel mechanics (integration test covers behavior).
- Linux runtime testing (tokio-uring path remains compile-checked only on macOS
  host, same as today).

## Risks & caveats

1. **`tokio_uring::net::TcpStream` Send-ness on Linux.** `flume::Sender<T>` and
   `Receiver<T>` impl `Send + Sync` only when `T: Send`. If tokio-uring's
   `TcpStream` is `!Send`, the channel still works inside a single-thread
   runtime (we never `Send` across threads), but the *types* might not satisfy
   trait bounds. Mitigation if it surfaces at compile time:
   - Wrap stream in `Box<dyn ...>` (unlikely to help — same Send constraint).
   - Switch the Linux backend to an `mpsc-style` channel built on
     `tokio_uring`'s `LocalSet` primitives (would diverge io backends — last
     resort).
   - Fall back to `async-channel`, which has the same `T: Send` bound, so this
     isn't a real fallback — flag and revisit if hit.
   Will be caught at `cargo build` time during implementation.

2. **Channel capacity tuning.** `1024` is a guess. If the channel fills under
   load and accept latency dominates, we'll know from the benchmark sub-project
   and revisit.

3. **`workers` parameter threading.** `server::start` signature grows from 3 to
   4 args. Minor — only one caller (`lib.rs::begin_serve`).

4. **Worker count = napi workers.** If napi rendering is the bottleneck (which
   it almost certainly is for SSR), more TCP workers than napi workers gives no
   throughput gain. Match-1:1 is the sensible default; if benchmarks show
   network read is starving napi, revisit (probably as `connWorkers` in
   `ServeOptions`).

## Decision log

| Q | Answer | Why |
|---|---|---|
| Motivation | Throughput / reduce spawn cost | Per Q1 |
| Topology | 1 MPMC channel, work-stealing | Per Q2 — natural load-balance, no idx tracking in accept loop |
| Crate | `flume` | Per Q3 — peak throughput goal |
| Capacity | Bounded (1024) | Per Q4 — backpressure, no unbounded memory growth |
| Worker count | Match `opts.workers` | Per Q5 — 1:1 conceptual mapping, no extra config knob |
| Implementation locality | Local in `server::start` (Approach A) | Per final approach Q — minimal diff, no premature abstraction |
| `WorkerPool::expected_count()`? | No — pass `workers: usize` to `start()` (Option ข) | Caller already knows the value; don't add pool API surface |

## Follow-ups (not in this sub-project)

- Benchmark harness vs. Astro / Bun.serve / spawn-per-conn baseline.
- Remove `src/shutdown.rs` (already dead code under Bun).
- Linux CI matrix to exercise tokio-uring path.
- Wire 414 response for oversized requests.
