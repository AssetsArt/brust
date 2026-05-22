# Brust Skeleton — Design Spec

**Sub-project:** `skeleton` (sub-project 1 of Brust)
**Date:** 2026-05-23
**Status:** approved for implementation planning
**Parent design:** `/design.md`

---

## 1. Overview & Scope

### Goal

Prove the architecture described in `/design.md` works end-to-end at the
smallest meaningful size, before committing time to any feature work.

### Success criterion

> Running `cargo run` followed by `curl http://localhost:3000/` returns
> HTML rendered from a `<HelloWorld/>` React component via a Bun worker
> pool managed by a Rust supervisor.

### Concrete acceptance

```bash
$ cargo run &
2026-05-23T12:00:00 INFO brust: spawning 8 workers
2026-05-23T12:00:00 INFO brust: worker 0 ready (pid=12345)
...
2026-05-23T12:00:00 INFO brust: listening on 127.0.0.1:3000

$ curl -s http://localhost:3000/
<h1>Hello from Brust</h1><p>worker_id=3</p>

$ cargo test --test integration
test serves_rendered_html ... ok
```

The skeleton returns the raw rendered fragment as the HTTP body — no
`<!doctype>`, `<html>`, or `<head>` wrapper. The `build_document` wrapper
is deferred to a later sub-project (see Out of scope below).

### In scope

- pingora-core HTTP/1.1 listener on `:3000` (no TLS)
- `num_cpus()` Bun worker processes spawned at boot
- Persistent Unix socket per worker (`/tmp/brust-{id}.sock`); Bun listens, Rust connects
- Boot handshake: Bun receives `RouteRegistry` → replies `Ready` → only then listener opens
- HTTP request → least-busy worker (atomic counter) → render → response
- 1 route hardcoded in Bun (`/` → `<HelloWorld/>` component)
- Length-prefix JSON IPC framing (request and response)
- HTML body transferred over socket (no shm)
- 1 integration test spawning the full system + real HTTP via `reqwest`
- Shape A architecture: master-supervisor with explicit pool + `pick_least_busy`

### Out of scope (deferred to later sub-projects)

- Cache (LRU, vary headers, invalidation)
- Radix-tree router, multiple routes, param extraction
- `routes.tsx` parsing via TS AST
- Shared memory zero-copy IPC
- Single-binary embed (`bun --compile` + `include_bytes!`)
- Islands hydration (server stub + client bootstrap)
- Navigation `/_brust/page/*` JSON endpoint
- `build_document` wrapper + HTML minification
- CLI (`brust dev/build/start/invalidate`)
- TLS, keep-alive tuning, graceful reload
- Health checks, retry, worker respawn
- Streaming SSR
- Benchmark harness vs Astro / Bun.serve

### Effort estimate

~600 LOC Rust + ~150 LOC TypeScript, ~3–4 days.

---

## 2. Components

### Rust (single crate, flat `src/`)

```
brust/
├── Cargo.toml
├── src/
│   ├── main.rs           Boot orchestrator, SIGINT handler
│   ├── config.rs         Skeleton constants: PORT (env BRUST_PORT, default
│   │                     3000; `0` = ask OS for any free port), NUM_WORKERS
│   │                     (env BRUST_WORKERS, default num_cpus()), SOCKET_PATH
│   │                     pattern, BOOT_TIMEOUT_MS
│   ├── worker.rs         WorkerHandle: id, socket, in_flight counter, guard
│   ├── pool.rs           WorkerPool: pick_least_busy()
│   ├── ipc.rs            Frame enum, length-prefix encode/decode
│   ├── router.rs         RouteTable (HashMap<&str, RouteId> for skeleton)
│   ├── proxy.rs          handle_request: route → pick → send → recv → respond
│   └── listener.rs       pingora-core Service impl dispatching to proxy
└── tests/
    └── integration.rs    Spawn server, reqwest GET /, assert body
```

### Bun runtime (sibling JS source)

```
brust/runtime/
├── package.json
├── tsconfig.json
├── worker.ts             Bun.listen(unix), recv frame, dispatch, write reply
├── framer.ts             Length-prefix protocol (encode/decode)
├── queue.ts              SerialQueue: 1 in-flight render at a time
├── pages.ts              pages map: route_id → { component, loader }
└── components/
    └── HelloWorld.tsx    <h1>Hello from Brust</h1><p>worker_id={N}</p>
```

### Key Rust types

```rust
struct WorkerHandle {
    id: u32,
    socket: tokio::sync::Mutex<UnixStream>,
    in_flight: AtomicU32,
}

struct InFlightGuard<'a>(&'a AtomicU32);   // decrements on Drop

struct WorkerPool { workers: Vec<WorkerHandle> }

impl WorkerPool {
    fn pick_least_busy(&self) -> &WorkerHandle {
        self.workers
            .iter()
            .min_by_key(|w| w.in_flight.load(Ordering::Acquire))
            .expect("at least one worker")
    }
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
enum Frame {
    #[serde(rename = "route_registry")] RouteRegistry { routes: Vec<String> },
    #[serde(rename = "ready")]          Ready,
    #[serde(rename = "render")]         Render { route_id: u32, url: String },
    #[serde(rename = "render_ok")]      RenderOk { html: String },
    #[serde(rename = "render_err")]     RenderErr { message: String },
    #[serde(rename = "shutdown")]       Shutdown,
}
```

**Note:** Skeleton carries HTML inside the `RenderOk` JSON envelope. When
shm lands in a later sub-project, the protocol will gain a binary-body
variant; the JSON envelope continues to carry metadata.

---

## 3. Boot Sequence & Request Flow

### Boot sequence

```
T+0     read num_cpus() = N

T+0     for id in 0..N:
          rm -f /tmp/brust-{id}.sock
          spawn bun: Command::new("bun")
                     .args(["run", "runtime/worker.ts"])
                     .env("WORKER_ID", id.to_string())
                     .env("SOCKET_PATH", format!("/tmp/brust-{id}.sock"))
                     .spawn()
          store Child in supervisor

T+~0    Bun worker (each):
          read WORKER_ID, SOCKET_PATH
          pre-load pages.ts (eager import)
          Bun.listen({ unix: SOCKET_PATH })
          (process-level readiness is the listening socket itself;
           the protocol-level `Ready` frame is sent in response
           to RouteRegistry, see "Bun worker control-frame handling")

T+~50ms Rust: for id in 0..N (sequentially):
          poll-connect to /tmp/brust-{id}.sock
            retry every 10ms, give up after 100 retries (1s total)
          on give-up: child.try_wait() — if exited, dump child stderr
            (catches "Bun crashed before listening")
          send_frame(stream, Frame::RouteRegistry { routes: vec!["/"] })
          recv_frame(stream) — expect Frame::Ready
          push WorkerHandle into pool

T+~100ms WorkerPool ready → open pingora-core listener on :3000
         log "brust: listening on 127.0.0.1:3000"
```

### Request flow (per HTTP request)

```
1. pingora-core accepts on :3000
2. listener dispatches GET / → proxy::handle_request(req, pool, router)
3. handle_request:
     a. route_id = router.match_path("/")  →  Some(0)  (None → 404)
     b. worker = pool.pick_least_busy()
     c. let _guard = worker.in_flight_guard()    // ++ now, -- on drop
     d. let mut stream = worker.socket.lock().await
     e. send_frame(&mut *stream, Frame::Render { route_id: 0, url: "/" })
     f. match recv_frame(&mut *stream).await { ... }
     g. drop stream → release lock
     h. RenderOk → HTTP 200; RenderErr → HTTP 500
4. _guard drops → in_flight decremented
```

### Bun worker request handling

```
1. socket "data" event with chunk(s) of bytes
2. framer.push(chunk) — buffers, emits complete frames
3. queue.enqueue(async () => handle(socket, frame))
   (SerialQueue: at most one task runs at a time per worker)
4. handle(frame):
     match frame.type:
       "route_registry":
         a. store routes locally: routeIndex = new Map(routes.map((p,i) => [i, p]))
         b. send_frame(socket, Frame::Ready)
       "render":
         a. parse Frame::Render { route_id, url }
         b. page = pages.get(route_id)
         c. props = {} (skeleton: no loader)
         d. fragment = renderToString(<page.component workerId={WORKER_ID} />)
         e. send_frame(socket, Frame::RenderOk { html: fragment })
       "shutdown":
         close socket, exit 0
5. caught error in any handler → send_frame(socket, Frame::RenderErr { message })
   (worker stays alive on render error; only RouteRegistry-handshake errors are fatal)
```

The single `handle` function dispatches by frame type. RouteRegistry is
the only control frame received during boot (no Render arrives before
the listener opens, which only opens after every worker has acked Ready),
so the SerialQueue invariant holds for control frames as it does for
render frames.

### Sequence diagram (one request)

```
client       pingora     proxy         pool       worker(3)     bun
  │            │           │             │            │           │
  │── GET ────►│           │             │            │           │
  │            │── req ───►│             │            │           │
  │            │           │── pick ────►│            │           │
  │            │           │◄── w3 ──────│            │           │
  │            │           │── send Render ──────────►│           │
  │            │           │             │            │── frame ─►│
  │            │           │             │            │           │  renderToString
  │            │           │             │            │◄── html ──│
  │            │           │◄─ RenderOk ─────────────│            │
  │            │◄── resp ──│             │            │            │
  │◄── 200 ────│           │             │            │            │
```

---

## 4. IPC Wire Protocol

### Framing (both directions)

```
┌──────────────────────────┬──────────────────────────────┐
│   4 bytes (u32 LE)       │   N bytes UTF-8 JSON         │
│   payload length N       │   serde_json::to_vec(Frame)  │
└──────────────────────────┴──────────────────────────────┘
```

- **Endianness:** little-endian
- **Max payload:** 16 MB (framer rejects larger)
- **Encoding:** JSON (skeleton simplicity). Future sub-projects may
  switch to msgpack/postcard; protocol versioning lives in the `Frame`
  enum tag, not in a separate version field.

### TypeScript mirror (`runtime/framer.ts`)

```typescript
type Frame =
  | { type: "route_registry"; routes: string[] }
  | { type: "ready" }
  | { type: "render"; route_id: number; url: string }
  | { type: "render_ok"; html: string }
  | { type: "render_err"; message: string }
  | { type: "shutdown" }
```

Rust and TS definitions are hand-maintained in lockstep. Codegen
considered when the enum grows past ~10 variants.

### Example wire bytes

**Rust → Bun (Render frame):**

```
4B len:    \x1f\x00\x00\x00              # 31 bytes
31B body:  {"type":"render","route_id":0,"url":"/"}
```

**Bun → Rust (RenderOk frame):**

```
4B len:    \x39\x00\x00\x00              # 57 bytes
57B body:  {"type":"render_ok","html":"<h1>Hello from Brust</h1>"}
```

### Framer behaviour

**Encoder:**
1. `body = json.encode(frame)`
2. `len = body.length`
3. Write `u32_le(len)` then `body` (combined buffer / `writev` preferred)

**Streaming decoder:**
1. Maintain growing buffer
2. If buffer < 4 → wait
3. Read `len = u32_le(buf[0..4])`
4. If `len > 16 MB` → reject, close socket
5. If buffer < 4 + len → wait
6. Parse `buf[4..4+len]` as JSON → `Frame`
7. Drain buffer, emit frame, loop (may have multiple frames per read)

### Edge cases

| Case | Handling |
|---|---|
| Partial read mid-frame | Buffer + wait |
| Multiple frames in one read | Loop, emit all |
| `len == 0` | Reject as invalid JSON body |
| Invalid JSON in body | Bun side → `RenderErr`; Rust side → worker-fault exit |
| Frame > 16 MB | Reject + close socket |
| Socket EOF mid-frame | Worker crash → exit 1 (skeleton: no respawn) |

### Explicitly excluded

- Protocol version field (skeleton has one version)
- Checksum / magic bytes (Unix sockets are reliable)
- Compression
- Request-ID / correlation (1-in-flight invariant pairs frames by order)
- Heartbeat / ping (health checks are out of scope)

---

## 5. Error Handling

Skeleton **fails loud**. Every error path either logs and exits, or
returns a 500 to the client. No graceful degradation, no retry. Resilience
is the job of later sub-projects.

### Failure matrix

| Failure | Where caught | Action |
|---|---|---|
| `bun` not on PATH | `Command::spawn()` error | log install hint + exit 1 |
| Worker socket connect timeout (1 s) | boot loop | dump child stderr + exit 1 |
| Worker didn't reply `Ready` | boot `recv_frame` | log `actual` frame + exit 1 |
| Worker exits during boot | child status poll | dump stderr + exit 1 |
| Worker dies during request | `recv_frame` EOF | log + HTTP 502 + exit 1 |
| `renderToString` throws | try/catch in `worker.ts` | send `RenderErr`; worker survives |
| Frame > 16 MB (either side) | framer | close socket + exit 1 |
| Invalid JSON in frame body | framer | log + exit 1 |
| HTTP request to unknown path | router miss | direct 404 (no IPC) |
| SIGINT | tokio signal handler | close listener → `Shutdown` frames → wait 1s → kill stragglers → exit 0 |

### Skeleton handler shape

```rust
async fn handle_request(req: Request, pool: &WorkerPool, router: &RouteTable) -> Response {
    let route_id = match router.match_path(req.path()) {
        Some(id) => id,
        None => return Response::not_found(),
    };
    let worker = pool.pick_least_busy();
    let _guard = worker.in_flight_guard();
    let mut stream = worker.socket.lock().await;

    if let Err(e) = send_frame(&mut *stream, Frame::Render { route_id, url: req.path().into() }).await {
        tracing::error!(worker_id = worker.id, err = ?e, "send_frame failed");
        return Response::bad_gateway();
    }

    match recv_frame(&mut *stream).await {
        Ok(Frame::RenderOk { html })       => Response::ok(html),
        Ok(Frame::RenderErr { message })   => {
            tracing::warn!(worker_id = worker.id, message, "render error");
            Response::internal_error(message)
        }
        Ok(other) => {
            tracing::error!(worker_id = worker.id, ?other, "unexpected frame");
            Response::bad_gateway()
        }
        Err(e) => {
            tracing::error!(worker_id = worker.id, err = ?e, "recv_frame failed");
            std::process::exit(1);  // worker likely dead
        }
    }
}
```

### Logging

- `tracing` crate
- Default `RUST_LOG=brust=debug`
- Human-readable format (skeleton is dev-only)

---

## 6. Testing

### Approach

**Integration-test only**, per scope decision. No unit tests in skeleton —
the system is too small for unit-level mocking to pay back. Pure-logic
modules get unit tests when they grow real surface area in later
sub-projects.

### `tests/integration.rs`

```rust
use std::process::{Command, Stdio};
use std::time::Duration;

#[tokio::test]
async fn serves_rendered_html() {
    // 1. Spawn brust as a child process
    // NOTE: BRUST_PORT=0 (OS-assigned) is deferred — it requires pingora
    // bound-port readback which is out of skeleton scope. The test uses a
    // fixed port (38123) as a workaround; see "Known limitations" in §7.
    let mut child = Command::new(env!("CARGO_BIN_EXE_brust"))
        .env("BRUST_PORT", "38123")      // fixed port; BRUST_PORT=0 deferred
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())        // surface worker errors to test output
        .spawn()
        .expect("spawn brust");

    // 2. Read stdout line-by-line until we see the listening log;
    //    parse the port number out of it.
    let port = read_port_line(&mut child).expect("port log");

    // 3. Small grace period after listener opens
    tokio::time::sleep(Duration::from_millis(200)).await;

    // 4. Real HTTP round-trip
    let resp = reqwest::get(format!("http://127.0.0.1:{port}/"))
        .await
        .expect("GET /");
    assert_eq!(resp.status(), 200);

    let body = resp.text().await.expect("body");
    assert!(body.contains("Hello from Brust"), "got: {body}");
    assert!(body.contains("worker_id="), "got: {body}");

    // 5. Clean shutdown
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id() as i32),
        nix::sys::signal::Signal::SIGINT,
    ).expect("sigint");

    let status = tokio::task::spawn_blocking(move || child.wait())
        .await
        .unwrap()
        .expect("wait");
    assert!(status.success(), "brust exited non-zero: {status}");
}
```

### What this exercises

- Rust binary spawns N Bun workers
- Boot handshake (RouteRegistry / Ready) completes
- pingora-core listener opens, accepts HTTP/1.1
- Proxy picks a worker, sends frame, gets reply
- Bun renders React component, returns HTML
- HTTP response body matches expected fragment
- SIGINT triggers graceful shutdown (exit 0)

### Out of scope (test-side)

- Load / concurrent requests
- Multiple routes
- Worker crash mid-request
- Race: HTTP request before workers ready (mitigated by listener
  opening only *after* the handshake)

### Helpers used by the test

`read_port_line(child) -> Option<u16>` is a small test helper that takes
the child's piped stdout, reads it line-by-line via a `BufReader`, and
returns the port number parsed out of the first line matching
`listening on 127.0.0.1:{port}`. It blocks until that line appears or
stdout closes (treated as failure). Implementation is ~15 lines of
straightforward `BufRead::lines` + `str::strip_prefix`; lives in the
same `tests/integration.rs` file.

### Manual smoke test

```bash
cargo run
# In another terminal:
curl http://localhost:3000/
curl http://localhost:3000/notfound   # → 404
```

---

## 7. Build & Run

### Prerequisites

- macOS or Linux (developed on Darwin per current environment)
- Rust 1.85+ (edition 2024)
- Bun 1.1+ on `$PATH` (`bun --version` to verify)

### `Cargo.toml` additions

```toml
[dependencies]
pingora-core       = "0.4"
tokio              = { version = "1", features = ["rt-multi-thread", "macros", "net", "io-util", "process", "sync", "signal", "time"] }
serde              = { version = "1", features = ["derive"] }
serde_json         = "1"
tracing            = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
async-trait        = "0.1"
nix                = { version = "0.29", features = ["signal", "process"] }
num_cpus           = "1"

[dev-dependencies]
reqwest            = { version = "0.12", default-features = false, features = ["rustls-tls"] }
```

### `runtime/package.json`

```json
{
  "name": "brust-runtime",
  "type": "module",
  "dependencies": {
    "react":     "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react":     "^18.3.0",
    "@types/react-dom": "^18.3.0"
  }
}
```

One-time setup: `cd runtime && bun install`

### Run

```bash
$ cargo run
2026-05-23T12:00:00 INFO brust: spawning 8 workers
2026-05-23T12:00:00 INFO brust: worker 0 ready (pid=12345)
...
2026-05-23T12:00:00 INFO brust: listening on 127.0.0.1:3000
```

### Test

```bash
$ cargo test --test integration
test serves_rendered_html ... ok
```

### Final project layout

```
brust/
├── Cargo.toml
├── Cargo.lock
├── design.md                          (existing — architectural overview)
├── docs/superpowers/specs/
│   └── 2026-05-23-skeleton-design.md  (this document)
├── src/
│   ├── main.rs
│   ├── config.rs
│   ├── worker.rs
│   ├── pool.rs
│   ├── ipc.rs
│   ├── router.rs
│   ├── proxy.rs
│   └── listener.rs
├── tests/
│   └── integration.rs
└── runtime/
    ├── package.json
    ├── bun.lockb
    ├── tsconfig.json
    ├── worker.ts
    ├── framer.ts
    ├── queue.ts
    ├── pages.ts
    └── components/
        └── HelloWorld.tsx
```

### Known limitations

- **`BRUST_PORT=0` (OS-assigned port) is deferred.** Pingora does not
  expose the bound address after `run_server`, so the boot service cannot
  read back the actual port and print it to stdout. The integration test
  uses the fixed port `38123` (`BRUST_PORT=38123`) as a workaround.
  Implementing port readback requires either a pingora API addition or a
  pre-bind trick; deferred to a later sub-project.

### Deliberately not added yet

- `README.md` (`design.md` is the de facto project README for now)
- `LICENSE` (deferred to pre-public)
- CI config (deferred until multi-contributor)
- `Dockerfile` (single-binary deploy is the design goal; not a skeleton concern)

---

## Appendix — Decisions Log

Captured from the brainstorming session, in the order decided:

1. **Scope = C** (one route end-to-end). Not just IPC, not just render,
   not yet with benchmark harness. Smallest path that touches every
   architectural layer.
2. **Socket-only IPC**, no shm. Shm is an optimisation, validated in a
   later sub-project.
3. **Dev mode** (spawn system `bun`), no single-binary embed.
   Embed is a deploy story; defer to a later sub-project.
4. **Boot-time route discovery via control socket**, routes hardcoded
   in Bun. `routes.tsx` TS-AST parsing is its own sub-project.
5. **`num_cpus()` workers** from day 1. LB scaffolding goes in the
   skeleton — easier than retrofitting.
6. **Single crate**, flat module layout. Workspace split when the API
   stabilises, not before.
7. **Integration-test-only** + manual `curl`. One test that exercises
   the full system end-to-end.
8. **Shape A** (master-supervisor with explicit pool + `pick_least_busy`).
   Matches `design.md` directly; future sub-projects keep using the
   same `WorkerPool` abstraction.

### Open questions deferred to later

- Whether `pingora-core` is worth the dependency weight vs `tokio` +
  `hyper` directly (revisit after measurement, in a benchmark sub-project)
- N-slots-per-worker variant for loader-bound workloads
- Streaming SSR (`renderToPipeableStream`)
- Measured latency vs Astro and Bun-native baseline
