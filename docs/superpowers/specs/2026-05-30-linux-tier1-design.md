# Linux tier-1 support — design

**Date:** 2026-05-30
**Status:** spec (autonomous pipeline; full authority; real Linux box `root@192.168.0.4` aarch64-gnu, kernel 5.10, io_uring; **do NOT publish**)
**Branch:** `ci/github-actions-npm` (continues the npm/CI work)
**Context:** CI surfaced that brust's Linux (`tokio-uring`) path had never compiled (no Linux CI existed). Stopgaps so far made it compile (SseIo `Send` drop, WS cfg-gated OFF on Linux, musl dropped). This spec makes Linux a **tier-1 target**: WebSocket works, the 414 edge case matches macOS, and musl builds — by **forking `tokio-uring`** to fix what the upstream crate can't do for our use.

## Goal

`aarch64/x86_64-unknown-linux-gnu` AND `-musl` build, and the full integration
suite passes on real Linux io_uring (currently 65/71 on gnu: 5 WS + 1 the 414
edge case). Specifically:

1. **WebSocket works on Linux** — `tokio-tungstenite::WebSocketStream` needs
   `AsyncRead + AsyncWrite`; `tokio_uring::net::TcpStream` (completion-based)
   doesn't impl them. Provide them via the fork; re-enable the Linux WS path
   (remove the `#[cfg(target_os="linux")]` reject stopgap in `server.rs`).
2. **414 parity** — oversized requests return `414` on Linux (today `400`),
   matching the non-Linux path.
3. **musl builds** — `tokio-uring 0.5` references `libc::statx`/`STATX_*` (in
   its `fs/` module) which musl's `libc` bindings don't expose. Fork and gate
   the `statx` surface so musl compiles. brust uses only `net` + the basic
   `TcpStream`, never `fs::statx`.

## High-level architecture

Two sub-projects, sequenced:

### SP-1 — `tokio-uring` fork (`AssetsArt/tokio-uring`, branch `brust-0.5`)

Forked from the `0.5.0` source. Two changes:

**(a) musl statx gate.** The offending symbols live only in `src/fs/statx.rs`,
`src/io/statx.rs`, and `src/fs/create_dir_all.rs` (uses `libc::STATX_TYPE`).
Gate the `statx` op + the `Statx`/`StatxBuilder` API + `create_dir_all`'s statx
probe behind `#[cfg(target_env = "gnu")]` (musl falls back to a non-statx
`create_dir_all`, or that fn is also gnu-gated — brust uses neither). Net: on
`*-musl` the crate compiles with `fs::statx` absent; on gnu it's unchanged.

**(b) `AsyncRead`/`AsyncWrite` for `TcpStream`.** Add `impl tokio::io::AsyncRead`
and `AsyncWrite` for `tokio_uring::net::TcpStream`, bridging poll-based IO onto
the completion model. Feasible because the internal `Read`/`Write` ops hold a
**`SharedFd` clone** (`#[derive(Clone)]`, `Rc<Inner>`), not a borrow of the
stream — so an op future is independent of `&self` and can be stored across
polls. Design (in the fork, where `Op<Read<T>>`/`Op<Write<T>>` + `SharedFd` are
in-crate):

```
struct UringStreamIo {                       // or impl directly on a wrapper
    fd: SharedFd,                            // clone of the stream's fd
    pending_read:  Option<Op<Read<Vec<u8>>>>,
    pending_write: Option<Op<Write<Vec<u8>>>>,
    write_staging: Vec<u8>,                  // owned copy of the borrowed poll_write slice
}
impl AsyncRead  // poll_read: if no pending → submit read(Vec::with_capacity(remaining));
                // poll the op; on Ready copy n bytes into ReadBuf, clear pending.
impl AsyncWrite // poll_write: if no pending → copy buf into owned Vec, submit write; poll;
                // on Ready(n) clear pending, return Ok(n). poll_flush: Ok. poll_shutdown: shutdown.
```

The adapter's `poll_*` run on the `tokio_uring` runtime thread (the WS task is
spawned via `crate::io::spawn` = `tokio_uring::spawn`), so the thread-local
`CONTEXT` the ops require is present. Expose either `TcpStream: AsyncRead+AsyncWrite`
directly, or a `TcpStream::into_poll_io(self) -> impl AsyncRead+AsyncWrite+Unpin`
helper. **Decision deferred to plan:** prefer impl-on-TcpStream if `from_raw_socket`
can consume it; else a wrapper.

Published as a **git dependency** (pinned to a commit) so CI + the box build
reproducibly. No crates.io publish of the fork.

### SP-2 — brust: consume the fork + re-enable Linux features

- `crates/brust/Cargo.toml`: replace `tokio-uring = "0.5"` with
  `tokio-uring = { git = "https://github.com/AssetsArt/tokio-uring", branch = "brust-0.5" }`
  (pin `rev` once the fork is stable). Keep the `#[cfg(target_os="linux")]` gate
  on the dep.
- `crates/brust/src/io/linux.rs`:
  - Add `into_inner()` returning the fork's poll-IO type (mirrors `other.rs`'s
    `into_inner() -> tokio::net::TcpStream`), so the WS path is symmetric.
  - **414 fix — ROOT CAUSE is `read_request` not appending (spec-review B/Q4).**
    The non-Linux `other.rs::read_request` reads into a 4 KiB stack buffer and
    **appends** via `extend_from_slice`, so `buf` grows across reads and
    `read_full_request` (`server.rs:1482`) sees `buf.len() >= MAX_REQUEST_BYTES`
    → `ReadOutcome::Oversize` → `error_414`. The current Linux `linux.rs:37-43`
    does `std::mem::take(buf)` → `read(empty_vec)` → reassign, i.e. it **reads at
    offset 0 into an emptied vec every call and never appends** — so `buf.len()`
    never crosses `MAX_REQUEST_BYTES` (→ falls through to `400`) AND multi-TCP-
    segment requests are mishandled (a real correctness bug beyond the 414 edge).
    **Fix: redesign Linux `read_request` to APPEND** — read into a fresh owned
    buffer each call (uring needs an owned buffer), then `buf.extend_from_slice(
    &owned[..n])`, matching the non-Linux growth semantics. Then 414 + multi-
    segment both work. Validate on the box with a multi-segment + an oversized
    request.
- `crates/brust/src/server.rs`: remove the `#[cfg(target_os="linux")]` WS-reject
  stopgap; the `into_inner()` + `from_raw_socket` path becomes platform-common
  (or cfg-selects the fork's poll-IO on Linux, tokio's stream off-Linux).
- `package.json` + `release.yml` + `npm/`: re-add the two musl targets
  (`x86_64`/`aarch64-unknown-linux-musl`), optionalDependencies, npm dirs, and
  the release build-matrix entries (reverting the earlier musl-drop commit).
- Re-enable any tests skipped for Linux (none were skipped — the stopgap was
  code-only; the WS + 414 integration tests will simply pass once SP-2 lands).

## API / surface

No brust public-API change. Internally `io::TcpStream::into_inner()` exists on
both platforms. The fork adds `AsyncRead`/`AsyncWrite` to `tokio_uring`.

## File structure

```
(fork repo) AssetsArt/tokio-uring @ brust-0.5
  src/fs/statx.rs, src/io/statx.rs, src/fs/create_dir_all.rs   # cfg(gnu) gate
  src/net/tcp/stream.rs (+ new src/io/poll_compat.rs?)         # AsyncRead/AsyncWrite

crates/brust/Cargo.toml                 # tokio-uring → git fork
crates/brust/src/io/linux.rs            # into_inner() + 414 overflow signal
crates/brust/src/server.rs              # remove WS-on-linux cfg stopgap
package.json, .github/workflows/release.yml, npm/   # re-add musl (revert drop)
```

## Behavior / concurrency invariants

- The uring poll-IO adapter is **single-threaded** (tokio_uring current-thread
  runtime); no cross-thread sharing. One in-flight read + one in-flight write op
  at a time per stream (WS framing is half-duplex per direction) — the
  `pending_read`/`pending_write` slots enforce this; a second poll while an op
  is in flight re-polls the SAME stored op (does not submit a duplicate).
- The owned `write_staging`/read `Vec` give uring the stable buffer it requires
  (borrowed `poll_write` slices are copied in).
- `from_raw_socket` already-handshaked path (Role::Server, no client handshake)
  is unchanged; only the underlying stream type differs per platform.

## Tests

- **Fork:** a unit test (gnu + musl via CI cross or the box) that the crate
  compiles for `*-musl`; an echo test exercising `AsyncRead`/`AsyncWrite` over a
  loopback `TcpStream` on the box (write N bytes, read them back).
- **brust on the box (real io_uring):**
  - `cargo test --workspace` green on aarch64-gnu (baseline already green).
  - `cargo check --target aarch64-unknown-linux-musl` green (after fork).
  - `bun test tests/integration.test.ts` → **71/71** (the 5 WS tests + the 414
    test now pass). This is the acceptance gate, run on the box.
- **CI:** re-run the full matrix (gnu + re-added musl) green, incl. both
  `bun test` jobs.

## Acceptance criteria

1. `AssetsArt/tokio-uring@brust-0.5` exists; gnu builds unchanged; musl compiles.
2. brust builds on aarch64-gnu (box), x86_64-gnu (CI), and **musl** (cargo check
   ≥, full build in release).
3. `bun test tests/integration.test.ts` = **71/71** on the box (WS + 414 fixed).
4. `cargo test --workspace` + `clippy -D warnings` green for the linux-gnu target.
5. CI green on the full re-expanded matrix (no skipped/relaxed tests).
6. WS works end-to-end on Linux: handshake + text echo + binary + close codes
   (the 5 integration WS tests).
7. **No publish.** Stop at green; the user reviews before any tag.

## Non-goals

- Publishing (explicit: "ยังไม่ต้อง publish").
- Upstreaming the fork to tokio-rs (later, optional).
- `tokio_uring` `fs` features on musl beyond what compiles (statx stays
  gnu-only; brust doesn't use it).
- Windows (still unsupported).
- Performance tuning of the poll-IO adapter (correctness first; the WS path is
  not the hot RPS path — that's render/native).

## Known limitations (post-change)

- The uring AsyncRead/AsyncWrite adapter allocates an owned buffer per read/write
  op (no fixed-buffer reuse) — fine for WS message rates; a `register_buffers`
  optimization is a follow-up.
- musl `tokio_uring::fs::statx` is absent (gnu-only) — brust doesn't use it.

## Open questions resolved at plan time

- impl `AsyncRead`/`AsyncWrite` directly on `TcpStream` vs a wrapper returned by
  `into_inner()` (depends on whether `from_raw_socket` consumes the wrapper).
- Exact non-Linux 414 overflow signal to mirror (read `other.rs` + the
  `server.rs` 414 site during planning).
- Fork dep pinning: `branch` during dev → `rev` (commit pin) before the final
  green / any future publish.

## Scope note

Large + multi-repo (a `tokio-uring` fork + brust). Sequenced SP-1 → SP-2; SP-2's
WS re-enable depends on SP-1(b), musl re-add depends on SP-1(a). The real Linux
box is the test oracle — every Linux claim is validated there, not cross-checked.
```
