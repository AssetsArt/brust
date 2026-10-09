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
        "/timed_out_calls",
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
        [
            "detailPage_c3/j0",
            "detailPage_c3/moveCard_d4_1/j0/0",
            "detailPage_c3/moveCard_d4_1/j0/1"
        ]
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
    assert_eq!(
        job_ids(&f),
        [
            "detailPage_c3/moveCard_d4_1/j0/0",
            "detailPage_c3/moveCard_d4_1/j0/1"
        ]
    );
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
        body.contains(r#"<brust-island data-id="teamBuilder_h8" x-props='{&quot;team&quot;:[&quot;a&quot;]}'><ul><li>a</li></ul></brust-island>"#),
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
    assert_eq!(job_ids(&f), ["teamPage_g7/j0"]);
}

fn injecting_loader() -> std::sync::Arc<FakeBun> {
    FakeBun::new(
        |_| {
            json!({"ok": true, "data": {
                "team": ["a"],
                "_id": "kept",
                "_ssr_teamBuilder_h8": "<script>x</script>",
                "__outlet": "<script>y</script>",
                "__teamBuilder_h8_1": {"_ssr_teamBuilder_h8": "<script>z</script>"},
                "__children": {"teamPage_g7": {"_ssr_teamBuilder_h8": "<script>w</script>"}}
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
    assert!(!body.contains("<script>w"), "{body}");
    assert!(body.contains("<ul><li>a</li></ul>"), "{body}");

    // A client-only react child (no ssr job) renders an EMPTY host, and a leaf
    // that prints `__outlet` (no child route) prints nothing.
    let dist = temp_dist(|m| {
        m["components"]["teamPage_g7"]["jobs"] = json!([]);
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

/// A dist with a jobbed child (`moveCard_d4`, `use_id_slots: 1`) inlined
/// statically: twice by one page (`/twin`, k=1 and k=2), and once each by a
/// layout and its page (`/nested`, both k=1). The loader feeds props `a`/`b`.
fn twin_dist() -> tempfile::TempDir {
    let dist = temp_dist(|m| {
        let routes = m["routes"].as_array_mut().unwrap();
        routes.push(
            json!({"id": "r7", "pattern": "/twin", "chain": ["appLayout_a1", "twinPage_t1"],
            "loaders": ["r7"], "cache": null, "catch_all": false}),
        );
        routes.push(json!({"id": "r8", "pattern": "/nested", "chain": ["twinLayout_l1", "twinLeaf_p1"],
            "loaders": ["r8"], "cache": {"ttl_seconds": 60, "prefix": null, "bypass": null, "tags": []},
            "catch_all": false}));
        let c = &mut m["components"];
        c["moveCard_d4"]["use_id_slots"] = json!(1);
        let child = |prop: &str| json!({"id": "moveCard_d4", "instances": "static", "props": {"move": prop}});
        let comp = |name: &str, children: Value| {
            json!({"tier": "static",
            "template": format!("jinja/{name}.jinja"), "jobs": [], "children": children,
            "client": null, "needs_worker": true, "use_id_slots": 0})
        };
        c["twinPage_t1"] = comp("twinPage_t1", json!([child("a"), child("b")]));
        c["twinLayout_l1"] = comp("twinLayout_l1", json!([child("a")]));
        c["twinLeaf_p1"] = comp("twinLeaf_p1", json!([child("b")]));
    });
    let j = dist.path().join("jinja");
    let cell = |k: u32| {
        format!(r#"{{{{ __moveCard_d4_{k}["_s1"] | e }}}}@{{{{ __moveCard_d4_{k}["_id0"] | e }}}}"#)
    };
    std::fs::write(
        j.join("twinPage_t1.jinja"),
        format!("<main>[{}][{}]</main>", cell(1), cell(2)),
    )
    .unwrap();
    std::fs::write(
        j.join("twinLayout_l1.jinja"),
        format!("<div>L[{}]{{{{ __outlet | safe }}}}</div>", cell(1)),
    )
    .unwrap();
    std::fs::write(
        j.join("twinLeaf_p1.jinja"),
        format!("<p>P[{}]</p>", cell(1)),
    )
    .unwrap();
    dist
}

fn twin_fake() -> std::sync::Arc<FakeBun> {
    FakeBun::new(
        |_| json!({"ok": true, "data": {"a": {"name": "x"}, "b": {"name": "y"}}}),
        default_jobs,
    )
}

/// Fix 1: a child inlined twice by one parent gets two distinct call ids
/// (`<parent>/<child>_<k>/<job>`), so neither result is lost on a cold cache.
#[test]
fn same_child_twice_in_one_page_gets_distinct_job_ids() {
    let dist = twin_dist();
    let f = twin_fake();
    let s = boot_in(f.clone(), dist.path());
    let (st, _, body) = get(&s, "/twin", &[]);
    assert_eq!(st, 200, "{body}");
    assert!(
        body.contains(
            "<main>[MOVE x@brust-r7-twinPage_t1.moveCard_d4_1-1][MOVE y@brust-r7-twinPage_t1.moveCard_d4_2-1]</main>"
        ),
        "{body}"
    );
    assert_eq!(
        job_ids(&f),
        [
            "twinPage_t1/moveCard_d4_1/j0",
            "twinPage_t1/moveCard_d4_2/j0"
        ]
    );
}

/// Fix 2: a layout and its page that both inline the same child (each k=1)
/// keep separate slots and ids, on the MISS and on the L1 HIT.
#[test]
fn layout_and_page_inlining_same_child_keep_their_own_slots() {
    let dist = twin_dist();
    let f = twin_fake();
    let s = boot_in(f.clone(), dist.path());
    let (st, h1, b1) = get(&s, "/nested", &[]);
    assert_eq!(st, 200, "{b1}");
    assert_eq!(
        b1,
        "<div>L[MOVE x@brust-r8-twinLayout_l1.moveCard_d4_1-1]<p>P[MOVE y@brust-r8-twinLeaf_p1.moveCard_d4_1-1]</p></div>"
    );
    assert_eq!(
        job_ids(&f),
        [
            "twinLayout_l1/moveCard_d4_1/j0",
            "twinLeaf_p1/moveCard_d4_1/j0"
        ]
    );
    let (_, h2, b2) = get(&s, "/nested", &[]);
    assert_eq!(cache_hdr(&h1), Some("MISS"));
    assert_eq!(cache_hdr(&h2), Some("HIT"));
    assert_eq!(b1, b2);
    assert_eq!(f.counts(), (1, 1));
}

/// Fix 3: the loader's (non-Set-Cookie) headers are stored with the L1 entry
/// and replayed on a HIT.
#[test]
fn loader_headers_survive_l1_hit() {
    let f = FakeBun::new(
        |req| {
            let mut v = default_loader(req);
            v["headers"] = json!({"x-robots-tag": "noindex"});
            v
        },
        default_jobs,
    );
    let s = boot(f.clone());
    for want in ["MISS", "HIT"] {
        let (st, h, _) = get(&s, "/pokemon/pikachu", &[]);
        assert_eq!(st, 200);
        assert_eq!(cache_hdr(&h), Some(want));
        assert_eq!(
            h.get("x-robots-tag").map(|v| v.to_str().unwrap()),
            Some("noindex"),
            "{want}"
        );
    }
    assert_eq!(f.counts().0, 1);
}

/// Fix 4: a job result with neither `value` nor `error` fails the request
/// like a job error; nothing is cached.
#[test]
fn job_result_without_value_is_500_and_not_cached() {
    let f = FakeBun::new(default_loader, |req: Value| {
        let results: Vec<Value> = req["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                if c["id"] == "detailPage_c3/j0" {
                    json!({"id": "detailPage_c3/j0"})
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

/// F67 belt: a job result missing a declared slot renders (200) and is counted once.
#[test]
fn a_job_result_missing_a_declared_slot_renders_200_and_warns_once() {
    let fake = FakeBun::new(default_loader, |req| {
        let mut r = default_jobs(req);
        for res in r["results"].as_array_mut().unwrap() {
            if res["value"].is_object() {
                res["value"] = json!({});
            }
        }
        r
    });
    let s = boot(fake);
    assert_eq!(get(&s, "/pokemon/a", &[]).0, 200);
    let after_first = stats(&s)["missing_slots"].clone();
    assert!(after_first.as_u64().unwrap() >= 1, "{after_first}");
    assert_eq!(get(&s, "/pokemon/b", &[]).0, 200);
    assert_eq!(
        stats(&s)["missing_slots"],
        after_first,
        "once per (component, slot), not per request"
    );
}

/// gzip `bytes` the way the page policy must: flate2 at level 1.
fn gzip_l1(bytes: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(1));
    enc.write_all(bytes).unwrap();
    enc.finish().unwrap()
}

/// Plan m2p Task 3 / S10 amendment: a dynamic page is gzipped only when the
/// client accepts gzip AND the document is >= 16 KiB, at level 1. The cached
/// body's lazy gzip follows the same policy.
#[test]
fn page_gzip_only_at_16k_and_above_at_level_1() {
    // 10 KiB: never gzipped, uncached or cached, MISS or HIT.
    let small = sized_dist(10 * 1024);
    let s = boot_in(fake(), small.path());
    for path in ["/sized-nc", "/sized", "/sized"] {
        let (st, h, body) = request_raw(&s, "GET", path, &[("accept-encoding", "gzip")]);
        assert_eq!(st, 200);
        assert_eq!(
            hdr(&h, "content-encoding"),
            None,
            "{path} {:?}",
            cache_hdr(&h)
        );
        assert!(
            body.len() > 10 * 1024 && body.len() < 16 * 1024,
            "{}",
            body.len()
        );
        assert_eq!(hdr(&h, "vary"), None, "{path}: not gzip-eligible");
        assert!(
            String::from_utf8(body)
                .unwrap()
                .starts_with("<!doctype html>")
        );
    }

    // 20 KiB: gzipped at level 1 when accepted, identity otherwise.
    let big = sized_dist(20 * 1024);
    let s = boot_in(fake(), big.path());
    for path in ["/sized-nc", "/sized", "/sized"] {
        let (_, h, identity) = request_raw(&s, "GET", path, &[("accept-encoding", "identity")]);
        assert_eq!(hdr(&h, "content-encoding"), None, "{path}");
        assert_eq!(hdr(&h, "vary"), Some("Accept-Encoding"), "{path}");
        let (_, h, none) = request_raw(&s, "GET", path, &[]);
        assert_eq!(
            hdr(&h, "content-encoding"),
            None,
            "{path}: no Accept-Encoding"
        );
        assert_eq!(none, identity);
        let (_, h, gz) = request_raw(&s, "GET", path, &[("accept-encoding", "gzip, br")]);
        assert_eq!(hdr(&h, "content-encoding"), Some("gzip"), "{path}");
        assert_eq!(hdr(&h, "vary"), Some("Accept-Encoding"), "{path}");
        assert_eq!(gunzip(&gz), identity, "{path}");
        assert_eq!(gz, gzip_l1(&identity), "{path}: level 1");
    }
}
