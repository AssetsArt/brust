# brust-core → brust-server port table
Source: github.com/AssetsArt/brust `main` @ d04718f, `crates/brust-core/src/`. Copied once (2026-10-09), owned by v2; `main` fixes are NOT auto-merged — re-port by hand and bump the SHA column.
| v2 module | source | treatment | tests (src → v2) |
|---|---|---|---|
| server/body.rs | server/body.rs | carry verbatim | 7 → 7 |
| server/tls.rs | server/tls.rs | carry verbatim | 4 → 4 |
| server/test_data/{cert,key}.pem | server/test_data/{cert,key}.pem | carry verbatim (tls test fixtures, `include_str!`) | — |
| server/cors.rs | server/cors.rs | carry verbatim | 20 → 20 |
| server/static_assets.rs | server/static_assets.rs | carry verbatim | 18 → 18 |
| http/compress.rs | http/compress.rs | carry verbatim | 5 → 5 |
| cache/key_expr.rs | cache/key_expr.rs | carry verbatim | 22 → 22 |
| config.rs CorsConfig | config.rs:27-78 | carry verbatim | 0 |
| (filled by Tasks 2–8: routes, l1, job_cache, pool, dispatch, render, config, server/mod) |
Not carried (spec S2): cache/island_cache.rs, render/stream.rs, realtime/*, routing/action.rs, `/_brust/islands`, `/_brust/page`, MCP, SSE/WS, AI, `handle_action`, `dispatch_streaming`, `spawn_chunk_pump`.
