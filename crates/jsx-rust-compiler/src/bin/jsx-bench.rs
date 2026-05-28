//! jsx-bench — A1.1: measure machine-generated maud render throughput.
//!
//! Build with `cargo build --release -p jsx-rust-compiler --features bench --bin jsx-bench`.
//! Run with `cargo run --release -p jsx-rust-compiler --features bench --bin jsx-bench`.
//!
//! Reports per-fixture median ns/op + implied single-core RPS over N=5 trials
//! × M=200_000 renders. Compare to /ping ceiling (~111k RPS) and Spike B's
//! hand-written maud (~104k RPS) — claim under test: machine-generated maud
//! is within noise of hand-written maud.

#[path = "../../fixtures/static_hello.expected.rs"]
mod static_hello;

#[path = "../../fixtures/props_hello.expected.rs"]
mod props_hello;

#[path = "../../fixtures/list_nav.expected.rs"]
mod list_nav;

use std::hint::black_box;
use std::time::Instant;

const TRIALS: usize = 5;
const ITERS: u64 = 200_000;

fn main() {
    println!("jsx-rust-compiler bench (N={TRIALS} trials × M={ITERS} renders each, --release)\n");
    println!(
        "{:<14} {:>14} {:>14} {:>22}",
        "fixture", "median ns/op", "implied RPS", "[min..max] ns/op"
    );

    bench_static_hello();
    bench_props_hello();
    bench_list_nav();
}

fn bench_static_hello() {
    let props = static_hello::Props {};
    measure("static_hello", || {
        black_box(static_hello::render(black_box(&props)).into_string())
    });
}

fn bench_props_hello() {
    let props = props_hello::Props {
        title: "Hi".to_string(),
        body: "Body <hi> & co".to_string(),
    };
    measure("props_hello", || {
        black_box(props_hello::render(black_box(&props)).into_string())
    });
}

fn bench_list_nav() {
    use list_nav::{ItemsItem, Props};
    let props = Props {
        items: vec![
            ItemsItem {
                href: "/a".to_string(),
                label: "Alpha".to_string(),
            },
            ItemsItem {
                href: "/b".to_string(),
                label: "Beta".to_string(),
            },
        ],
    };
    measure("list_nav", || {
        black_box(list_nav::render(black_box(&props)).into_string())
    });
}

/// Run N=TRIALS trials of M=ITERS renders each. Report median, min, max ns/op.
fn measure<F: FnMut() -> String>(name: &str, mut f: F) {
    // Warm-up: 10k iters, discarded.
    for _ in 0..10_000 {
        let _ = f();
    }

    let mut trials_ns_per_op: Vec<u64> = Vec::with_capacity(TRIALS);
    for _ in 0..TRIALS {
        let start = Instant::now();
        for _ in 0..ITERS {
            let _ = f();
        }
        let elapsed = start.elapsed();
        let ns_per_op = elapsed.as_nanos() as u64 / ITERS;
        trials_ns_per_op.push(ns_per_op);
    }

    trials_ns_per_op.sort_unstable();
    let median = trials_ns_per_op[TRIALS / 2];
    let min = *trials_ns_per_op.first().unwrap();
    let max = *trials_ns_per_op.last().unwrap();
    let implied_rps = 1_000_000_000u64 / median.max(1);

    println!(
        "{:<14} {:>14} {:>14} {:>22}",
        name,
        median,
        format_thousands(implied_rps),
        format!("[{min}..{max}]")
    );
}

fn format_thousands(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, c) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out.chars().rev().collect()
}
