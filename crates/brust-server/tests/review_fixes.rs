//! Review round 2 (probes against real compiler output): chain slot scoping,
//! `_props`, decoded L1 query, namespaced `cache({key})`, verdict sanity, miss
//! de-dup. Every test boots its own server on port 0.
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

/// Fix 1 (A_chainpre shape): a layout and its page each have a precompute job
/// writing `_s1`. Each must print its own value, on the MISS and on the L1 HIT.
#[test]
fn chain_precompute_slots_are_per_component() {
    let d = temp_dist(|m| {
        m["components"]["appLayout_a1"]["jobs"] = json!([{ "id": "j0", "kind": "precompute",
            "inputs": ["pokemon.name"], "per_instance": null,
            "cache": { "key": null, "tags": [], "ttl_seconds": null } }]);
        m["components"]["appLayout_a1"]["needs_worker"] = json!(true);
    });
    std::fs::write(
        d.path().join("jinja/appLayout_a1.jinja"),
        "<!doctype html><html><body><nav>{{ _s1 | e }}</nav>{{ __outlet | safe }}</body></html>",
    )
    .unwrap();
    let f = FakeBun::new(default_loader, |req: Value| {
        let results: Vec<Value> = req["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                if c["componentId"] == "appLayout_a1" {
                    json!({"id": c["id"], "value": {"_s1": "LAYOUT"}})
                } else {
                    default_job(c)
                }
            })
            .collect();
        json!({ "results": results })
    });
    let s = boot_in(f.clone(), d.path());
    for want in ["MISS", "HIT"] {
        let (st, h, b) = get(&s, "/pokemon/pikachu", &[]);
        assert_eq!(st, 200, "{b}");
        assert_eq!(cache_hdr(&h), Some(want));
        assert!(b.contains("<nav>LAYOUT</nav>"), "{want} layout slot: {b}");
        assert!(b.contains("<p>HP 35</p>"), "{want} page slot: {b}");
    }
}

/// Fix 2: a chain template printing `{{ _props | json_attr }}` (client-only
/// host / react page) gets the merged loader context, not `null`, and never
/// the server slots.
#[test]
fn chain_template_props_carry_loader_context() {
    let d = temp_dist(|_| {});
    std::fs::write(
        d.path().join("jinja/teamPage_g7.jinja"),
        "<main x-props='{{ _props | json_attr }}'>{{ _ssr_teamBuilder_h8 | safe }}</main>",
    )
    .unwrap();
    let s = boot_in(fake(), d.path());
    let (st, _, b) = get(&s, "/team", &[]);
    assert_eq!(st, 200, "{b}");
    assert!(b.contains("&quot;team&quot;:[&quot;a&quot;]"), "{b}");
    assert!(b.contains("&quot;who&quot;:&quot;anon&quot;"), "{b}");
    assert!(b.contains("&quot;path&quot;:&quot;/team&quot;"), "{b}");
    assert!(!b.contains("__children"), "{b}");
    assert!(!b.contains("__own"), "{b}");
    assert!(!b.contains("x-props='null'"), "{b}");
}

/// Loader for the `/tenant` (r3) probes: `who` reflects the decoded query the
/// loader sees, so a wrongly cached page is visible.
fn tenant_fake() -> std::sync::Arc<FakeBun> {
    FakeBun::new(
        |req: Value| {
            let q = &req["req"]["search"];
            let who = if q["preview"].is_string() || q["mode"] == "draft" {
                "DRAFT"
            } else {
                "public"
            };
            json!({"ok": true, "data": {"who": who}})
        },
        default_jobs,
    )
}

fn who(body: &str) -> &str {
    body.split("<p>")
        .nth(1)
        .and_then(|x| x.split('<').next())
        .unwrap_or("")
}

/// Fix 3: the L1 bypass sees decoded query names: `?pre%76iew=1` is the
/// loader's `preview`, so it must BYPASS a `query(preview)` route.
#[test]
fn encoded_query_name_still_bypasses() {
    let d = temp_dist(|m| {
        m["routes"][2]["cache"]["bypass"] = json!("query(preview)");
        m["routes"][2]["cache"]["prefix"] = Value::Null;
    });
    let s = boot_in(tenant_fake(), d.path());
    for _ in 0..2 {
        let (st, h, b) = get(&s, "/tenant?pre%76iew=1", &[]);
        assert_eq!(st, 200, "{b}");
        assert_eq!(cache_hdr(&h), Some("BYPASS"), "{b}");
        assert_eq!(who(&b), "DRAFT");
    }
    assert_eq!(stats(&s)["l1"]["len"], 0);
}

/// Fix 3: query values are decoded too: `mode=dr%61ft` is `draft`.
#[test]
fn encoded_query_value_matches_eq() {
    let d = temp_dist(|m| {
        m["routes"][2]["cache"]["bypass"] = json!(r#"eq(query(mode), "draft")"#);
        m["routes"][2]["cache"]["prefix"] = Value::Null;
    });
    let s = boot_in(tenant_fake(), d.path());
    for _ in 0..2 {
        let (st, h, b) = get(&s, "/tenant?mode=dr%61ft", &[]);
        assert_eq!(st, 200, "{b}");
        assert_eq!(cache_hdr(&h), Some("BYPASS"), "{b}");
        assert_eq!(who(&b), "DRAFT");
    }
    let (_, h, b) = get(&s, "/tenant?mode=live", &[]);
    assert_eq!(cache_hdr(&h), Some("MISS"));
    assert_eq!(who(&b), "public");
}

/// Fix 4: `cache({key})` keys are namespaced per component + job, so two
/// components keyed on the same value don't share an entry; `invalidate({key})`
/// still addresses every entry under that user key.
#[test]
fn cache_key_is_namespaced_and_invalidates_by_user_key() {
    let d = temp_dist(|m| {
        m["components"]["detailPage_c3"]["jobs"][0]["cache"]["key"] =
            json!("pokemon.moves[0].name");
        m["components"]["moveCard_d4"]["jobs"][0]["cache"]["key"] = json!("move.name");
    });
    let f = fake();
    let s = boot_in(f.clone(), d.path());
    let (st, _, b1) = get(&s, "/pokemon/pikachu", &[]);
    assert_eq!(st, 200, "{b1}");
    assert!(b1.contains("<p>HP 35</p>"), "{b1}");
    let (st, _, b2) = get(&s, "/pokemon/raichu", &[]);
    assert_eq!(st, 200, "{b2}");
    assert!(
        b2.contains("<p>HP 35</p>"),
        "detail j0 got moveCard's value: {b2}"
    );
    assert!(b2.contains("tackle: MOVE tackle"), "{b2}");
    assert_eq!(f.counts().1, 1, "second page is all job-cache hits");

    let r = s.invalidate(InvalidateArgs {
        key: Some("tackle".into()),
        ..Default::default()
    });
    assert_eq!(r.job_removed, 2, "both components' 'tackle' entries");
    let (st, _, _) = get(&s, "/pokemon/bulbasaur", &[]);
    assert_eq!(st, 200);
    assert_eq!(
        job_ids(&f),
        ["detailPage_c3/j0", "detailPage_c3/moveCard_d4_1/j0/0"],
        "only the invalidated entries are recomputed"
    );
}

/// Fix 7: verdicts are sanity-checked: a redirect status outside 300-308
/// becomes 302; a Location that is not a valid header value is a 500; an
/// httpError status outside 400-599 is a 500.
#[test]
fn verdict_status_and_location_are_validated() {
    let f = FakeBun::new(
        |req| match req["params"]["name"].as_str() {
            Some("r200") => json!({"verdict": "redirect", "location": "/x", "status": 200}),
            Some("r309") => json!({"verdict": "redirect", "location": "/x", "status": 309}),
            Some("r308") => json!({"verdict": "redirect", "location": "/x", "status": 308}),
            Some("crlf") => {
                json!({"verdict": "redirect", "location": "/x\r\nSet-Cookie: pwn=1"})
            }
            Some("e204") => json!({"verdict": "httpError", "status": 204, "body": "hi"}),
            Some("e0") => json!({"verdict": "httpError", "status": 0, "body": "hi"}),
            Some("e600") => json!({"verdict": "httpError", "status": 600, "body": "hi"}),
            Some("e503") => json!({"verdict": "httpError", "status": 503, "body": "down"}),
            _ => default_loader(req),
        },
        default_jobs,
    );
    let s = boot(f);
    for (name, want) in [("r200", 302), ("r309", 302), ("r308", 308)] {
        let (st, h, _) = get(&s, &format!("/pokemon/{name}"), &[]);
        assert_eq!(st, want, "{name}");
        assert_eq!(h.get("location").unwrap(), "/x", "{name}");
    }
    let (st, h, _) = get(&s, "/pokemon/crlf", &[]);
    assert_eq!(st, 500);
    assert!(h.get("location").is_none());
    assert!(h.get("set-cookie").is_none());
    for name in ["e204", "e0", "e600"] {
        let (st, _, b) = get(&s, &format!("/pokemon/{name}"), &[]);
        assert_eq!(
            (st, b.as_str()),
            (500, "500 Internal Server Error"),
            "{name}"
        );
    }
    let (st, _, b) = get(&s, "/pokemon/e503", &[]);
    assert_eq!((st, b.as_str()), (503, "down"));
}

/// Fix 10: identical job keys missing in one request are computed once and
/// fanned out to every row that needs them.
#[test]
fn identical_misses_are_sent_once() {
    let f = FakeBun::new(
        |_| {
            json!({"ok": true, "data": {"pokemon": {"name": "ditto", "stats": {"hp": 48},
            "moves": [{"name": "tackle"}, {"name": "tackle"}]}}})
        },
        default_jobs,
    );
    let s = boot(f.clone());
    let (st, _, b) = get(&s, "/pokemon/ditto", &[]);
    assert_eq!(st, 200, "{b}");
    assert_eq!(
        job_ids(&f),
        ["detailPage_c3/j0", "detailPage_c3/moveCard_d4_1/j0/0"]
    );
    assert_eq!(b.matches("tackle: MOVE tackle").count(), 2, "{b}");
}
