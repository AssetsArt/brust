//! Render-path micro-bench (plan `2026-10-09-m2-render-perf.md`, Task 1).
//!
//! Real pokedex templates and real merged contexts, self-contained under
//! `benches/fixtures/pokedex/`: route A = `/type-chart` (L1-cached), route
//! B = `/pokemon/pikachu`.
//!
//! How the fixtures were made (v2 @c2b7a17; redo after a compiler or pokedex
//! change): `cd examples/pokedex && ../../packages/brust/bin/brust build routes.tsx`,
//! copy `dist/manifest.json` + `dist/jinja/*.jinja`. The contexts are the merged
//! ctx `pipeline::finish` receives (loader data + `__own` job results +
//! `__children` slots + useIds): a temporary, uncommitted
//! `std::fs::write(serde_json::to_string_pretty(ctx))` at the top of `finish`,
//! a release addon, `brust start`, one identity GET of `/type-chart` and of
//! `/pokemon/pikachu?nocache=1`. Check: `BRUST_BENCH_WRITE_DOC=<dir>` writes
//! the bench's documents; both were `cmp`-equal to the served bodies.
//!
//! Per route it times the pieces `pipeline::finish` does on every request
//! (MISS, BYPASS and — today — HIT alike):
//! - `ctx_parse` / `ctx_parse_serde_json`: the merged ctx's JSON parsed straight
//!   into the render tree (`ctx::Node`, M3-P P2: `to_value` is then an `Arc`
//!   bump) vs the former path, a `serde_json::Value` parse + the `value_of`
//!   walk `render_chain_html` did once per request (formerly `ctx_to_value`);
//! - `props_to_value`: `_props` = ctx minus `__children`/`__own`, as a view
//!   over the tree (once per request, in `render_chain_html`);
//! - `render_page` / `render_layout` / `render_chain`: the leaf alone, the
//!   layout alone (no `__outlet`), and the whole chain with every overlay;
//! - `inject_assets` on the rendered document;
//! - `gzip_l1` / `gzip_l6` of the injected document (pages: level 1 since
//!   m2p Task 3, level 6 before);
//! - `render_chain_hinted`: `render_chain` into a buffer sized from the last
//!   document (`next_hint`, the server's steady state since M3-P P3);
//! - `finish_identity` / `finish_gzip`: hinted render + in-place inject (+ the page gzip
//!   policy: level 1 at >= 16 KiB; Task 1 measured level 6 at >= 1 KiB), i.e.
//!   the body a MISS / uncached request builds;
//! - `plan_B` / `plan_C` (`/pokemon/pikachu`, `/` = probe C): the job-planning stage, see
//!   `bench_plan`. C's context (`ctx/home.json`) was captured the same way on v2 @40283bc (one
//!   identity GET of `/`, debug addon); `plan-golden.json` pins every plan's call id, job key and
//!   inputs and the all-miss `JobsRequest` JSON (`pipeline` test `pokedex_plans_match_the_golden`).
//! - `l1_hit_identity` / `l1_hit_gzip`: a HIT = `L1Cache::get` + the stored
//!   rendered body (identity, or its once-made gzip) + its header map. Before
//!   the S10 amendment (m2p Task 2) a HIT re-rendered: `l1_hit_gzip` was
//!   `finish_gzip` + the get (A 1.413 ms, B 205.4 µs on the Task 1 host).
use std::collections::BTreeMap;
use std::hint::black_box;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use brust_jinja::ctx::Node;
use brust_server::bench::{
    cached_body, next_hint, props_view, render_chain_html, render_chain_into,
};
use brust_server::cache::l1::{L1Cache, RenderedBody, build_cache_key};
use brust_server::manifest::Manifest;
use brust_server::render::{Renderer, inject_assets, inject_assets_into};
use criterion::{Criterion, criterion_group, criterion_main};
use flate2::Compression;
use flate2::write::GzEncoder;
use serde_json::Value;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("benches/fixtures/pokedex")
}

/// The manifest as-is plus every component's template, read the way
/// `Manifest::load` reads them (without its client-chunk existence checks:
/// the fixture carries no `islands/`).
fn load() -> (Manifest, Renderer) {
    let dir = fixtures();
    let raw = std::fs::read(dir.join("manifest.json")).expect("fixture manifest.json");
    let m: Manifest = serde_json::from_slice(&raw).expect("manifest parses");
    let templates: BTreeMap<String, String> = m
        .components
        .iter()
        .map(|(id, c)| {
            let src = std::fs::read_to_string(dir.join(&c.template))
                .unwrap_or_else(|e| panic!("template {}: {e}", c.template));
            (id.clone(), src)
        })
        .collect();
    let r = Renderer::from_templates(&templates).expect("templates compile");
    (m, r)
}

fn ctx_raw(name: &str) -> Vec<u8> {
    std::fs::read(fixtures().join("ctx").join(name)).expect("fixture ctx")
}

fn ctx_json(name: &str) -> Value {
    serde_json::from_slice(&ctx_raw(name)).expect("ctx parses")
}

fn ctx(name: &str) -> Node {
    Node::from(ctx_json(name))
}

fn gzip(bytes: &[u8], level: u32) -> Vec<u8> {
    let mut enc = GzEncoder::new(
        Vec::with_capacity(bytes.len() / 2 + 32),
        Compression::new(level),
    );
    enc.write_all(bytes).unwrap();
    enc.finish().unwrap()
}

fn bench_route(
    c: &mut Criterion,
    m: &Manifest,
    r: &Renderer,
    label: &str,
    pattern: &str,
    path: &str,
    ctx_file: &str,
) {
    let route = m
        .routes
        .iter()
        .find(|x| x.pattern == pattern)
        .unwrap_or_else(|| panic!("no route {pattern}"));
    let ctx = ctx(ctx_file);
    let chain = &route.chain;
    let leaf = chain.last().expect("chain").clone();
    let layout = chain.first().expect("chain").clone();

    let html = render_chain_html(m, r, &route.id, chain, &ctx).expect("renders");
    let doc = inject_assets(html.clone(), chain, m);
    let page_only = render_chain_html(m, r, &route.id, std::slice::from_ref(&leaf), &ctx).unwrap();
    let layout_only =
        render_chain_html(m, r, &route.id, std::slice::from_ref(&layout), &ctx).unwrap();
    let ctx_json = serde_json::to_vec(&ctx).unwrap();
    // Reviewer aid: write the document so it can be `cmp`-ed against the body
    // the running server sends for `path` (identity).
    if let Ok(dir) = std::env::var("BRUST_BENCH_WRITE_DOC") {
        std::fs::write(Path::new(&dir).join(format!("{label}.html")), &doc).unwrap();
    }
    eprintln!(
        "[{label}] {path}: route {} chain {:?}; ctx json {} B; page {} B, layout(no outlet) {} B, chain {} B, document {} B, gzip L1 {} B, L6 {} B",
        route.id,
        chain,
        ctx_json.len(),
        page_only.len(),
        layout_only.len(),
        html.len(),
        doc.len(),
        gzip(doc.as_bytes(), 1).len(),
        gzip(doc.as_bytes(), 6).len(),
    );

    let mut g = c.benchmark_group(label);
    let raw = ctx_raw(ctx_file);
    g.bench_function("ctx_parse", |b| {
        b.iter(|| serde_json::from_slice::<Node>(black_box(&raw)).unwrap())
    });
    g.bench_function("ctx_parse_serde_json", |b| {
        b.iter(|| {
            let v = serde_json::from_slice::<Value>(black_box(&raw)).unwrap();
            brust_jinja::value_of(&v)
        })
    });
    // `_props`: an O(1) view since m2p Task 4 (it was a deep clone of ctx minus
    // `__children`/`__own` + a second conversion: A 190 µs, B 11.0 µs on the
    // Task 1 host); a `MapView` over the tree since M3-P P2.
    g.bench_function("props_to_value", |b| b.iter(|| props_view(black_box(&ctx))));
    g.bench_function("render_page", |b| {
        b.iter(|| {
            render_chain_html(
                m,
                r,
                &route.id,
                std::slice::from_ref(&leaf),
                black_box(&ctx),
            )
            .unwrap()
        })
    });
    g.bench_function("render_layout", |b| {
        b.iter(|| {
            render_chain_html(
                m,
                r,
                &route.id,
                std::slice::from_ref(&layout),
                black_box(&ctx),
            )
            .unwrap()
        })
    });
    g.bench_function("render_chain", |b| {
        b.iter(|| render_chain_html(m, r, &route.id, chain, black_box(&ctx)).unwrap())
    });
    // The chain into a buffer sized like the server's steady state (M3-P P3:
    // `render_hints` after one request of this route) — the writer path when
    // the hint is >= 16 KiB.
    let hint = next_hint(doc.len());
    g.bench_function("render_chain_hinted", |b| {
        b.iter(|| {
            let mut out = String::with_capacity(hint);
            render_chain_into(m, r, &route.id, chain, black_box(&ctx), &mut out).unwrap();
            out
        })
    });
    g.bench_function("inject_assets", |b| {
        b.iter_batched(
            || html.clone(),
            |h| inject_assets(h, chain, m),
            criterion::BatchSize::SmallInput,
        )
    });
    g.bench_function("gzip_l1", |b| b.iter(|| gzip(black_box(doc.as_bytes()), 1)));
    g.bench_function("gzip_l6", |b| b.iter(|| gzip(black_box(doc.as_bytes()), 6)));
    // `pipeline::render_document` (M3-P P3): one buffer sized from the last
    // document, the chain rendered into it, the tags inserted in place.
    let finish = |gz: bool| {
        let mut out = String::with_capacity(hint);
        render_chain_into(m, r, &route.id, chain, &ctx, &mut out).unwrap();
        inject_assets_into(&mut out, chain, m);
        let bytes = out.into_bytes();
        // The page policy (m2p Task 3): gzip level 1, only at >= 16 KiB.
        if gz && bytes.len() >= 16 * 1024 {
            gzip(&bytes, 1)
        } else {
            bytes
        }
    };
    g.bench_function("finish_identity", |b| b.iter(|| finish(false)));
    g.bench_function("finish_gzip", |b| b.iter(|| finish(true)));

    let l1 = L1Cache::new();
    let key = build_cache_key("GET", path, String::new());
    let headers: Arc<[(String, String)]> = Vec::new().into();
    let mut base = http::HeaderMap::new();
    base.insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static("text/html; charset=utf-8"),
    );
    l1.insert(
        key.clone(),
        Arc::new(ctx.clone()),
        Arc::new(RenderedBody {
            status: 200,
            headers: base,
            html: bytes::Bytes::from(doc.clone().into_bytes()),
            gzip: OnceLock::new(),
        }),
        headers,
        Duration::from_secs(3600),
        &[],
    );
    // A HIT (S10 amendment): `L1Cache::get` + the stored body (its gzip made
    // by the first gzip-accepting HIT, here the warm-up) + the header map.
    let hit = |gz: bool| {
        let hit = l1.get(black_box(&key)).expect("hit");
        let _h = hit.body.headers.clone();
        cached_body(&hit.body, gz)
    };
    g.bench_function("l1_hit_identity", |b| b.iter(|| hit(false)));
    // `L1Cache::get` of the one hot key from 8 threads at once (wall time /
    // iterations per thread; 1x = no contention), as `lookups_x8`.
    g.bench_function("l1_get_x8", |b| {
        b.iter_custom(|iters| {
            let t = std::time::Instant::now();
            std::thread::scope(|sc| {
                for _ in 0..8 {
                    sc.spawn(|| {
                        for _ in 0..iters {
                            black_box(l1.get(&key));
                        }
                    });
                }
            });
            t.elapsed()
        })
    });
    g.bench_function("l1_hit_gzip", |b| b.iter(|| hit(true)));
    g.finish();
}

/// The loader response the worker writes for route B (per-stage attribution, m2p ruling 7d164bb6):
/// `{"ok":true,"data":<B ctx minus the server's params/path/__own/__children>}` (~2.4 KB, the
/// size the server reads per request). Times the SAB-read parse `call_worker` does — into
/// `LoaderResponse` — against a plain `serde_json::Value` parse of the same bytes. The id
/// `untagged_LoaderResponse` is kept for baseline continuity: until M3-P P2 the enum was
/// `#[serde(untagged)]` (buffered into serde's `Content`, re-walked per variant); it is now a
/// hand-written one-pass visitor straight into `ctx::Node`.
fn bench_loader_parse(c: &mut Criterion) {
    let mut data = ctx_json("pokemon-pikachu.json");
    if let Value::Object(o) = &mut data {
        for k in ["params", "path", "__own", "__children"] {
            o.remove(k);
        }
    }
    let bytes = serde_json::to_vec(&serde_json::json!({ "ok": true, "data": data })).unwrap();
    eprintln!("[loader_parse] B loader response {} B", bytes.len());
    let mut g = c.benchmark_group("loader_parse");
    g.bench_function("untagged_LoaderResponse", |b| {
        b.iter(|| {
            serde_json::from_slice::<brust_server::protocol::LoaderResponse>(black_box(&bytes))
                .unwrap()
        })
    });
    g.bench_function("plain_Value", |b| {
        b.iter(|| serde_json::from_slice::<Value>(black_box(&bytes)).unwrap())
    });
    g.finish();
}

/// The job-planning stage of a request (m2p plan-perf): `collect_jobs` (input projection, child
/// props, job keys, call ids) over the loader context, the job-cache lookups (every plan a hit:
/// the cache is warmed with the values read back from the captured merged ctx), `seed_child_slots`
/// (child cells + useIds) and the merge of every value. `stage` is all four, as `page` runs them
/// on a request whose jobs are all cached.
fn bench_plan(c: &mut Criterion, m: &Manifest, label: &str, pattern: &str, ctx_file: &str) {
    use brust_server::bench::Planner;
    use brust_server::cache::job_cache::JobCache;
    let route = m.routes.iter().find(|x| x.pattern == pattern).unwrap();
    let merged = ctx(ctx_file);
    let mut loader = merged.clone();
    for k in ["__own", "__children"] {
        loader.map_mut().unwrap().remove(k);
    }
    let planner = Planner::new(m).unwrap();
    let plans = planner.plan(&route.chain, &loader).unwrap();
    let cache = JobCache::new(10_000);
    plans.warm(&cache, &merged);
    let values = plans.lookup(&cache);
    let mut seeded = loader.clone();
    planner.seed(&route.id, &route.chain, &mut seeded).unwrap();
    eprintln!("[{label}] {} plans", plans.len());

    let mut g = c.benchmark_group(label);
    g.bench_function("collect_jobs", |b| {
        b.iter(|| planner.plan(&route.chain, black_box(&loader)).unwrap())
    });
    g.bench_function("lookups", |b| b.iter(|| plans.lookup(black_box(&cache))));
    // The same lookups from 8 threads at once on the one shared cache (the
    // per-iteration time is wall time / iterations per thread: 1x = no
    // contention). The c=120 probe saw lookups cost ~5x their c=1 time.
    g.bench_function("lookups_x8", |b| {
        b.iter_custom(|iters| {
            let t = std::time::Instant::now();
            std::thread::scope(|sc| {
                for _ in 0..8 {
                    sc.spawn(|| {
                        for _ in 0..iters {
                            black_box(plans.lookup(&cache));
                        }
                    });
                }
            });
            t.elapsed()
        })
    });
    g.bench_function("seed", |b| {
        b.iter_batched(
            || loader.clone(),
            |mut x| {
                planner.seed(&route.id, &route.chain, &mut x).unwrap();
                x
            },
            criterion::BatchSize::SmallInput,
        )
    });
    g.bench_function("merge", |b| {
        b.iter_batched(
            || seeded.clone(),
            |mut x| {
                plans.merge(&mut x, &values);
                x
            },
            criterion::BatchSize::SmallInput,
        )
    });
    g.bench_function("stage", |b| {
        b.iter_batched(
            || loader.clone(),
            |mut x| {
                let p = planner.plan(&route.chain, &x).unwrap();
                let v = p.lookup(&cache);
                planner.seed(&route.id, &route.chain, &mut x).unwrap();
                p.merge(&mut x, &v);
                x
            },
            criterion::BatchSize::SmallInput,
        )
    });
    g.finish();
}

fn benches(c: &mut Criterion) {
    bench_loader_parse(c);
    let (m, r) = load();
    bench_plan(c, &m, "plan_B", "/pokemon/{name}", "pokemon-pikachu.json");
    bench_plan(c, &m, "plan_C", "/", "home.json");
    bench_route(
        c,
        &m,
        &r,
        "A_type_chart",
        "/type-chart",
        "/type-chart",
        "type-chart.json",
    );
    bench_route(
        c,
        &m,
        &r,
        "B_pokemon",
        "/pokemon/{name}",
        "/pokemon/pikachu",
        "pokemon-pikachu.json",
    );
}

criterion_group! {
    name = render;
    config = Criterion::default()
        .warm_up_time(Duration::from_secs(1))
        .measurement_time(Duration::from_secs(3));
    targets = benches
}
criterion_main!(render);
