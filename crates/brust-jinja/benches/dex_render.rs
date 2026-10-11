//! Bench bench-app route D (`/dex`): the real loader response and the real
//! compiled `dexPage` template. `render` is minijinja over the parsed `Node`
//! tree (the server's writer path into a hinted buffer); `parse_node` is the
//! response's `data` parse into the tree.
//! `cargo bench -p brust-jinja --bench dex_render`.
use std::hint::black_box;
use std::path::Path;
use std::time::Duration;

use brust_jinja::ctx::Node;
use criterion::{Criterion, criterion_group, criterion_main};
use minijinja::Environment;

fn benches(c: &mut Criterion) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("benches/fixtures/dex");
    let response = std::fs::read_to_string(dir.join("response.json")).unwrap();
    let template = std::fs::read_to_string(dir.join("dexPage.jinja")).unwrap();

    let parsed: Node = serde_json::from_str(&response).unwrap();
    let data = parsed.get("data").expect("response has data").clone();
    let ctx = data.to_value();

    let mut env = Environment::new();
    brust_jinja::register(&mut env);
    env.add_template("dexPage", &template).unwrap();
    let t = env.get_template("dexPage").unwrap();

    let mut g = c.benchmark_group("dex");
    g.bench_function("render", |b| {
        b.iter(|| {
            let mut buf: Vec<u8> = Vec::with_capacity(24 * 1024);
            t.render_captured_to(black_box(ctx.clone()), &mut buf)
                .unwrap();
            black_box(buf)
        })
    });
    g.bench_function("parse_node", |b| {
        b.iter(|| {
            let n: Node = serde_json::from_str(black_box(&response)).unwrap();
            black_box(n)
        })
    });
    g.finish();
}

criterion_group! {
    name = dex_render;
    config = Criterion::default()
        .warm_up_time(Duration::from_secs(1))
        .measurement_time(Duration::from_secs(3));
    targets = benches
}
criterion_main!(dex_render);
