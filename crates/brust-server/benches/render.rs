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
//! - `props_to_value`: `_props` = ctx minus `__children`/`__own`, cloned and
//!   converted (once per request, in `render_chain_html`);
//! - `render_page` / `render_layout` / `render_chain`: the leaf alone, the
//!   layout alone (no `__outlet`), and the whole chain with every overlay;
//! - `inject_assets` on the rendered document;
//! - `gzip_l1` / `gzip_l6` of the injected document (today: level 6);
//! - `finish_identity` / `finish_gzip`: render + inject (+ gzip L6), i.e. the
//!   body `finish` builds;
//! - `l1_hit_gzip`: today's HIT = `L1Cache::get` + header clone + the full
//!   `finish_gzip` re-render.
use std::collections::BTreeMap;
use std::hint::black_box;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use brust_server::bench::render_chain_html;
use brust_server::cache::l1::{L1Cache, build_cache_key};
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

/// Mirror of `pipeline::all_props` (private): ctx minus the server's maps.
fn all_props(ctx: &Value) -> Value {
    match ctx {
        Value::Object(o) => Value::Object(
            o.iter()
                .filter(|(k, _)| k.as_str() != "__children" && k.as_str() != "__own")
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        ),
        v => v.clone(),
    }
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
    g.bench_function("props_to_value", |b| {
        b.iter(|| brust_jinja::value_of(all_props(black_box(&ctx))))
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
        if gz { gzip(&bytes, 6) } else { bytes }
    };
    g.bench_function("finish_identity", |b| b.iter(|| finish(false)));
    g.bench_function("finish_gzip", |b| b.iter(|| finish(true)));

    let l1 = L1Cache::new();
    let key = build_cache_key("GET", path, String::new());
    let headers: Arc<[(String, String)]> = Vec::new().into();
    l1.insert(
        key.clone(),
        Arc::new(ctx.clone()),
        headers,
        Duration::from_secs(3600),
        &[],
    );
    g.bench_function("l1_hit_gzip", |b| {
        b.iter(|| {
            let hit = l1.get(black_box(&key)).expect("hit");
            let _h = hit.headers.to_vec();
            let html = render_chain_html(m, r, &route.id, chain, &hit.ctx).unwrap();
            gzip(inject_assets(html, chain, m).as_bytes(), 6)
        })
    });
    g.finish();
}

fn benches(c: &mut Criterion) {
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
