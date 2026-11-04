//! F507: `/_brust/cache/stats` is not public by default. `off` (the default of `Config`) answers it like any unknown path,
//! `public` serves it, `token` serves it to `Authorization: Bearer <token>` only and answers 404 (never 401: the endpoint
//! is not revealed) for a wrong or missing one. `/ping` stays public in every mode.
mod common;

use brust_core::config::StatsAccess;
use brust_server::start;
use common::*;
use std::sync::Arc;

fn boot_stats(stats: StatsAccess) -> Arc<brust_server::Server> {
    let mut cfg = config(&fx());
    cfg.stats = stats;
    let s = start(cfg).expect("start");
    let fake = fake();
    let id = s.register_worker(Box::new(FakeBunHandle(Arc::clone(&fake))));
    fake.bind(&s, id);
    s
}

const PATH: &str = "/_brust/cache/stats";

#[test]
fn the_default_config_serves_no_stats() {
    assert_eq!(brust_server::Config::default().stats, StatsAccess::Off);
    let s = boot_stats(StatsAccess::default());
    let (st, _, body) = get(&s, PATH, &[]);
    assert_eq!(st, 404, "{body}");
    assert!(!body.contains("loader_calls"), "{body}");
    // the same answer as a path nothing serves under /_brust/
    assert_eq!(get(&s, "/_brust/cache/nothing", &[]).0, 404);
    assert_eq!(get(&s, "/ping", &[]).0, 200);
}

#[test]
fn public_serves_the_stats_to_anyone() {
    let s = boot_stats(StatsAccess::Public);
    let (st, h, body) = get(&s, PATH, &[]);
    assert_eq!(st, 200, "{body}");
    assert_eq!(h.get("content-type").unwrap(), "application/json");
    assert!(body.contains("loader_calls"), "{body}");
}

#[test]
fn token_serves_the_bearer_and_hides_the_endpoint_from_everyone_else() {
    let s = boot_stats(StatsAccess::Token("s3cret-token".into()));
    let ok = get(&s, PATH, &[("authorization", "Bearer s3cret-token")]);
    assert_eq!(ok.0, 200, "{}", ok.2);
    assert!(ok.2.contains("loader_calls"));
    for bad in [
        None,
        Some("Bearer wrong"),
        Some("Bearer s3cret-toke"),
        Some("Basic s3cret-token"),
        Some("s3cret-token"),
    ] {
        let headers: Vec<(&str, &str)> = bad.map(|v| ("authorization", v)).into_iter().collect();
        let (st, h, body) = get(&s, PATH, &headers);
        assert_eq!(st, 404, "{bad:?}: {body}");
        assert!(
            h.get("www-authenticate").is_none(),
            "{bad:?}: a 404, not a challenge"
        );
    }
    assert_eq!(get(&s, "/ping", &[]).0, 200);
}
