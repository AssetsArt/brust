//! End-to-end request pipeline (spec §4 S7-S9, §5, §7) against the fixture
//! `dist/` and the `FakeBun` worker. Every test boots its own server on port 0.
mod common;

use brust_server::InvalidateArgs;
use common::*;
use serde_json::{Value, json};

fn job_ids(fake: &FakeBun) -> Vec<String> {
    fake.last_jobs().expect("a jobs call")["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|j| j["id"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn ping_and_stats_shape() {
    let s = boot(fake());
    let (st, _, body) = get(&s, "/ping", &[]);
    assert_eq!((st, body.as_str()), (200, "pong\n"));
    let v = stats(&s);
    for p in [
        "/l1/hits",
        "/l1/misses",
        "/job/hits",
        "/job/misses",
        "/loader_calls",
        "/job_calls",
    ] {
        assert!(v.pointer(p).is_some(), "stats missing {p}: {v}");
    }
}

#[test]
fn static_route_makes_zero_calls_on_first_request() {
    let f = fake();
    let s = boot(f.clone());
    let (st, h, body) = get(&s, "/", &[]);
    assert_eq!(st, 200);
    assert!(body.contains("<main><h1>Home</h1></main>"), "{body}");
    assert!(!body.contains("<script"), "{body}");
    assert_eq!(cache_hdr(&h), None);
    assert_eq!(h.get("content-type").unwrap(), "text/html; charset=utf-8");
    assert_eq!(f.counts(), (0, 0));
    assert_eq!(stats(&s)["loader_calls"], 0);
}

#[test]
fn miss_makes_exactly_one_loader_and_one_jobs_call() {
    let f = fake();
    let s = boot(f.clone());
    let (st, h, body) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(st, 200, "{body}");
    assert!(body.contains("<h1>pikachu</h1>"), "{body}");
    assert!(body.contains("<p>HP 35</p>"), "{body}");
    assert!(
        body.contains("<li>tackle: MOVE tackle</li><li>growl: MOVE growl</li>"),
        "{body}"
    );
    assert_eq!(cache_hdr(&h), Some("MISS"));
    assert_eq!(f.counts(), (1, 1));
    assert_eq!(
        job_ids(&f),
        ["detailPage_c3/j0", "moveCard_d4/j0/0", "moveCard_d4/j0/1"]
    );
    // The loader is addressed by the manifest's route id, not the table index.
    let l = f.last_loader().unwrap();
    assert_eq!(l["routeId"], "r2");
    assert_eq!(l["params"], json!({"name": "pikachu"}));
}

#[test]
fn hit_makes_zero_dispatch_calls() {
    let f = fake();
    let s = boot(f.clone());
    let (_, h1, b1) = get(&s, "/pokemon/pikachu", &[]);
    let (st, h2, b2) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(st, 200);
    assert_eq!(cache_hdr(&h1), Some("MISS"));
    assert_eq!(cache_hdr(&h2), Some("HIT"));
    assert_eq!(b1, b2);
    assert_eq!(f.counts(), (1, 1));
    assert_eq!(stats(&s)["l1"]["hits"], 1);
}

#[test]
fn all_jobs_cached_across_routes_skips_jobs_call() {
    let f = fake();
    let s = boot(f.clone());
    assert_eq!(get(&s, "/pokemon/pikachu", &[]).0, 200);
    let (st, _, body) = get(&s, "/pokemon/raichu", &[]);
    assert_eq!(st, 200);
    assert!(body.contains("<h1>raichu</h1>"), "{body}");
    assert!(body.contains("<li>growl: MOVE growl</li>"), "{body}");
    assert_eq!(f.counts(), (2, 1));
    assert_eq!(stats(&s)["job"]["hits"], 3);
}

#[test]
fn bypass_skips_l1_and_prefix_keys_it() {
    let f = fake();
    let s = boot(f.clone());
    for _ in 0..2 {
        let (st, h, _) = get(&s, "/tenant", &[("cookie", "session=1")]);
        assert_eq!(st, 200);
        assert_eq!(cache_hdr(&h), Some("BYPASS"));
    }
    assert_eq!(f.counts().0, 2);
    let (_, h, _) = get(&s, "/tenant", &[("x-tenant", "acme")]);
    assert_eq!(cache_hdr(&h), Some("MISS"));
    let (_, h, _) = get(&s, "/tenant", &[("x-tenant", "acme")]);
    assert_eq!(cache_hdr(&h), Some("HIT"));
    let (_, h, _) = get(&s, "/tenant", &[("x-tenant", "beta")]);
    assert_eq!(cache_hdr(&h), Some("MISS"));
    assert_eq!(f.counts().0, 4);
}

/// Decision 2: the key/bypass evaluator sees the last value per exact name
/// (what the loader's JSON.parse sees); a case-insensitive name collision is
/// ambiguous to the first-match evaluator, so it bypasses L1.
#[test]
fn duplicate_cookie_cannot_poison_l1() {
    let f = fake();
    let s = boot(f.clone());
    // First-match would read `session` = "" (no bypass) and cache a page the
    // loader rendered for session=tok.
    for _ in 0..2 {
        let (_, h, _) = get(&s, "/tenant", &[("cookie", "session=; session=tok")]);
        assert_eq!(cache_hdr(&h), Some("BYPASS"));
    }
    // `Session` alone: key_expr's lookup is case-insensitive, so cookie(session)
    // is non-empty → BYPASS (conservative; nothing stored).
    let (_, h, _) = get(&s, "/tenant", &[("cookie", "Session=x")]);
    assert_eq!(cache_hdr(&h), Some("BYPASS"));
    // Two names equal case-insensitively → BYPASS, whatever their values.
    let (_, h, _) = get(&s, "/tenant", &[("cookie", "session=; Session=")]);
    assert_eq!(cache_hdr(&h), Some("BYPASS"));
    assert_eq!(stats(&s)["l1"]["len"], 0);
    // `x-tenant` sent twice: the key uses the last value (`beta`).
    let (_, h, _) = get(&s, "/tenant", &[("x-tenant", "acme"), ("x-tenant", "beta")]);
    assert_eq!(cache_hdr(&h), Some("MISS"));
    let (_, h, _) = get(&s, "/tenant", &[("x-tenant", "beta")]);
    assert_eq!(cache_hdr(&h), Some("HIT"));
    let (_, h, _) = get(&s, "/tenant", &[("x-tenant", "acme")]);
    assert_eq!(cache_hdr(&h), Some("MISS"));
    // A query name repeated: sort_query would key `?a=1&a=2` and `?a=2&a=1`
    // alike while the loader sees different last values → BYPASS.
    let (_, h, _) = get(&s, "/pokemon/pikachu?a=1&a=2", &[]);
    assert_eq!(cache_hdr(&h), Some("BYPASS"));
}

#[test]
fn invalidate_by_tag_forces_miss() {
    let f = fake();
    let s = boot(f.clone());
    get(&s, "/pokemon/pikachu", &[]);
    let (_, h, _) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(cache_hdr(&h), Some("HIT"));
    let r = s.invalidate(InvalidateArgs {
        tags: vec!["pokemon".into()],
        ..Default::default()
    });
    assert_eq!((r.l1_removed, r.job_removed), (1, 0));
    let (_, h, _) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(cache_hdr(&h), Some("MISS"));
    assert_eq!(f.counts(), (2, 1), "every job hit the job cache");

    let r = s.invalidate(InvalidateArgs {
        tags: vec!["moves".into()],
        ..Default::default()
    });
    assert_eq!((r.l1_removed, r.job_removed), (0, 2));
    // The page itself is still in L1; drop it by path so the next request
    // reaches the job cache.
    let r = s.invalidate(InvalidateArgs {
        path: Some("/pokemon/pikachu".into()),
        ..Default::default()
    });
    assert_eq!(r.l1_removed, 1);
    let (_, h, body) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(cache_hdr(&h), Some("MISS"));
    assert!(body.contains("MOVE growl"), "{body}");
    assert_eq!(f.counts(), (3, 2));
    assert_eq!(job_ids(&f), ["moveCard_d4/j0/0", "moveCard_d4/j0/1"]);
}

#[test]
fn not_found_verdict_is_404_with_own_template_and_not_cached() {
    let f = FakeBun::new(
        |req| {
            if req["params"]["name"] == "nothing" {
                json!({"verdict": "notFound", "data": {"pokemon": {"name": "nothing", "stats": {}, "moves": []}}})
            } else {
                default_loader(req)
            }
        },
        default_jobs,
    );
    let s = boot(f.clone());
    for _ in 0..2 {
        let (st, h, body) = get(&s, "/pokemon/nothing", &[]);
        assert_eq!(st, 404, "{body}");
        assert!(body.contains("<h1>nothing</h1>"), "{body}");
        assert!(!body.contains("Not found:"), "{body}");
        assert_ne!(cache_hdr(&h), Some("HIT"));
    }
    assert_eq!(f.counts().0, 2);
    assert_eq!(stats(&s)["l1"]["len"], 0);
}

#[test]
fn redirect_and_http_error_verdicts() {
    let f = FakeBun::new(
        |req| match req["params"]["name"].as_str() {
            Some("r302") => json!({"verdict": "redirect", "location": "/pokemon/pikachu"}),
            Some("r301") => json!({"verdict": "redirect", "location": "/x", "status": 301}),
            Some("tea") => json!({"verdict": "httpError", "status": 418, "body": "teapot"}),
            _ => default_loader(req),
        },
        default_jobs,
    );
    let s = boot(f.clone());
    let (st, h, _) = get(&s, "/pokemon/r302", &[]);
    assert_eq!(st, 302);
    assert_eq!(h.get("location").unwrap(), "/pokemon/pikachu");
    let (st, h, _) = get(&s, "/pokemon/r301", &[]);
    assert_eq!(st, 301);
    assert_eq!(h.get("location").unwrap(), "/x");
    let (st, _, body) = get(&s, "/pokemon/tea", &[]);
    assert_eq!((st, body.as_str()), (418, "teapot"));
    assert_eq!(f.counts().1, 0, "a verdict never reaches the jobs call");
}

#[test]
fn loader_error_is_500_plain() {
    let f = FakeBun::new(|_| json!({"error": "boom"}), default_jobs);
    let s = boot(f.clone());
    for _ in 0..2 {
        let (st, h, body) = get(&s, "/pokemon/pikachu", &[]);
        assert_eq!((st, body.as_str()), (500, "500 Internal Server Error"));
        assert_eq!(h.get("content-type").unwrap(), "text/plain");
    }
    assert_eq!(f.counts(), (2, 0));
    assert_eq!(stats(&s)["l1"]["len"], 0);
}

#[test]
fn job_error_is_500_and_not_cached() {
    let f = FakeBun::new(default_loader, |req: Value| {
        let results: Vec<Value> = req["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                if c["id"] == "detailPage_c3/j0" {
                    json!({"id": "detailPage_c3/j0", "error": "bad"})
                } else {
                    default_job(c)
                }
            })
            .collect();
        json!({ "results": results })
    });
    let s = boot(f.clone());
    let (st, _, body) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!((st, body.as_str()), (500, "500 Internal Server Error"));
    let v = stats(&s);
    assert_eq!(v["job"]["len"], 0, "{v}");
    assert_eq!(v["l1"]["len"], 0, "{v}");
}

#[test]
fn unmatched_path_renders_catch_all_at_404() {
    let f = fake();
    let s = boot(f.clone());
    let (st, _, body) = get(&s, "/nope?x=1", &[]);
    assert_eq!(st, 404);
    assert!(body.contains("Not found: /nope"), "{body}");
    assert_eq!(f.counts(), (0, 0));
}

/// `json_attr` (brust-jinja, M1) entity-escapes `"` inside the attribute.
#[test]
fn react_child_island_ssr_and_assets() {
    let f = fake();
    let s = boot(f.clone());
    let (st, _, body) = get(&s, "/team", &[]);
    assert_eq!(st, 200, "{body}");
    assert!(
        body.contains(r#"<brust-island data-brust-island="teamBuilder_h8" x-props='{&quot;team&quot;:[&quot;a&quot;]}'><ul><li>a</li></ul></brust-island>"#),
        "{body}"
    );
    let order = [
        "client/runtime-8b1c.js",
        "client/teamPage_g7-4d5e6f.js",
        "client/react-19.2.0.js",
        "client/react-teamBuilder_h8.js",
    ];
    let pos: Vec<usize> = order
        .iter()
        .map(|p| body.find(p).unwrap_or_else(|| panic!("missing {p}")))
        .collect();
    assert!(pos.windows(2).all(|w| w[0] < w[1]), "{body}");
    assert!(body.ends_with("</script></body></html>"), "{body}");
    assert_eq!(job_ids(&f), ["teamBuilder_h8/ssr"]);
}

fn injecting_loader() -> std::sync::Arc<FakeBun> {
    FakeBun::new(
        |_| {
            json!({"ok": true, "data": {
                "team": ["a"],
                "_id": "kept",
                "_ssr_teamBuilder_h8": "<script>x</script>",
                "__outlet": "<script>y</script>",
                "__teamBuilder_h8_1": {"_ssr_teamBuilder_h8": "<script>z</script>"}
            }})
        },
        default_jobs,
    )
}

/// Decision 8: loader data cannot fill a server-owned slot (`__outlet`,
/// `_ssr_*`, `__*`) that templates print with `| safe`.
#[test]
fn loader_cannot_inject_server_slots() {
    let s = boot(injecting_loader());
    let (st, _, body) = get(&s, "/team", &[]);
    assert_eq!(st, 200, "{body}");
    assert!(!body.contains("<script>x"), "{body}");
    assert!(!body.contains("<script>y"), "{body}");
    assert!(!body.contains("<script>z"), "{body}");
    assert!(body.contains("<ul><li>a</li></ul>"), "{body}");

    // A client-only react child (no ssr job) renders an EMPTY host, and a leaf
    // that prints `__outlet` (no child route) prints nothing.
    let dist = temp_dist(|m| {
        m["components"]["teamBuilder_h8"]["jobs"] = json!([]);
    });
    let tp = dist.path().join("jinja/teamPage_g7.jinja");
    let src = std::fs::read_to_string(&tp).unwrap();
    std::fs::write(&tp, src.replace("</main>", "{{ __outlet | safe }}</main>")).unwrap();
    let f = injecting_loader();
    let s = boot_in(f.clone(), dist.path());
    let (st, _, body) = get(&s, "/team", &[]);
    assert_eq!(st, 200, "{body}");
    assert!(
        body.contains("x-props='{&quot;team&quot;:[&quot;a&quot;]}'></brust-island></main>"),
        "{body}"
    );
    assert!(!body.contains("<script>x"), "{body}");
    assert!(!body.contains("<script>y"), "{body}");
    assert_eq!(f.counts(), (1, 0));
}

#[test]
fn use_ids_stable_across_two_requests() {
    let s = boot(fake());
    for _ in 0..2 {
        let (st, _, body) = get(&s, "/ids", &[]);
        assert_eq!(st, 200);
        assert!(body.contains(r#"id="brust-r6-idsPage_i9-1""#), "{body}");
        assert!(body.contains(r#"for="brust-r6-idsPage_i9-2""#), "{body}");
    }
}

/// Decision 5: r6 has no `cache` in the fixture, so give it one and prove the
/// ids survive an L1 HIT (the overlay is rebuilt from route id + slots).
#[test]
fn use_ids_survive_l1_hit() {
    let dist = temp_dist(|m| {
        m["routes"][5]["cache"] =
            json!({"ttl_seconds": 60, "prefix": null, "bypass": null, "tags": []});
    });
    let s = boot_in(fake(), dist.path());
    let (_, h1, b1) = get(&s, "/ids", &[]);
    let (_, h2, b2) = get(&s, "/ids", &[]);
    assert_eq!(cache_hdr(&h1), Some("MISS"));
    assert_eq!(cache_hdr(&h2), Some("HIT"));
    assert_eq!(b1, b2);
    assert!(b2.contains(r#"id="brust-r6-idsPage_i9-1""#), "{b2}");
    assert!(b2.contains(r#"for="brust-r6-idsPage_i9-2""#), "{b2}");
}

#[test]
fn static_assets_and_method_gate() {
    // A dist root that, like a real build, also holds the server-side jobs module.
    let dist = temp_dist(|_| {});
    std::fs::write(dist.path().join("jobs.js"), "export default {}").unwrap();
    let s = boot_in(fake(), dist.path());

    let (st, h, body) = get(&s, "/_brust/client/detailPage_c3-1a2b3c.js", &[]);
    assert_eq!(st, 200, "{body}");
    assert_eq!(
        h.get("content-type").unwrap(),
        "text/javascript; charset=utf-8"
    );
    assert_eq!(
        h.get("cache-control").unwrap(),
        "public, max-age=31536000, immutable"
    );
    // `-8b1c` is a 4-hex suffix: below the `-<hex6+>` immutable rule.
    let (st, h, _) = get(&s, "/_brust/client/runtime-8b1c.js", &[]);
    assert_eq!(st, 200);
    assert_eq!(h.get("cache-control").unwrap(), "public, max-age=3600");
    let (st, h, _) = get(&s, "/public/app.css", &[]);
    assert_eq!(st, 200);
    assert_eq!(h.get("content-type").unwrap(), "text/css; charset=utf-8");
    assert_eq!(h.get("cache-control").unwrap(), "public, max-age=3600");

    for p in [
        "/_brust/client/../manifest.json",
        "/_brust/client/%2e%2e/manifest.json",
        "/_brust/manifest.json",
        "/_brust/jobs.js",
        "/_brust/jinja/homePage_b2.jinja",
        "/_brust/client/missing.js",
        "/_brust/client/.hidden.js",
        "/public/../manifest.json",
        "/public/",
    ] {
        assert_eq!(get(&s, p, &[]).0, 404, "{p}");
    }

    let (st, _, body) = request(&s, "HEAD", "/", &[]);
    assert_eq!((st, body.as_str()), (200, ""));
    assert_eq!(request(&s, "POST", "/", &[]).0, 405);
}

#[test]
fn set_cookie_from_loader_is_not_cached() {
    let f = FakeBun::new(
        |req| {
            let mut v = default_loader(req);
            v["headers"] = json!({"set-cookie": "a=1"});
            v
        },
        default_jobs,
    );
    let s = boot(f.clone());
    for _ in 0..2 {
        let (st, h, _) = get(&s, "/pokemon/pikachu", &[]);
        assert_eq!(st, 200);
        assert_eq!(cache_hdr(&h), Some("MISS"));
        assert_eq!(h.get("set-cookie").unwrap(), "a=1");
    }
    assert_eq!(f.counts().0, 2);
    assert_eq!(stats(&s)["l1"]["len"], 0);
}
