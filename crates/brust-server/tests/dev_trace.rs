//! L14: the dev trace header and the dev DOM markers. Present only for a core started with a dev token AND a
//! request carrying it; never cached; absent in production.
mod common;

use std::sync::Arc;

use brust_server::{Server, start};
use common::*;
use serde_json::Value;

const TOKEN: &str = "dev-token-for-tests";

fn boot_dev(token: Option<&str>) -> (Arc<Server>, Arc<FakeBun>) {
    let f = fake();
    let mut cfg = config(&fx());
    cfg.dev_token = token.map(str::to_string);
    let s = start(cfg).expect("start");
    let id = s.register_worker(Box::new(FakeBunHandle(Arc::clone(&f))));
    f.bind(&s, id);
    (s, f)
}

fn unb64(s: &str) -> Vec<u8> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.bytes().filter(|&c| c != b'=') {
        acc = (acc << 6) | T.iter().position(|&t| t == c).expect("base64 char") as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

fn trace(h: &http::HeaderMap) -> Option<Value> {
    let v = h.get("x-brust-dev")?.to_str().unwrap();
    Some(serde_json::from_slice(&unb64(v)).expect("trace JSON"))
}

#[test]
fn no_header_without_the_token_or_without_a_dev_core() {
    let (dev, _) = boot_dev(Some(TOKEN));
    assert!(
        trace(&get(&dev, "/pokemon/pikachu", &[]).1).is_none(),
        "no token header"
    );
    assert!(
        trace(
            &get(
                &dev,
                "/pokemon/bulbasaur",
                &[("x-brust-dev-token", "wrong")]
            )
            .1
        )
        .is_none(),
        "wrong token"
    );
    // production: a core with no dev token ignores the header
    let (prod, _) = boot_dev(None);
    let (st, h, _) = get(&prod, "/pokemon/pikachu", &[("x-brust-dev-token", TOKEN)]);
    assert_eq!(st, 200);
    assert!(h.get("x-brust-dev").is_none());
}

#[test]
fn a_miss_carries_the_route_params_jobs_timings_and_components() {
    let (s, f) = boot_dev(Some(TOKEN));
    let (st, h, _) = get(&s, "/pokemon/pikachu", &[("x-brust-dev-token", TOKEN)]);
    assert_eq!(st, 200);
    let t = trace(&h).expect("trace");
    assert_eq!(t["route"]["id"], "r2");
    assert_eq!(t["route"]["pattern"], "/pokemon/{name}");
    assert_eq!(
        t["route"]["chain"],
        serde_json::json!(["appLayout_a1", "detailPage_c3"])
    );
    assert_eq!(t["route"]["params"]["name"], "pikachu");
    assert_eq!(
        (
            t["status"].clone(),
            t["cache"].clone(),
            t["bun_calls"].clone()
        ),
        (200.into(), "MISS".into(), 1.into())
    );
    assert!(t["loader_ms"].is_number() && t["render_ms"].is_number());
    assert!(t["render_error"].is_null());
    let jobs = t["jobs"].as_array().unwrap();
    assert!(!jobs.is_empty());
    for j in jobs {
        assert_eq!(j["hit"], false, "first request: every job is a miss");
        assert!(
            j["call_id"].is_string() && j["component_id"].is_string() && j["kind"] == "precompute"
        );
    }
    let rendered: Vec<&str> = t["rendered"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(
        rendered.contains(&"appLayout_a1")
            && rendered.contains(&"detailPage_c3")
            && rendered.contains(&"moveCard_d4"),
        "{rendered:?}"
    );
    assert_eq!(f.counts().0, 1);
}

#[test]
fn a_hit_carries_its_own_fresh_trace_and_the_cached_body_none() {
    let (s, _) = boot_dev(Some(TOKEN));
    let tok = [("x-brust-dev-token", TOKEN)];
    let (_, h1, b1) = get(&s, "/pokemon/pikachu", &tok);
    assert_eq!(trace(&h1).unwrap()["cache"], "MISS");
    let (_, h2, b2) = get(&s, "/pokemon/pikachu", &tok);
    let t2 = trace(&h2).expect("a HIT is traced too");
    assert_eq!(t2["cache"], "HIT");
    // nothing of the MISS leaks into the HIT: no loader, no jobs, no render, no worker call
    assert!(t2["loader_ms"].is_null() && t2["render_ms"].is_null());
    assert_eq!(
        (
            t2["jobs"].as_array().unwrap().len(),
            t2["bun_calls"].clone()
        ),
        (0, 0.into())
    );
    assert_eq!(b1, b2);
    // and an untokened HIT carries no trace at all (the L1 entry holds none)
    let (_, h3, _) = get(&s, "/pokemon/pikachu", &[]);
    assert!(h3.get("x-brust-dev").is_none());
}

#[test]
fn dev_markers_wrap_each_chain_level_and_are_absent_in_production_and_in_islands() {
    let (dev, _) = boot_dev(Some(TOKEN));
    let (_, _, body) = get(&dev, "/pokemon/pikachu", &[]);
    assert!(
        body.contains("<!--brust:appLayout_a1-->") && body.contains("<!--brust:detailPage_c3-->"),
        "{body}"
    );
    assert_eq!(body.matches("<!--/brust-->").count(), 2);
    // the leaf is wrapped inside the layout's outlet: layout open ... leaf open ... leaf close ... layout close
    let (a, d) = (
        body.find("<!--brust:appLayout_a1-->").unwrap(),
        body.find("<!--brust:detailPage_c3-->").unwrap(),
    );
    assert!(a < d);
    // /team renders a react island (teamBuilder): no marker inside <brust-island>
    let (_, _, team) = get(&dev, "/team", &[]);
    let mut rest = team.as_str();
    let mut islands = 0;
    while let Some(i) = rest.find("<brust-island") {
        let end = rest[i..].find("</brust-island>").expect("closed island");
        assert!(
            !rest[i..i + end].contains("<!--brust"),
            "marker inside an island: {}",
            &rest[i..i + end]
        );
        islands += 1;
        rest = &rest[i + end..];
    }
    assert!(islands > 0, "the page has an island: {team}");
    // production: not a byte of it
    let (prod, _) = boot_dev(None);
    let (_, _, pbody) = get(&prod, "/pokemon/pikachu", &[]);
    assert!(!pbody.contains("<!--brust"), "{pbody}");
}

#[test]
fn the_dev_token_never_reaches_a_loader_or_an_action() {
    // loader: the request envelope the worker receives carries no x-brust-dev-token
    let (s, f) = boot_dev(Some(TOKEN));
    let (_, h, _) = get(
        &s,
        "/pokemon/pikachu",
        &[("x-brust-dev-token", TOKEN), ("x-other", "kept")],
    );
    assert!(trace(&h).is_some());
    let req = f.last_loader().expect("a loader call");
    let headers = req["req"]["headers"].to_string();
    assert!(
        !headers.contains("x-brust-dev-token") && !headers.contains(TOKEN),
        "{headers}"
    );
    assert!(
        headers.contains("x-other"),
        "other headers still pass: {headers}"
    );

    // action: the A1 request forwarded to the worker carries none either
    let fake = fake().with_fetch(|req| {
        frame(
            200,
            &[("content-type", "application/json")],
            &serde_json::to_vec(&req).unwrap(),
        )
    });
    let mut cfg = config(&fx());
    cfg.dev_token = Some(TOKEN.into());
    cfg.actions = Some(brust_server::ActionsConfig::default());
    let s = start(cfg).expect("start");
    let id = s.register_worker(Box::new(FakeBunHandle(Arc::clone(&fake))));
    fake.bind(&s, id);
    let (st, _, body) = request_body(
        &s,
        "POST",
        "/_brust/action/team",
        &[
            ("x-brust-dev-token", TOKEN),
            ("x-other", "kept"),
            ("content-type", "application/json"),
        ],
        b"{}".to_vec(),
    );
    assert_eq!(st, 200);
    let sent = String::from_utf8(body).unwrap();
    assert!(
        !sent.contains("x-brust-dev-token") && !sent.contains(TOKEN),
        "{sent}"
    );
    assert!(sent.contains("x-other"), "{sent}");
}
