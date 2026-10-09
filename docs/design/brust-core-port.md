# brust-core → brust-server port table
Source: github.com/AssetsArt/brust `main` @ d04718f, `crates/brust-core/src/`. Copied once (2026-10-09), owned by v2; `main` fixes are NOT auto-merged — re-port by hand and bump the SHA column.
| v2 module | source | treatment | tests (src → v2) |
|---|---|---|---|
| server/body.rs | server/body.rs | carry verbatim (+ item-level `#[allow(dead_code)]` "kept for parity" on `channel_body`, `response_from_framed_bytes`, `error_400/411/413/415`, unused by v2) | 7 → 7 |
| server/tls.rs | server/tls.rs | carry verbatim | 4 → 4 |
| server/test_data/{cert,key}.pem | server/test_data/{cert,key}.pem | carry verbatim (tls test fixtures, `include_str!`) | — |
| server/cors.rs | server/cors.rs | carry verbatim | 20 → 20 |
| server/static_assets.rs | server/static_assets.rs | carry verbatim | 18 → 18 |
| http/compress.rs | http/compress.rs | carry verbatim | 5 → 5 |
| cache/key_expr.rs | cache/key_expr.rs | carry verbatim | 22 → 22 |
| config.rs CorsConfig | config.rs:27-78 | carry verbatim | 0 |
| routing/routes.rs | routing/routes.rs:1-631 | adapt: RouteConfig from manifest (`RouteTable::from_manifest`, `route_index`), `cache` typed as `manifest::RouteCache`, envelopes reduced to one `RouteEnvelope` (no `kind`/`nativeTemplate`/`bypassed`) whose `req` is the loader's | 45 → 30 (16 dropped with action/mcp/sse/ws/native-template/rewrite, 1 added) |
| cache/l1.rs | cache/response_cache.rs + server/mod.rs:1787-1798,1817-1824 (`build_cache_key`, `sort_query`) | adapt: value = JSON ctx; `invalidate_tags` returns count; tag index generation-guarded (a replace/evict of an old value no longer un-indexes the newer one) | 10 → 12 (+`build_cache_key_sorts_query_and_applies_prefix` moved from server/mod.rs:1888-1894, +`reinsert_keeps_newer_entry_tag_indexed`) |
| cache/job_cache.rs | cache/page_cache.rs | adapt: typed key, Expiry, stats; JSON value; generation-guarded tag index shared with l1 | 9 → 12 (+`ttl_none_survives_until_invalidated`, `stats_count_hits_and_misses`, `reinsert_keeps_newer_entry_tag_indexed`) |
| pool.rs | render/pool.rs | carry verbatim (`use` path → `crate::dispatch`; + `WorkerEntry::id()`) | 14 → 14 |
| dispatch.rs | render/dispatch.rs + server/mod.rs:1262-1371 | adapt: CallKind, JSON response, claim_or_wait(timeout), `call_worker` (framed decode :1373-1404 and `process::exit` on last worker not carried); module doc :1-21 verbatim | 3 → 8 (+`call_worker_round_trips_json`, `call_worker_returns_bad_response_on_len_over_capacity`, `claim_or_wait_times_out_when_all_busy`, `claim_or_wait_wakes_when_claim_released`, `call_worker_keeps_slot_claimed_after_caller_drops`) |
| protocol.rs | — (spec §1 S1 call table) | new: Loader/Jobs request+response structs | 0 → 9 |
| tests/common/fake_bun.rs | render/dispatch.rs:107-165 (`MockDispatch` pattern) | new: `FakeBun` + `FakeBunHandle` test double (records last request per kind) | proven by tests/fake_bun.rs (2) |
| render.rs | template/jinja.rs | adapt: owned env from manifest, no globals, no dynamic tier | 4 → 1 (+9 integration) |
| server/mod.rs | server/mod.rs:33-442 | carry: start/Tuning/serve_io/drain; handle_request replaced by pipeline.rs (`Tuning` minus `max_action_body_bytes`; `TUNING`/`CORS` process statics dropped — tuning and resolved CORS live on `Server`, so several servers can share a process; `start(Config) -> Arc<Server>`, boot sends the bound addr) | 3 → 1 (+19 integration in tests/server.rs) |
| config.rs Server | config.rs:82-300 | adapt: stripped AppState (pool, routes, ready, drain_*, expected_workers, generator, tls, cors + manifest, renderer, L1, job cache, call counters); no runtime setters | 6 → 0 (covered by tests/server.rs) |
| pipeline.rs | server/mod.rs:447-833 (L1 decision :710-808 as `l1_decision`, CORS preflight :484-501, meta_cacheable :1809-1815 as the store rule) | new: S7 request order; `call_worker` made cancel-safe (claim owned by a spawned task) | 0 → 8 |
Not carried (spec S2): cache/island_cache.rs, render/stream.rs, realtime/*, routing/action.rs, `/_brust/islands`, `/_brust/page`, MCP, SSE/WS, AI, `handle_action`, `dispatch_streaming`, `spawn_chunk_pump`.

## routes.rs: dropped tests (16)
Removed with their subjects (`ActionEnvelope`/`McpEnvelope`/`SseEnvelope`/`WsEnvelope` + `build_*`, `native_template_for`, `rewrite_envelope_kind`):
`action_envelope_json_path`, `action_envelope_form_urlencoded_path`, `action_envelope_multipart_path`, `action_envelope_quoting_preserved`, `mcp_envelope_serialises_kind_mcp`, `mcp_envelope_preserves_inner_quotes`, `sse_envelope_serialises_kind_sse_and_conn_id`, `sse_envelope_preserves_query_string`, `ws_envelope_serialises_kind_ws_and_conn_id`, `ws_envelope_empty_subprotocols`, `swap_render_to_navigation`, `replaces_only_first_occurrence`, `missing_kind_returns_input_unchanged`, `route_table_natives_indexed_by_route_id`, `envelope_includes_native_template_when_set`, `envelope_omits_native_template_when_unset`.
Adapted: `render_envelope_has_kind_discriminant` → `route_envelope_serializes_route_id_and_path` (asserts `route_id` + `path`, and no `kind`); `install_not_found_config_from_json` loses its `nativeTemplate` assertions (asserts the catch-all envelope's `route_id` and empty `params` instead). Added: `from_manifest_installs_catch_all_outside_matchit`.

## manifest notes (contract for m2a, accepted by the lead 2026-10-09; spec S6 amendments)
1. `jobs[].per_instance` is the **context path of the list** (`"pokemon.moves"`), not the client loop member (`_l1`).
2. `children[].props` maps each child prop name → a parent-context path, with the literal `[idx]` standing for the current row of the `per-row` list (`"move": "pokemon.moves[idx]"`). It must cover the root segment of every `inputs` entry of the child's jobs; boot fails with `ManifestError::UncoveredInput` otherwise.
3. `jobs[].inputs` are relative to the component's props (`"item.price"`, as the M1 IR emits); a leading `props.` segment (spec §3 example) is accepted and stripped.
4. `k` in `__<childId>_<k>` is the 1-based ordinal of that child id within `children` (template order).
