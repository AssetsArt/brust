# Spec — A1.1: Bench machine-generated maud (single-core render throughput)

**Date:** 2026-05-28
**Branch:** `refactor/cargo-workspace`
**Parent:** `a48b9bd` (Phase A1 complete)
**Scope:** small — single bench binary + numbers + 1-page report

---

## 1. Goal

Quantify the **single-core render throughput** of machine-generated maud code (the output of `jsx-rust-compiler`) for the 3 A1 fixtures. Compare to known data points:

- `/ping` ceiling: **111,045 RPS** (architecture.md, N=5 median)
- Spike B (hand-written maud, no napi): **104,053 RPS**
- Current React-rendered `/`: **29,005 RPS**

The claim under test: machine-generated maud reaches within noise of hand-written maud — i.e. the compiler doesn't bottleneck the render path.

This bench measures **render-only** ns/op (no HTTP, no napi, no allocs from request handling). The implied single-core RPS = `1e9 / ns_per_render`. Real-server RPS will be lower because HTTP framing + response writing add per-request cost.

## 2. Non-goals

- Not a server benchmark. No HTTP, no Bun, no oha.
- Not a comparison vs React `renderToStaticMarkup` in JS — that's the Spike A territory already done.
- Not measuring `cargo bench` framework overhead — we use plain `std::time::Instant` to avoid criterion/iai noise + dep.

## 3. Design

Single binary: `crates/jsx-rust-compiler/src/bin/bench.rs`.

For each of the 3 fixtures:
1. Include the committed golden `.expected.rs` via `#[path = "../../fixtures/<name>.expected.rs"] mod <name>;`.
2. Construct a `Props` instance with representative data (same shape as `tests/golden_render/<name>.rs` uses).
3. Run N=5 trials × M renders each. M is sized so each trial runs ~200ms (gives stable timing without being slow). For ~1µs renders, M = 200_000.
4. Per trial: time the M renders, record ns/op.
5. Report: median, min, max across N=5 trials.

Use `into_string()` for each render — same path the integration tests exercise. Don't pre-allocate; that's a separate optimization.

**Black-box marker**: use `std::hint::black_box` on the result of each `render()` call so the optimizer can't elide the work.

**Build mode**: `--release` REQUIRED. The wrap-up specifies this. Debug-mode numbers are meaningless.

Output format (stdout, plain text — pastable into architecture.md):

```
jsx-rust-compiler bench (N=5 trials × M=200000 renders each, --release, M1 Pro)

fixture         median ns/op    implied RPS    range
static_hello    XXX             XXX            [min..max]
props_hello     XXX             XXX            [min..max]
list_nav        XXX             XXX            [min..max]
```

## 4. Implementation notes

- The fixtures use `Vec<ItemsItem>` for `list_nav` — keep `items.len() = 2` (matching the golden_render test) so the bench isn't dominated by loop iter count.
- `props_hello` uses non-trivial body `"Body <hi> & co"` exercising the 3-char escape path.
- `static_hello` is pure-text — measures the maud zero-cost compile-time-string path.

## 5. Acceptance criteria

1. `cargo build --release -p jsx-rust-compiler --bin jsx-bench` clean.
2. `cargo run --release -p jsx-rust-compiler --bin jsx-bench` runs to completion, prints per-fixture numbers, exit 0.
3. Numbers are pasted into `architecture.md` perf table OR a new section `Sub-project A1.1` with date + N=5 medians.
4. Workspace tests still green (143).

## 6. Risks

- **Maud's actual fast-path**: if maud generates allocation-heavy code, ns/op may be higher than expected. If results are > 5× slower than Spike B's hand-written maud (Spike B hand-maud at ~9µs/req-fullcycle → render-only should be < 2µs), investigate.
- **Black box overhead**: `std::hint::black_box` is supposed to be a no-op, but on some compilers it may force memory writes. Acceptable for a relative comparison.

## 7. Out of scope (acceptable deferrals)

- Comparison vs React render in same process — not portable, hard to set up.
- Multi-thread scaling — single-core is enough to answer the question.
- Different props sizes — A1 props are tiny; sizing study is A2 work when real loader data flows.

---

Done. Implementation up next.
