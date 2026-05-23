# Pre-spawned Connection Workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace spawn-per-connection in `src/server.rs::start` with a fixed pool of `opts.workers` pre-spawned TCP worker tasks that receive `TcpStream` values from a bounded `flume` MPMC channel.

**Architecture:** Local refactor inside `src/server.rs::start`. A `flume::bounded::<TcpStream>(1024)` channel sits between the accept loop and N worker tasks. `handle_conn` itself is unchanged. `server::start` gains a `workers: usize` parameter; `lib.rs::begin_serve` passes `opts.workers as usize` through.

**Tech Stack:** Rust 2024 edition, `napi-rs 3.x`, single-thread runtime per backend (`tokio_uring::start` on Linux, `new_current_thread` on macOS), `flume = "0.11"`, integration test driven via `bun test`.

**Spec:** `docs/superpowers/specs/2026-05-23-prespawned-conn-workers-design.md`

---

## Context: this is a refactor under test, not a TDD feature

The integration test `tests/integration.test.ts` already exists and **passes today**. This refactor does not change user-observable behavior (the HTTP response is identical). The discipline is therefore:

- The integration test stays green before, during, and after the refactor.
- No new automated tests are added (the spec scopes that out).
- A manual concurrency smoke check (100-burst `curl`) is run once at the end to validate that work-stealing across workers doesn't deadlock or panic.

Do NOT add unit tests that mock flume or fake the runtime. The integration test is the safety net.

---

### Task 1: Baseline verification

**Files:** none modified

- [ ] **Step 1: Confirm cargo build is clean**

Run: `cargo build`
Expected: succeeds with the existing dead-code warnings only (`error_414`, `error_404`, `src/shutdown.rs`). No new errors. No new warnings.

- [ ] **Step 2: Rebuild the napi `.node` to ensure the integration test uses fresh native code**

Run: `cd runtime && bun run build:debug && cd ..`
Expected: `runtime/index.darwin-arm64.node` is regenerated. No errors.

- [ ] **Step 3: Run the integration test as a baseline**

Run: `bun run test`
Expected: `1 pass, 0 fail` in roughly ~150–1100ms (the second run is fast because cargo is incremental). If this fails, stop and ask the user — the baseline must be green before refactoring.

- [ ] **Step 4: Skip commit**

This task only verifies starting state. Nothing to commit.

---

### Task 2: Add `flume` dependency

**Files:**
- Modify: `Cargo.toml`

- [ ] **Step 1: Add flume to `[dependencies]`**

Modify `Cargo.toml`. Locate the `[dependencies]` block (currently lines 9–17) and add a `flume` entry alongside the other base dependencies. The full block becomes:

```toml
[dependencies]
napi               = { version = "3", default-features = false, features = ["napi6", "async"] }
napi-derive        = "3"
httparse           = "1"
parking_lot        = "0.12"
thiserror          = "1"
tracing            = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
once_cell          = "1"
flume              = "0.11"
```

Do not change the per-target dependency blocks below.

- [ ] **Step 2: Verify cargo resolves and compiles**

Run: `cargo build`
Expected: cargo downloads `flume` (and its tiny transitive deps `spin`, `pin-project-lite` — these are already in the tree via tokio so no surprise). Build succeeds. Same dead-code warnings as before, nothing new.

- [ ] **Step 3: Verify the integration test still passes**

Run: `bun run test`
Expected: `1 pass, 0 fail`. (Just adding the dep should not change behavior; this is a paranoia check.)

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml Cargo.lock
git commit -m "$(cat <<'EOF'
chore(deps): add flume 0.11 for MPMC conn channel

Preparation for replacing spawn-per-conn in server::start with a
pre-spawned worker pool driven by a bounded MPMC channel.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Refactor `server::start` to pre-spawned workers + channel

**Files:**
- Modify: `src/server.rs` (lines 1–42 — the `start` function and its imports)
- Modify: `src/lib.rs:80` (the single call site of `server::start`)

This is the core change. It touches two files but they must be modified together because the function signature changes in one and the caller updates in the other. Land them in one commit so `cargo build` stays green between commits.

- [ ] **Step 1: Update imports in `src/server.rs`**

Locate the existing imports at the top of `src/server.rs` (lines 1–9):

```rust
use std::net::SocketAddr;
use std::sync::Arc;

use tokio::sync::Notify;
use tracing::{error, warn};

use crate::http::{self, parse_request, ParseError};
use crate::io::{run_io, spawn, IO_NAME, TcpListener, TcpStream};
use crate::pool::WorkerPool;
```

No new imports are needed — `flume::bounded` is referenced as `flume::bounded::<TcpStream>(...)` directly. Leave the imports as they are.

- [ ] **Step 2: Replace the `start` function**

Replace the entire `start` function (currently `src/server.rs:13-42`) with this version. Note the new `workers: usize` parameter and the new `CONN_CHAN_CAP` constant added near the top of the file (next to `MAX_REQUEST_BYTES`).

First, change the existing const block (line 11) from:

```rust
const MAX_REQUEST_BYTES: usize = 16 * 1024;
```

to:

```rust
const MAX_REQUEST_BYTES: usize = 16 * 1024;
const CONN_CHAN_CAP: usize = 1024;
```

Then replace the `start` function body. The full new function:

```rust
pub fn start(addr: SocketAddr, ready: Arc<Notify>, pool: Arc<WorkerPool>, workers: usize) {
    run_io(move || async move {
        let listener = match TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                error!(error = %e, %addr, "bind failed");
                std::process::exit(1);
            }
        };

        let (tx, rx) = flume::bounded::<TcpStream>(CONN_CHAN_CAP);

        // Pre-spawn N TCP worker tasks. Each loops on rx.recv_async() and
        // calls handle_conn for every stream it receives. Workers exit only
        // when all Senders drop (i.e. accept loop has exited).
        for _ in 0..workers {
            let rx = rx.clone();
            let pool = pool.clone();
            spawn(async move {
                while let Ok(stream) = rx.recv_async().await {
                    handle_conn(stream, pool.clone()).await;
                }
            });
        }
        // Drop the original Receiver. Only the worker clones remain; if all
        // workers exit, tx.send_async() will return Err(Disconnected) and the
        // defensive guard below will fire. Without this drop, the original rx
        // here keeps the channel "connected" forever, masking worker death.
        drop(rx);

        ready.notified().await; // wait until all napi workers have registered
        println!("[brust] listening on {addr} (io: {IO_NAME})");
        let _ = std::io::Write::flush(&mut std::io::stdout());

        loop {
            match listener.accept().await {
                Ok((stream, _peer)) => {
                    if tx.send_async(stream).await.is_err() {
                        error!("all conn workers died");
                        std::process::exit(1);
                    }
                }
                Err(e) => {
                    error!(error = %e, "accept failed");
                    std::process::exit(1);
                }
            }
        }
    });
}
```

Leave `handle_conn` (`src/server.rs:44-96`) and `read_full_request` (`src/server.rs:98-117`) completely untouched.

- [ ] **Step 3: Update the call site in `src/lib.rs`**

Locate `src/lib.rs:80`:

```rust
    server::start(addr, Arc::clone(&s.ready), Arc::clone(&s.pool));
```

Replace with:

```rust
    server::start(addr, Arc::clone(&s.ready), Arc::clone(&s.pool), opts.workers as usize);
```

Nothing else in `lib.rs` changes. `opts.workers` is already `u32` (see `ServeOptions` at `src/lib.rs:60-65`); the `as usize` cast is lossless on all supported platforms.

- [ ] **Step 4: Verify cargo build**

Run: `cargo build`
Expected:
- Clean compile.
- If `tokio_uring::net::TcpStream` is `!Send`, you may see an error like `the trait Send is not implemented for tokio_uring::net::TcpStream` inside the `flume::Sender<TcpStream>::send_async` future on Linux. **If this happens on macOS, stop — something else is wrong.** If it only appears under `--target x86_64-unknown-linux-gnu` (we don't build that here by default), flag it to the user as the spec-noted Linux risk; do **not** try to work around it without discussion.
- Same dead-code warnings as before. No new warnings.

- [ ] **Step 5: Rebuild the napi `.node`**

Run: `cd runtime && bun run build:debug && cd ..`
Expected: `runtime/index.darwin-arm64.node` regenerated. No errors.

- [ ] **Step 6: Run the integration test**

Run: `bun run test`
Expected: `1 pass, 0 fail`. The HTTP response body is byte-identical to before because `handle_conn` is unchanged. If this fails, the channel wiring is wrong — debug before continuing.

- [ ] **Step 7: Manual concurrency smoke (one-shot, not committed)**

In one terminal:

```bash
bun run dev
```

Wait for `[brust] listening on 127.0.0.1:3000 (io: tokio)`.

In another terminal, run a 100-request burst:

```bash
for i in {1..100}; do curl -s http://localhost:3000/ > /dev/null & done; wait; echo "burst done"
```

Then a sanity follow-up:

```bash
curl -i http://localhost:3000/
```

Expected:
- `burst done` prints without any curl errors (`Connection refused`, `Empty reply`, etc.).
- The final `curl -i` returns `HTTP/1.1 200 OK` with body containing `Hello from Brust` and `worker_id=<N>`.
- The dev process prints no Rust panic and is still running. Stop it with Ctrl-C when satisfied.

If anything in this smoke check fails, debug before committing. The integration test alone only exercises a single request and won't catch channel deadlocks under load.

- [ ] **Step 8: Commit**

```bash
git add src/server.rs src/lib.rs
git commit -m "$(cat <<'EOF'
refactor(server): pre-spawned conn workers over flume MPMC channel

Replace spawn-per-connection in server::start with a fixed pool of
opts.workers TCP worker tasks that receive TcpStream values from a
flume::bounded(1024) MPMC channel. Eliminates per-connection task
allocation; workers stay hot in the runtime poll list. handle_conn
itself is unchanged.

server::start now takes workers: usize; lib.rs::begin_serve passes
opts.workers as usize through.

Spec: docs/superpowers/specs/2026-05-23-prespawned-conn-workers-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist (run after implementation, before declaring done)

- [ ] `cargo build` is clean — no errors, no new warnings (existing `error_414` / `error_404` / `shutdown.rs` dead-code warnings are pre-existing).
- [ ] `bun run test` passes (`1 pass, 0 fail`).
- [ ] Manual 100-burst smoke check from Task 3 Step 7 passed once.
- [ ] `git log --oneline -5` shows two new commits: `chore(deps): add flume` and `refactor(server): pre-spawned conn workers`.
- [ ] `git diff HEAD~2 -- src/server.rs` shows: new `CONN_CHAN_CAP` const, new `workers: usize` parameter, `flume::bounded` + worker spawn loop + `drop(rx)` + `tx.send_async` replacing the old `spawn(handle_conn(...))`.
- [ ] `git diff HEAD~2 -- src/lib.rs` shows exactly one line changed — the `server::start(...)` call gains `opts.workers as usize`.
- [ ] `handle_conn` and `read_full_request` in `src/server.rs` are byte-identical to before.

## Risks (carried over from spec, monitor during implementation)

1. **Linux Send-ness:** `tokio_uring::net::TcpStream` may be `!Send`, which would clash with `flume`'s `Send` bound. Surfaces at `cargo build` time. Mitigation per spec.
2. **Channel capacity:** `1024` is a guess. If smoke check shows accept-side latency under burst, revisit before committing — but a 100-burst from one host should never exceed 1024 in flight.
3. **Worker count semantics:** Matches napi workers (`opts.workers`). If `until_ready` semantics change later (currently waits for all napi workers to register), the TCP worker spawn happens *before* `ready.notified().await`, which is intentional — workers are ready to receive as soon as the listener binds, but `tx.send_async` will only start being called after readiness gating.
