# Remove Dead `src/shutdown.rs` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `src/shutdown.rs` and all of its references in `src/lib.rs`. Bun intercepts `SIGINT` before Rust's `tokio::signal::ctrl_c()` handler can fire — the file has never had a working code path under Bun. Replace the gap with a short comment in `src/lib.rs` and switch the `until_shutdown` napi export to a parking primitive that simply blocks forever (it is held alive only by the TS-side `process.on('SIGINT', () => process.exit(0))`).

**Architecture:** Mechanical removal. The Rust crate gets ~40 lines smaller. No behavior changes — `process.exit(0)` from the TS layer is already what stops the process on `Ctrl-C` today, and `until_shutdown` was never actually unblocking on its own (the `Notify` it waited on was only signalled by the dead-on-Bun `install_sigint_handler`).

**Tech Stack:** Rust 2024 edition, `napi-rs 3.x`, `tokio::sync::Notify` (kept for the simplified `until_shutdown`).

**Spec source:** `architecture.md` lines 844-847 ("currently dead code under Bun — Bun intercepts SIGINT before Rust's ctrl_c() handler fires; actual exit happens via JS process.exit(0)") and the handoff §"Sub-project candidates" line: `Remove dead src/shutdown.rs  ~½ d  Replace with a comment in lib.rs explaining shutdown is JS-side.`

---

## Context

`src/shutdown.rs` (the whole file, currently 39 lines) defines a `Shutdown` struct wrapping a `tokio::sync::Notify`, plus `install_sigint_handler` that spawns a `std::thread` to await `tokio::signal::ctrl_c()` and then call `shutdown.signal()`.

In `src/lib.rs`:

- `mod shutdown;` at line 7
- `use crate::shutdown::{install_sigint_handler, Shutdown};` at line 24
- `shutdown: Arc<Shutdown>,` field on `State` at line 33
- `shutdown: Arc::new(Shutdown::new()),` in `State::default()` at line 53
- `install_sigint_handler(Arc::clone(&s.shutdown));` at line 79
- `state().shutdown.wait().await;` inside `until_shutdown` at line 111

The `install_sigint_handler` call is the *only* thing that signals the `Notify` in the existing crate. Under Bun, that signal never fires because Bun's own SIGINT handler runs `process.exit(0)` before `tokio::signal::ctrl_c()` returns. Consequently:

- `until_shutdown().await` does not return on its own.
- The process exits when the TS-side `process.on('SIGINT', () => process.exit(0))` (installed in `runtime/index.ts:43`) runs.

This plan removes the dead apparatus and replaces `until_shutdown` with a future that just parks the calling Promise forever (the right semantic — "wait until somebody exits the process"). The function stays exported because `runtime/index.ts` awaits it (line 45). We could also remove the napi export and rewrite the TS facade, but that is a wider blast radius — out of scope.

### Files this plan touches

| File | Change |
|---|---|
| `src/shutdown.rs` | Delete (whole file). |
| `src/lib.rs` | Remove the `mod shutdown;` declaration, the `use` import, the `Shutdown` field on `State`, the `install_sigint_handler` call, and rewrite `until_shutdown` to await an internal `Notify` that is never signalled. Add a short comment explaining the JS-side shutdown contract. |
| `tests/integration.test.ts` | Untouched — already kills the process with `proc.kill('SIGINT')` and asserts `exit === 0`, which works via the JS-side handler regardless. |

`src/server.rs`, `src/pool.rs`, `src/http.rs`, `src/io/**`, `Cargo.toml`, `runtime/index.ts`, and all example files are **not** modified.

---

### Task 1: Baseline verification

**Files:** none modified

- [ ] **Step 1: Confirm cargo build is clean**

Run: `cargo build`
Expected: succeeds with the existing dead-code warnings (`error_414`, and the only-called-from-itself `shutdown.signal()` if any). No new errors.

- [ ] **Step 2: Rebuild the napi `.node`**

Run: `cd runtime && bun run build:debug && cd -`
Expected: `runtime/index.darwin-arm64.node` regenerated. No errors.

- [ ] **Step 3: Run the integration test**

Run: `bun run test`
Expected: at least `1 pass`. (If the wire-error-414 plan landed first, expect `2 pass`.) The test ends with `proc.kill('SIGINT')` and asserts `exit === 0`, which is the load-bearing guarantee for this plan. If this fails, stop and ask the user.

- [ ] **Step 4: Skip commit**

This task only verifies starting state.

---

### Task 2: Make `until_shutdown` self-contained, then strip the module

This is one logical change but it touches `src/lib.rs` in several spots. Do it in one commit so the build stays green at every commit boundary.

**Files:**
- Modify: `src/lib.rs`
- Delete: `src/shutdown.rs`

- [ ] **Step 1: Remove the `mod shutdown;` declaration**

Open `src/lib.rs`. Delete line 7:

```rust
mod shutdown;
```

(The line just before is `mod server;` and the line just after is the blank line above `use std::net::SocketAddr;`. Leave both of those alone.)

- [ ] **Step 2: Remove the `Shutdown` import**

Delete line 24:

```rust
use crate::shutdown::{install_sigint_handler, Shutdown};
```

- [ ] **Step 3: Remove the `Shutdown` field from `State`**

Locate the `State` struct (currently `src/lib.rs:30-36`):

```rust
struct State {
    pool: Arc<WorkerPool>,
    ready: Arc<Notify>,
    shutdown: Arc<Shutdown>,
    is_serving: AtomicBool,
    expected_workers: AtomicU32,
}
```

Remove the `shutdown` field. Result:

```rust
struct State {
    pool: Arc<WorkerPool>,
    ready: Arc<Notify>,
    shutdown: Arc<Notify>,
    is_serving: AtomicBool,
    expected_workers: AtomicU32,
}
```

(We keep a field named `shutdown` but its type is now a plain `Arc<Notify>` that is *never signalled*. `until_shutdown` will `.notified().await` on it, which parks forever — exactly the semantic we want: "block this Promise until the JS-side `process.exit` actually exits the process.")

- [ ] **Step 4: Update the `State` initializer**

Locate the `state()` body (currently `src/lib.rs:40-58`). Find the lines:

```rust
        State {
            pool: Arc::new(WorkerPool::new()),
            ready: Arc::new(Notify::new()),
            shutdown: Arc::new(Shutdown::new()),
            is_serving: AtomicBool::new(false),
            expected_workers: AtomicU32::new(0),
        }
```

Change the `shutdown` line so it uses `Notify::new()`:

```rust
        State {
            pool: Arc::new(WorkerPool::new()),
            ready: Arc::new(Notify::new()),
            shutdown: Arc::new(Notify::new()),
            is_serving: AtomicBool::new(false),
            expected_workers: AtomicU32::new(0),
        }
```

- [ ] **Step 5: Remove the `install_sigint_handler` call**

Locate `begin_serve` (currently `src/lib.rs:67-87`). Find the line:

```rust
    install_sigint_handler(Arc::clone(&s.shutdown));
```

Replace it with this comment (which preserves the *why* per the project's comment rule):

```rust
    // Process shutdown is owned by the TS layer: runtime/index.ts installs
    // process.on('SIGINT', () => process.exit(0)). Bun intercepts SIGINT before
    // tokio::signal::ctrl_c() can fire in this process, so a Rust-side handler
    // is a no-op under Bun. until_shutdown() below parks the calling Promise
    // on s.shutdown forever; the parking ends when JS exits the process.
```

- [ ] **Step 6: Simplify `until_shutdown`**

Locate `until_shutdown` (currently `src/lib.rs:110-113`):

```rust
#[napi]
pub async fn until_shutdown() -> NapiResult<()> {
    state().shutdown.wait().await;
    Ok(())
}
```

Replace with:

```rust
#[napi]
pub async fn until_shutdown() -> NapiResult<()> {
    state().shutdown.notified().await;
    Ok(())
}
```

(One method call differs — `.wait()` was the old `Shutdown` API, `.notified()` is the `tokio::sync::Notify` API. Semantically identical for our purposes.)

- [ ] **Step 7: Delete `src/shutdown.rs`**

Run: `rm src/shutdown.rs`
Expected: file deleted, no error. (If you are using a git-aware delete, `git rm src/shutdown.rs` is equivalent and stages the deletion at the same time.)

- [ ] **Step 8: Verify cargo build is clean**

Run: `cargo build`
Expected:
- Clean compile.
- The previous "module `shutdown` is never used" / "`Shutdown::signal` is never used" dead-code warnings are gone.
- No new warnings.
- If you see `unresolved import crate::shutdown`, you missed Step 2 — re-check `src/lib.rs:24`.

- [ ] **Step 9: Rebuild the napi `.node`**

Run: `cd runtime && bun run build:debug && cd -`
Expected: `runtime/index.darwin-arm64.node` regenerated. No errors.

- [ ] **Step 10: Run the integration test**

Run: `bun run test`
Expected: same pass count as the baseline (`1 pass` or `2 pass` depending on whether wire-error-414 landed first). Specifically:
- The original `serves rendered html via worker pool` test passes.
- `proc.kill('SIGINT')` still causes the process to exit with code 0. This is the critical check — if the test now hangs at `await proc.exited`, the JS-side handler in `runtime/index.ts:43` is somehow not firing. Stop and inspect.

- [ ] **Step 11: Commit**

```bash
git add src/lib.rs src/shutdown.rs
git commit -m "$(cat <<'EOF'
refactor: remove dead src/shutdown.rs; shutdown is JS-side under Bun

Bun intercepts SIGINT before Rust's tokio::signal::ctrl_c() can fire,
so install_sigint_handler() was never actually firing under the only
host we run in. runtime/index.ts installs
process.on('SIGINT', () => process.exit(0)), which is what actually
exits the process today.

Replace the Shutdown wrapper with a plain Arc<Notify> on State that
is never signalled — until_shutdown().await parks the calling Promise
until JS exits the process, which matches the observable behavior
before this change. Add a comment in begin_serve explaining the
contract.

Crate shrinks by ~40 lines.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist (run after implementation, before declaring done)

- [ ] `src/shutdown.rs` no longer exists: `ls src/shutdown.rs` reports "No such file or directory".
- [ ] `cargo build` is clean. `cargo build 2>&1 | grep -i shutdown` returns nothing.
- [ ] `cargo build 2>&1 | grep "never used"` shows one fewer item than before (the `Shutdown::signal` / module-`shutdown` warnings are gone). The `error_414` warning is gone only if the wire-error-414 plan landed; otherwise it is still listed.
- [ ] `bun run test` reports the same number of passing tests as the baseline.
- [ ] `git log --oneline -2` shows the new commit on top.
- [ ] `git diff HEAD~1 --stat` shows two files changed: `src/lib.rs` modified, `src/shutdown.rs` deleted. No other files.
- [ ] `git diff HEAD~1 -- src/lib.rs` shows: `mod shutdown;` removed, `use crate::shutdown::...` removed, `Shutdown` → `Notify` in the `State` field and initializer, `install_sigint_handler(...)` replaced by the multi-line comment, `.wait()` → `.notified()` in `until_shutdown`. No other edits.
- [ ] `grep -rn "shutdown" src/` returns only the `s.shutdown` references in `lib.rs` (the `State` field name) — no leftover `Shutdown` type or `install_sigint_handler`.
- [ ] `runtime/index.ts` is untouched: `git diff HEAD~1 -- runtime/` is empty.

## Out of scope

- Renaming the `shutdown` field on `State` to something like `shutdown_park`. The current name still reads correctly given the new comment, and renaming would touch `begin_serve` and `until_shutdown` for cosmetics only.
- Removing the `until_shutdown` napi export entirely and rewriting `runtime/index.ts` to use a TS-side `await new Promise(() => {})`. Doable, but a wider change with no behavior win — current code already parks the Promise forever, just inside Rust.
- Re-implementing a real Rust-side graceful shutdown (drain workers, finish in-flight renders, close sockets). That is the "Graceful reload + worker drain" item in `architecture.md` §HTTP layer "Not implemented (deferred)" — a separate plan when there is demand.
- Cross-platform behavior: if Brust ever runs under a non-Bun JS host that does *not* swallow SIGINT, the JS-side handler still wins because `process.on('SIGINT', ...)` is portable. No platform-specific code remains.
