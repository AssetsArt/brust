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
//! - `ctx_to_value`: `serde_json::Value` → `minijinja::Value` of the merged ctx
//!   (`render_chain` does it once per request);
//! - `props_to_value`: `_props` = ctx minus `__children`/`__own`, as a view
//!   over the converted ctx (once per request, in `render_chain_html`);
//! - `render_page` / `render_layout` / `render_chain`: the leaf alone, the
//!   layout alone (no `__outlet`), and the whole chain with every overlay;
//! - `inject_assets` on the rendered document;
//! - `gzip_l1` / `gzip_l6` of the injected document (pages: level 1 since
//!   m2p Task 3, level 6 before);
//! - `finish_identity` / `finish_gzip`: render + inject (+ the page gzip
//!   policy: level 1 at >= 16 KiB; Task 1 measured level 6 at >= 1 KiB), i.e.
//!   the body a MISS / uncached request builds;
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

use brust_server::bench::{cached_body, props_view, render_chain_html};
use brust_server::cache::l1::{L1Cache, RenderedBody, build_cache_key};
use brust_server::manifest::Manifest;
use brust_server::render::{Renderer, inject_assets};
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

fn ctx(name: &str) -> Value {
    let raw = std::fs::read(fixtures().join("ctx").join(name)).expect("fixture ctx");
    serde_json::from_slice(&raw).expect("ctx parses")
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
    g.bench_function("ctx_to_value", |b| {
        b.iter(|| brust_jinja::value_of(black_box(&ctx)))
    });
    // `_props` given the converted ctx: an O(1) view since m2p Task 4 (it was
    // a deep clone of ctx minus `__children`/`__own` + a second conversion:
    // A 190 µs, B 11.0 µs on the Task 1 host).
    let base = brust_jinja::value_of(&ctx);
    g.bench_function("props_to_value", |b| {
        b.iter(|| props_view(black_box(&base)))
    });
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
    g.bench_function("inject_assets", |b| {
        b.iter_batched(
            || html.clone(),
            |h| inject_assets(h, chain, m),
            criterion::BatchSize::SmallInput,
        )
    });
    g.bench_function("gzip_l1", |b| b.iter(|| gzip(black_box(doc.as_bytes()), 1)));
    g.bench_function("gzip_l6", |b| b.iter(|| gzip(black_box(doc.as_bytes()), 6)));
    let finish = |gz: bool| {
        let html = render_chain_html(m, r, &route.id, chain, &ctx).unwrap();
        let bytes = inject_assets(html, chain, m).into_bytes();
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
    g.bench_function("l1_hit_gzip", |b| b.iter(|| hit(true)));
    g.finish();
}

/// The loader response the worker writes for route B (per-stage attribution, m2p ruling 7d164bb6):
/// `{"ok":true,"data":<B ctx minus the server's params/path/__own/__children>}` (~2.4 KB, the
/// size the server reads per request). Times the SAB-read parse `call_worker` does — into the
/// `#[serde(untagged)]` `LoaderResponse` — against a plain `serde_json::Value` parse of the same
/// bytes (the untagged enum buffers into serde's `Content` and re-walks it per variant).
fn bench_loader_parse(c: &mut Criterion) {
    let mut data = ctx("pokemon-pikachu.json");
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

fn benches(c: &mut Criterion) {
    bench_loader_parse(c);
    let (m, r) = load();
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
