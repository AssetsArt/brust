# Research memo — can brust-server live in-process with Bun's Rust runtime?

task: `research-bun-inprocess-bridge` · author: Guetta (Researcher) · date: 2026-10-11 · docs-only, read-only research, **no benches run**.

**Bun tree inspected:** `~/code/bun` detached at `origin/main` @ `6c1eb067e3` (2026-10-10). 1,647 `.rs`, 0 `.zig` under `src/`, 104 `Cargo.toml`, 561 `.c/.cpp` under `src/jsc/bindings`. The only released Rust-era tag is `bun-v1.4.3` (2026-10-09); `v1.3.14` (2026-05-12) is Zig. Our pinned compiler rev `620b50f6` is 13 commits behind that head.
All `path:line` below are in that checkout unless prefixed `brust:`.

Legend: **[C]** confirmed by reading code · **[I]** inferred/derived (reasoning shown) · **[T]** taken from the task brief or ATTRIBUTION, not re-measured.

## 0. Verdict (details in §6)

**NOT-YET** (leaning NO-GO for "link brust-server into Bun's binary").

- Bun gives no supported way for foreign native code to run on the isolate thread with access to the Rust/C++ host layer. The dynamic export list is napi/uv/v8 only. The JSC/host layer is reachable only by being **inside** Bun's own link. [C]
- Doing that means forking/overlaying Bun's whole build (561 C++ files + prebuilt WebKit + nightly Rust + a replacement `main`). The patch surface is order(s) of magnitude beyond our 44-line HIR patch. [C/I]
- The attainable gain is bounded by ~+19% single-connection latency on D and ~+26% on I; at concurrency the single-isolate-thread constraint can make throughput **worse** unless multiplied by N isolates. [I from ATTRIBUTION]
- There is one cheap, non-forking path worth a throwaway spike *later* (§5.3, an "inverted pump" built on the already-exported napi surface). It is unproven; the trigger table in §6 says when to run it.

## 1. Embedding surface (Q1)

### 1.1 Bun is not a library [C]
- The crate graph root is `bun_runtime` (`src/runtime/Cargo.toml` `[lib]`, header comment: "No crate is a 'final' Rust artifact"). Every crate is an rlib; the final link is Bun's own ninja edge that takes the rlibs **beside the C/C++ objects** (`scripts/build/rust.ts:1-31`).
- `main` is a `#[no_mangle] extern "C"` function inside that lib crate (`src/runtime/bin_entry/mod.rs:161`), ending in `Cli::start()` then `Global::exit(0)`. There is no `crate-type = ["staticlib"|"cdylib"]` anywhere that yields a linkable runtime (grep of all `Cargo.toml`: none for runtime; `rust.ts:473-499` states "`bun_runtime` is a staticlib with no link step … No target cdylib exists today").
- Consequence: a foreign program cannot "link libbun". Any crate that uses `bun_jsc` needs the C++ `Bun__*`/`JSC__*` shims (e.g. `Bun__JSValue__call` is defined in `src/jsc/bindings/bindings.cpp:3289` and declared `extern "C"` from `src/jsc/JSValue.rs:1725`), which in turn need WebKit (`scripts/build/deps/webkit.ts:6`, prebuilt `oven-sh/WebKit` tarball keyed by commit `0c06faad…`).
- `bun_jsc` cannot even boot a VM alone: it deliberately leaves high-tier pieces to `bun_runtime` via link-time hooks (`src/runtime/jsc_hooks.rs:1-20`: `RuntimeHooks`, `__bun_transpile_source_code`, `Bun__transpileFile`…). `VirtualMachine::init` (`src/jsc/VirtualMachine.rs:3100`) therefore needs `bun_runtime` linked in. A third-party crate **cannot own a `JSGlobalObject`/VM** without also pulling `bun_runtime` (→ ~everything) and supplying its own `main` (the symbol `main` is already taken by `bin_entry`). [C]

### 1.2 What is exported to dlopen'd native code [C]
- Link uses `--export-dynamic-symbol-list` from a version script and explicitly "Not `-rdynamic`" (`scripts/build/flags.ts:1453-1459`). The `global:` block is `napi*; node_api_*; node_module_register; uv_*; v8 mangled names` (`src/linker.lds:1-8`, `src/symbols.txt`: 684 lines, 0 `Bun__*`).
- So a `cdylib` loaded with `process.dlopen`/`bun:ffi` **cannot** call `Bun__JSValue__call`, `JSValue::put`, etc. Its only JS-facing API is napi (and v8 shims). That is exactly what brust-napi uses today.

### 1.3 `bun:ffi` `JSCallback` and threading [C]
- Implemented in C++ (`src/jsc/bindings/JSCFFIBridge.cpp`, created via `Bun__CreateJSCFFICallback`, `src/runtime/ffi/ffi_body.rs:1288-1300`).
- **Non-threadsafe callback** (default): a JIT/TinyCC stub that calls the JS function **synchronously on the calling thread, which must be the isolate thread**; the return value is used. (docs: `docs/runtime/ffi.mdx:306-336`.)
- **`threadsafe: true`** (experimental): arguments copied on the calling thread, invocation is **posted** to the owning script context (`JSCFFIBridge.cpp:62` `ScriptExecutionContext::postTaskTo(..., BunLoopKind::Regular, …)`; throws "no script execution context" if absent, line ~104). Return value to C is **unspecified** (`ffi.mdx:338-346`). So it is an async post, equivalent in shape to napi tsfn, not a sync RPC.
- JS→native direction: `dlopen` symbol calls are compiled "down to direct native calls" through DFG/FTL (`ffi.mdx:52`). That direction is cheap; it is the native→JS direction on a *different* thread that is expensive. Our cost is the latter.

### 1.4 Could a Rust runtime crate host a hyper server on the isolate thread, or an isolate on a hyper thread? [C+I]
- Bun's own `Bun.serve` is the existing "HTTP on the isolate thread" design: uWebSockets (`uws_sys`) + the VM event loop, calling the JS handler inline (`src/runtime/server/mod.rs:1136-1176`, `on_request` → `on_request.call(global, js_value, &[req, server])`, no thread hop). [C]
- Isolate on a non-main thread: Bun Workers do this (each has its own VM/loop). A VM is created per thread via `VirtualMachine::init` (`VirtualMachine.rs:3100`); it is not shareable across threads (`JsThread` token is `!Send`, `src/jsc/job.rs:35-42`). [C]
- Neither gives *hyper* on the isolate thread: hyper/tokio would need to be driven by Bun's loop (§5). On posix an addon has **no loop handle**: `napi_get_uv_event_loop` returns Bun's own `EventLoop*`, "there is no uv event loop on posix" (`src/runtime/napi/napi_body.rs:2385-2392`), and the exported `uv_poll_init`, `uv_async_init` are stubs that throw `not_implemented` (`src/jsc/bindings/uv-posix-stubs.c:1261-1271`, `:14-22`). [C]

## 2. Calling JS from Rust on the isolate thread (Q2)

### 2.1 Primitives [C]
| need | Rust API | where | underlying |
|---|---|---|---|
| call function | `JSValue::call(global, this, &[JSValue])` → `JsResult<JSValue>` | `src/jsc/JSValue.rs:1718` | `Bun__JSValue__call` (`bindings.cpp:3289`): stop-check, AsyncContextFrame unwrap, `MarkedArgumentBuffer` fill, JSC `call`, exception scope |
| exception-checked wrapper | `from_js_host_call` | `src/jsc/host_fn.rs:717` | `call_zero_is_throw` |
| make a host function | `JSFunction::create` | `src/jsc/JSFunction.rs:57` | `JSFunction__createFromZig` |
| continue on promise settle | `JSValue::then / then2` (resolve+reject host fns with ctx) | `JSValue.rs:109-183` | `JSC__JSValue___then` |
| block-until-settled (nested loop) | `EventLoop::wait_for_promise` | `src/jsc/event_loop.rs:1129` | spins the loop; used by Bun for startup, not per request |
| microtask drain | `drain_microtasks[_with_global]` | `event_loop.rs:402-460` | `JSC__JSGlobalObject__drainMicrotasks` + deferred tasks |

### 2.2 How a request is served inside Bun (the in-process reference design) [C]
`NewServer::on_request` (`server/mod.rs:1136`): enter event-loop scope without checkpoint → `on_request.call(...)` → `handle_request` (`:1084`) inspects the returned value; if it is a Promise it registers `to_async` and returns to the loop; resolution arrives later as a normal microtask/`then` callback on the same thread. So **awaiting never leaves the thread**; it is "return to the event loop, get called back".

### 2.3 Microtasks are the catch for foreign callers [C]
`napi_call_function` (`src/jsc/bindings/napi.cpp:3247-3292`) calls `AsyncContextFrame::call` and **does not drain microtasks** (no `drainMicrotasks` in napi.cpp or napi.h). Microtask checkpoints belong to Bun's event-loop `enter/exit`. A native loop that calls JS and never returns to Bun's loop will run sync handlers fine, but `await` continuations never run. The tsfn path avoids this because the dispatch runs inside the loop and drains between calls (`napi_body.rs` `dispatch_one` doc: "microtasks one call queued are drained before the next call"). [C]

### 2.4 Costs [I, no bench allowed]
- No Bun micro-benchmark for native→JS call cost exists in the tree that I could find (`bench/ffi` compares JS→native `bun:ffi` vs napi only; `bench/ffi/bun.js:1-40`). I did not run it.
- From the code path: stop-check + `MarkedArgumentBuffer` + JSC call + exception scope. This is the same machinery `Bun.serve` pays per request. Order of magnitude: hundreds of ns for the call itself plus the cost of the JS function body. This is an estimate to be replaced by a measurement in any follow-up spike.
- A comment in `drain_microtasks_with_global` records Bun's own per-request accounting ("~2×/request", `event_loop.rs:408-413`), so the drain is on Bun's hot path and is cheap.

## 3. Values without JSON (Q3)

### 3.1 Yes, both directions, with real JSC values [C]
- Objects/arrays: `JSValue::create_empty_object(global, len)` (`JSValue.rs:517`), `create_empty_array` (`:536`), `put(global, key, value)` (`:1449`), `put_index` (`:1529`), `JSObject::put_record` (`JSObject.rs:188`).
- Strings: `bun_string_jsc::create_utf8_for_js` (`bun_string_jsc.rs:153`), `owned_utf8_into_js` (`:167`, takes a `Vec<u8>`), latin1/utf16 variants (`:192`, `:202`).
- Bytes: `JSUint8Array::from_bytes` (takes `Box<[u8]>`, ownership moves into JSC, `JSUint8Array.rs:15`), `from_bytes_copy` (`:25`), `ArrayBuffer::create_*` (`array_buffer.rs:309-335`). Typed arrays can wrap Rust memory (`ArrayBuffer::from_owned_bytes`, `array_buffer.rs:414`).
- Reading back: property `get`/`get_truthy` (used throughout, e.g. `ffi_body.rs:1759`), `ArrayBuffer::from_typed_array` (`array_buffer.rs:363`) gives a `&[u8]` view of JS memory with no copy (valid while the value is alive/unmoved on that thread).
- Every one of these is a C++ shim call (`extern "C"` into JSC), so each field costs one FFI + JSC property op (tens of ns each [I]); there is no bulk "struct to JS object" fast path.

### 3.2 What Bun itself does for request objects [C]
`prepare_js_request_context` builds a native `Request` (Rust struct) wrapped as a JS cell with lazy getters (`server/mod.rs` `PreparedRequest`, `CreateJsRequest::Yes`); headers/URL are materialised on access. Bun avoids creating plain objects per field; it hands JS an opaque native-backed object. This is the model to copy if brust ever goes in-process: expose a native-backed `Request` and let the loader read only what it touches. (That would also cut the loader-request side of our JSON.)

### 3.3 Relevance to ATTRIBUTION [I]
The loader-response parse (81 µs, 16% of D, `brust: bench/ATTRIBUTION.md` "After P7") is a Rust-side read of a JSON-encoded response. In-process, the same data could be left as JS objects and read field-by-field, or the handler could return a native-backed template-data object. Savings depend on response shape (many small `get`s can lose to one `from_str` on large payloads); **not estimable without the actual payloads**. Treat the 81 µs as an upper bound on what is removable.

## 4. Build and maintenance cost (Q4)

### 4.1 What brust-server would have to link [C]
Crates that form the runtime: `bun_runtime` (root) → `bun_jsc` → `bun_event_loop`, `bun_uws(_sys)`, `bun_http(_jsc)`, `bun_install`, `bun_bundler(_jsc)`, `bun_resolver`, `bun_sys`, … (`src/runtime/Cargo.toml` lists ~60 workspace deps; 104 Cargo manifests in `src/`). Non-Rust: 561 C/C++ files in `src/jsc/bindings`, ~25 C/C++ dependency recipes in `scripts/build/deps` (boringssl, libuv, lshpack, lsquic, mimalloc, sqlite, tinycc, zstd…), and **prebuilt oven-sh/WebKit** (`webkit.ts:6`, ICU bundled on linux/windows).
Toolchain: Bun's pinned nightly (`rust-toolchain.toml` → `nightly-2026-09-15`) and Bun's own ninja/cmake-free build driven by `scripts/build/*.ts` (cargo plans, ninja executes, `-Zbuild-std`; `rust.ts:1-31`). There is no Cargo-only way to produce the final binary. [C]
The link spike (brust: `docs/design/2026-10-08-bun-crate-link-spike.md`) worked precisely because `bun_js_parser`/`bun_ast`/`bun_react_compiler` do **not** need C++ or WebKit; it still needed `BUN_CODEGEN_DIR`, a hand-written `build_options.rs`, `native.rs` plus 8 stubs, and a 44-line HIR patch. [per memory/spike]

### 4.2 Stability across Bun releases [C+I]
- Only one Rust-era release exists (`v1.4.3`, 2026-10-09). Between `v1.3.14` (Zig, May) and now the whole tree was ported, so the June-vs-now comparison is meaningless as a stability signal (`src/jsc` diff vs the 2026-06-04 checkout: 1,369 files, +102k/−195k).
- Recent velocity: 13 commits between our pin `620b50f6` (2026-10-08) and head (2026-10-10), touching 910 files overall (+31.5k/−7.1k) but only 3 files in `src/jsc/*.rs` (JSValue.rs, VirtualMachine.rs, rare_data.rs; 271+/174−) and none in `js_parser`/`ast`/`react_compiler`/`runtime/napi`. So the parser/compiler crates we already depend on are currently quiet, and `bun_jsc` is moderately active.
- No stability promise: these are internal crates, `pub` means "another crate imports it" (`Cargo.toml` lint comment ~line 121), the host-fn ABI carries `// TODO`s about cycles (`src/jsc/Cargo.toml` "TODO(b1): bun_http_jsc has a forward-dep on bun_jsc"). Expect breakage on every release for a consumer. [C/I]

### 4.3 Patch-surface growth [I]
Today: 1 patch, 44 lines, in a leaf crate with no C++ deps. In-process runtime would need, at minimum: (a) a replacement/extension of `bin_entry::main` or a hook in `Cli::start` to start brust (the one `main` symbol is taken); (b) a build-system overlay that adds our crate to `linkedRlibs` (`scripts/build/rust/units.ts`) and pins WebKit; (c) tracking `bun_jsc`/`event_loop`/`uws_sys` signature churn each bump; (d) CI for the 5+ OS/arch targets Bun supports, because we would be shipping *a Bun binary*, not an addon. That inverts our distribution model (users run their own Bun; brust is an npm package). Estimated order: thousands of lines of build glue plus a standing rebase burden, versus 44 lines today. [I]

## 5. Architecture shapes considered

### 5.1 Shape A — "brust as a Bun fork/overlay" (best technically, worst operationally)
```
 Bun-built binary (our fork of the ninja link)
  main = brust_main -> Cli::start()      ; one process
  isolate thread (JSC VM, bun_jsc)       ; N Bun Workers = N isolates
     └ Rust: uws/hyper accept+parse  ──►  JSValue::call(loader, native Request)   (no tsfn, no JSON)
              ◄── Promise: then(resolve=render_host_fn)  (stays on thread)
     render (minijinja) runs on the isolate thread or is posted to a Rust pool
```
Gain: removes the hop and (partly) the JSON. Cost: everything in §4. Requires owning release engineering of a Bun binary. **Rejected for now.**

### 5.2 Shape B — "Bun.serve is the server, brust-core is a library" (no fork)
Bun's own uWS server on the isolate thread; brust-core called synchronously from the fetch handler via napi/`bun:ffi` (JS→native is cheap, §1.3). Removes the hop entirely. But: Bun.serve is one thread per process, so brust's multi-core native L1-hit path (S: 22.7 µs CPU/req at 114k rps, ATTRIBUTION "S c=120") would run through a JS handler on one core, unless static `routes` are used. Likely a throughput regression for S/I; a latency win for D. **A different product (it changes the server), not a bridge optimisation.** Out of scope; noted so nobody re-derives it.

### 5.3 Shape C — "inverted pump" (no fork, unproven)
Keep hyper on a Rust-owned thread **or** a current-thread runtime inside a Bun Worker; expose `pump()` through napi, called from JS when an fd the Rust side owns (its epoll/kqueue fd) becomes readable in Bun's loop. In pump, Rust handles ready connections and calls the loader synchronously via `napi_call_function` (§2.3: sync works; promises resume because control returns to Bun's loop right after). Needs a way to make Bun's loop watch a foreign fd. Candidate: adopt it as a socket (`net.Socket({fd})` goes through `src/js/node/net.ts:1965-2052`); epoll/kqueue fds are not stream sockets, so this is **unverified and may be rejected by uSockets** [I]. Alternative: a pipe/eventfd written by the Rust I/O thread → that is just the current tsfn hop again.
Verdict: possible spike, no evidence yet. What it would test: does a loop-integrated fd wake path beat tsfn's wake (`napi_body.rs` tsfn enqueue + loop wakeup)?

**F84 probe (2026-10-12, Bun 1.4.3, macOS 26.6.2 arm64): NO-GO.** Linux was not available on this host; a Linux epoll run was not done (and is not worth a row, see the second blocker below). Probe code is throwaway (scratchpad, not committed): a C dylib (kqueue/pipe/socketpair/foreign thread) driven through `bun:ffi`.
- **(b) controls.** `new net.Socket({ fd })` adopts nothing: `_handle` stays unset, no event ever fires (`src/js/node/net.ts:2023-2052`, "network-socket fds are not supported"). `net.connect({ fd })` on a **socketpair** end wakes on a foreign-thread write (`data`, ~2 ms first sample) and `Bun.connect({ fd })` on a socketpair wakes (~0.4 ms first sample). The same on a **pipe** read end fails: `net.connect` errors `ENOTSOCK … read`, `Bun.connect` opens then closes with no data. So `{fd}` adoption works only for real sockets.
- **(a) kqueue fd.** Both `net.connect({ fd: kq })` and `Bun.connect({ fd: kq })` fail immediately with `Failed to connect`, for a kqueue watching a pipe and for an `EVFILT_USER` kqueue, so nothing is polled and nothing wakes. Two independent blockers, both confirmed: (1) `us_socket_from_fd` registers the fd for READABLE **and** WRITABLE (`packages/bun-usockets/src/socket.c:426`) and returns 0 on `us_poll_start_rc` failure; on macOS a kqueue fd refuses `EVFILT_WRITE` (a 20-line C check: `EV_ADD` of `EVFILT_WRITE` on a kqueue fd comes back `EV_ERROR`, `data=22` EINVAL, while `EVFILT_READ` is accepted). That failure is the likely source of the error text; I did not trace it through to the JS rejection. (2) Even if registered, Bun's socket read path is `recv`, and a kqueue/epoll fd is not a socket (`read(kq)` returns ENXIO on macOS; the pipe control above fails with ENOTSOCK in the same way).
- **(c) foreign-thread wake.** A `bun:ffi` `JSCallback` with `threadsafe: true` fired from a foreign thread wakes an idle loop that is parked on a timer (first sample 0.7 ms) but does **not** keep the process alive: with no timer the script exits before the callback runs. A non-`threadsafe` `JSCallback` called from a foreign thread does nothing observable (no wake, no output). Steady state (3000 kicks from a spinning foreign thread into an idle loop, host not locked, shared with other lanes, so illustrative only): `JSCallback` threadsafe p50 0.153 ms / p90 3.9 ms; socketpair doorbell p50 0.159 ms / p90 4.8 ms. The two wake paths are indistinguishable at the median.
- **What this means for Shape C.** The pump needs Bun's loop to watch the Rust side's epoll/kqueue fd directly. It cannot. The only fd route that works is a socketpair "doorbell" written by a relay thread that blocks on the epoll/kqueue fd, and that is a thread hop with the same wake cost as the current tsfn (and as threadsafe `JSCallback`). Shape C therefore buys no wake saving; what remains of it is the synchronous `napi_call_function` call, which is already available to the current design. Shape C is closed on this evidence; reopen only on the posix event-loop-hook trigger in §6.3.

### 5.4 Cheaper lever inside the current shape [C+I]
tsfn dispatch already batches: one loop tick runs all queued calls, no per-tick cap, microtasks drained between calls (`napi_body.rs` `dispatch_one`, comment "Node sets a maximum … We don't set a max"). So the 14.6 µs figure measured at **c=1** (ATTRIBUTION) is the *un-amortised* hop; at c=120 the wake/schedule part is shared across queued calls. Any in-process gain at high concurrency is therefore smaller than the c=1 numbers suggest, while the JSON/parse part stays per request. A spike should split "wake cost" from "JSON cost" first (they have different fixes: the JSON part is addressable inside the current shape).

## 6. Estimate, risks, recommendation

### 6.1 Attainable gain against ATTRIBUTION (updated 2026-10-12 with the F83 measured split)
Inputs are now measured (`bench/ATTRIBUTION.md` "F83 split (2026-10-12)", medians of 3, c=1, `beta1` @ffe84ad). The bridge is **wake only**: D 15.1 µs (out 8.5 + back 6.8), I 14.2 µs (out 8.8 + back 5.4). The JSON envelope is outside the bridge.
- I (e2e 67.3 µs): wake 14.2 µs = 21%, whole JSON envelope 3.5 µs = 5%. Removing the hop → **≤ +26% rps at c=1** (unchanged); building a request object and calling in-thread costs ≥1–3 µs [I], so realistic ≈ +18–22%.
- D (e2e 485 µs): wake 15.3 µs = 3.2%. The big share is the response JSON round trip: `JSON.stringify` 23.0 + serde parse 76.1 (read/`from_utf8` 1.0) = ~101 µs = 20.9%. That is payload encoding, **addressable without an in-process bridge** (lazy/tape `Node`, binary encoding; ATTRIBUTION E3). An in-process bridge alone gains ≤ +3% on D; it reaches ~+32% only if it also removes the JSON round trip at no field-read cost, which §3.3 says is unproven.
- c=120 throughput: today HTTP I/O (S ≈ 22.7 µs CPU/req) lives on hyper threads, JS handler ≈ 5.9 µs/req (I). Same-thread merges them onto one isolate thread: ≈ 28.6 µs/req ⇒ **≈ 35k rps per isolate** versus 105k today, so Shape A needs ≥3 isolates (Workers, `SO_REUSEPORT`) just to break even, with each isolate's memory/startup cost. [I derived from ATTRIBUTION rows; ignoring render which already runs off the JS thread in some probes]. Net high-concurrency gain is likely small or negative; the benefit concentrates in low-concurrency latency.

### 6.2 Risks
1. Fork/overlay of Bun's build: release engineering, 5+ targets, nightly Rust pin that moves (see `docs/design/bun-rev-bump.md`). High.
2. Internal API churn with no stability promise; one Rust-era release only. High.
3. Distribution model inversion (we would ship a runtime). High.
4. Isolate-thread serialisation reduces multi-core scaling; needs worker-per-core. Medium.
5. Microtask/exception semantics when calling JS from foreign loops (§2.3). Medium for Shape C, solved by construction in A.
6. GC safety: `JSValue` held across `await`/ticks must be protected (`JSValue::protect`, `Strong`); a new class of bugs vs our JSON boundary. Medium.

### 6.3 Recommendation: **NOT-YET**
Do not start Shape A. Trigger table (any one flips it to a spike, two to GO-planning):

| trigger | how to observe |
|---|---|
| Bun publishes an embedding/extension crate or a stable export list for the host layer (a `Bun__*`/JSC API in `linker.lds`'s `global:`) | `src/linker.lds`, `scripts/build/flags.ts` export list; release notes |
| posix addons get an event-loop hook (`uv_poll_init`/`uv_async_init` implemented, or `napi_get_uv_event_loop` returns a pollable handle) | `src/jsc/bindings/uv-posix-stubs.c` loses `__bun_throw_not_implemented` for those |
| ≥ 2 further Rust-era Bun releases with `src/jsc` public signatures unchanged | `git diff <tag>..<tag> -- src/jsc/*.rs` |
| a throwaway measurement shows the JSON/parse share (not the wake share) is ≥ 15% of D at realistic payloads | **MET 2026-10-12 (F83): 20.9% of D e2e** — but it is payload encoding, so the action is a current-shape lever (lazy/tape `Node`, E3), not an in-process bridge; it does not by itself flip the verdict |

### 6.4 Suggested follow-ups (not started, need lead call)
1. ~~**S1 (measure only)**~~ **DONE 2026-10-12 (F83):** bridge = wake 8.5 + 6.8 µs (D) / 8.8 + 5.4 µs (I); loader-response = read 1.0 + parse 76.1 µs (D). See §6.1 and `bench/ATTRIBUTION.md` "F83 split". Consequence for the trigger table: the D JSON share (20.9%) is real but fixable in the current shape; the in-process-specific prize is the ~14 µs wake (21% of I, 3% of D).
2. ~~**S2 (5.3 feasibility)**~~ **DONE 2026-10-12 (F84): NO-GO.** Bun's loop cannot watch a kqueue/epoll fd (§5.3); only the posix event-loop-hook trigger in §6.3 reopens it.
3. Re-run this memo's §1.2 and §4.2 greps on each Bun bump; they are the cheapest early-warning for the trigger table.

## 7. Evidence index (for challenge)
- Build shape: `scripts/build/rust.ts:1-31, 473-499`; `src/runtime/Cargo.toml` `[lib]`; `src/runtime/bin_entry/mod.rs:161`.
- Exports: `scripts/build/flags.ts:1453-1459`; `src/linker.lds:1-8`; `src/symbols.txt` (0 `Bun__`).
- Hooks/VM: `src/runtime/jsc_hooks.rs:1-20`; `src/jsc/VirtualMachine.rs:3100`; `src/jsc/job.rs:35-42`.
- Call path: `src/jsc/JSValue.rs:1718`; `src/jsc/bindings/bindings.cpp:3289`; `src/jsc/host_fn.rs:717`; `src/runtime/server/mod.rs:1084,1136`.
- Promise/loop: `src/jsc/JSValue.rs:109-183`; `src/jsc/event_loop.rs:402,1129`.
- Values: `src/jsc/JSValue.rs:517,536,1449,1529`; `src/jsc/bun_string_jsc.rs:153,167`; `src/jsc/JSUint8Array.rs:15,25`; `src/jsc/array_buffer.rs:309,363,414`.
- napi: `src/jsc/bindings/napi.cpp:3247`; `src/runtime/napi/napi_body.rs:2375-2392, 2536+, dispatch_one`; `src/jsc/bindings/uv-posix-stubs.c:14,1261`.
- ffi: `src/jsc/bindings/JSCFFIBridge.cpp:62,76,101`; `src/runtime/ffi/ffi_body.rs:1288-1300`; `docs/runtime/ffi.mdx:52,306-346`.
- Churn: `git rev-list --count 620b50f6..origin/main` = 13; `git diff --shortstat 620b50f6 origin/main -- src/jsc` = 31 files +271/−174; tags: `git tag --sort=-creatordate`.
- brust side: `bench/ATTRIBUTION.md` "After P7" (bridge 14.6 µs/21% on I; parse 81 µs/16% on D; S 22.7 µs CPU/req; I JS handler 5.88 µs); `docs/design/2026-10-08-bun-crate-link-spike.md`.

### Not verified (honest list)
- nylon-ring numbers (40 ns unary, 1.9 ns FFI) are from the brief [T]; not checked.
- All µs estimates for in-process calls are reasoning, not measurements.
- Whether `net.Socket({fd})` accepts an epoll/kqueue fd (S2).
- I did not read `uws_sys`/`event_loop` internals beyond what the cited call sites show; the wake mechanism of tsfn enqueue was inferred from the struct fields and the `dispatch_one` loop, not traced to the syscall.
