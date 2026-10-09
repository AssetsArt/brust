//! `| json_attr` on its own: the pokedex bench contexts (the server render
//! bench's fixtures) serialized into an `x-props` attribute.
//! `cargo bench -p brust-jinja --bench json_attr`.
use std::hint::black_box;
use std::path::Path;
use std::time::Duration;

use criterion::{Criterion, criterion_group, criterion_main};
use minijinja::{Environment, context};

fn benches(c: &mut Criterion) {
    let mut env = Environment::new();
    brust_jinja::register(&mut env);
    env.add_template("t", "<i x-props='{{ p | json_attr }}'></i>")
        .unwrap();
    let t = env.get_template("t").unwrap();
    let ctx =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../brust-server/benches/fixtures/pokedex/ctx");
    let mut g = c.benchmark_group("json_attr");
    for (label, file) in [
        ("pokemon_pikachu", "pokemon-pikachu.json"),
        ("type_chart", "type-chart.json"),
    ] {
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(ctx.join(file)).unwrap()).unwrap();
        let p = brust_jinja::value_of(&json);
        g.bench_function(label, |b| {
            b.iter(|| t.render(context! { p => black_box(&p) }).unwrap())
        });
    }
    g.finish();
}

criterion_group! {
    name = json_attr;
    config = Criterion::default()
        .warm_up_time(Duration::from_secs(1))
        .measurement_time(Duration::from_secs(3));
    targets = benches
}
criterion_main!(json_attr);
