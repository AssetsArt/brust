//! F539 (B1): `[csp]` stamps a Content-Security-Policy on HTML responses whose `script-src` holds the sha256 of every
//! inline script brust wrote into the page (base path, actions prefix, actions base URL and credentials), the same on a
//! MISS and an L1 HIT; a loader's own policy wins; nothing else gets the header; no `[csp]` = no header.
mod common;

use brust_core::config::{ActionCredentials, ActionsClient};
use brust_core::csp::{CspConfig, CspMode};
use common::*;
use serde_json::json;
use std::sync::Arc;

/// The fixture app under `/app`.
fn based() -> tempfile::TempDir {
    temp_dist(|m| {
        m["base_path"] = json!("/app");
        for r in m["routes"].as_array_mut().unwrap() {
            let p = r["pattern"].as_str().unwrap().to_string();
            if p != "*" {
                r["pattern"] = json!(if p == "/" {
                    "/app".into()
                } else {
                    format!("/app{p}")
                });
            }
        }
    })
}

fn server(
    fake: Arc<FakeBun>,
    dist: &std::path::Path,
    csp: Option<CspConfig>,
) -> Arc<brust_server::Server> {
    let mut cfg = config(dist);
    cfg.actions = Some(brust_server::ActionsConfig {
        prefix: "/app/api".into(),
        ..Default::default()
    });
    cfg.actions_client = Some(ActionsClient {
        prefix: Some("/app/api".into()),
        base_url: Some("https://api.example".into()),
        credentials: ActionCredentials::Include,
    });
    cfg.csp = csp;
    let s = brust_server::start(cfg).expect("start");
    let id = s.register_worker(Box::new(FakeBunHandle(Arc::clone(&fake))));
    fake.bind(&s, id);
    s
}

/// The text of every attribute-less inline `<script>` of `html`.
fn inline_scripts(html: &str) -> Vec<&str> {
    html.split("<script>")
        .skip(1)
        .map(|s| &s[..s.find("</script>").unwrap()])
        .collect()
}

fn script_src(policy: &str) -> Vec<&str> {
    policy
        .split("; ")
        .find_map(|d| d.strip_prefix("script-src "))
        .unwrap()
        .split(' ')
        .collect()
}

#[test]
fn the_policy_hashes_every_inline_script_the_page_holds() {
    let dist = based();
    let s = server(fake(), dist.path(), Some(CspConfig::default()));
    let mut first = None;
    for want in ["MISS", "HIT"] {
        let (st, h, body) = get(&s, "/app/pokemon/pikachu", &[]);
        assert_eq!(st, 200, "{body}");
        assert_eq!(cache_hdr(&h), Some(want));
        let policy = hdr(&h, "content-security-policy").expect("csp").to_string();
        let scripts = inline_scripts(&body);
        // base path, actions prefix, and base URL + credentials in one element
        assert_eq!(scripts.len(), 3, "{body}");
        assert!(scripts[0].contains("__BRUST_BASE_PATH__"), "{scripts:?}");
        let src = script_src(&policy);
        assert_eq!(src.len(), 1 + scripts.len(), "{policy}");
        for text in &scripts {
            let want = brust_core::csp::script_hashes(&format!("<script>{text}</script>"));
            assert!(
                src.contains(&want[0].as_str()),
                "{text} -> {want:?} not in {policy}"
            );
        }
        assert!(
            policy.contains("connect-src 'self' https://api.example"),
            "{policy}"
        );
        assert!(policy.starts_with("default-src 'self'; "), "{policy}");
        assert_eq!(first.get_or_insert(policy.clone()), &policy);
    }
}

#[test]
fn report_only_sends_the_report_only_header() {
    let dist = based();
    let csp = CspConfig {
        mode: CspMode::ReportOnly,
        ..Default::default()
    };
    let s = server(fake(), dist.path(), Some(csp));
    let (st, h, _) = get(&s, "/app/pokemon/pikachu", &[]);
    assert_eq!(st, 200);
    assert!(hdr(&h, "content-security-policy").is_none());
    assert!(hdr(&h, "content-security-policy-report-only").is_some());
}

#[test]
fn a_loader_policy_wins_on_miss_and_hit() {
    let f = FakeBun::new(
        |req| {
            let mut v = default_loader(req);
            v["headers"] = json!({"content-security-policy": "default-src 'none'"});
            v
        },
        default_jobs,
    );
    let dist = based();
    let s = server(f, dist.path(), Some(CspConfig::default()));
    for want in ["MISS", "HIT"] {
        let (st, h, _) = get(&s, "/app/pokemon/pikachu", &[]);
        assert_eq!(st, 200);
        assert_eq!(cache_hdr(&h), Some(want));
        let all: Vec<_> = h.get_all("content-security-policy").iter().collect();
        assert_eq!(all, ["default-src 'none'"], "{want}");
    }
}

#[test]
fn only_html_gets_it_and_no_csp_is_no_header() {
    let dist = based();
    let on = server(fake(), dist.path(), Some(CspConfig::default()));
    let (_, h, body) = get(&on, "/app/pokemon/pikachu", &[]);
    let asset = body
        .split("src=\"")
        .nth(1)
        .and_then(|s| s.split('"').next())
        .filter(|p| p.contains("/_brust/client/"))
        .expect("a client asset")
        .to_string();
    assert!(hdr(&h, "content-security-policy").is_some());
    let (st, h, _) = get(&on, &asset, &[]);
    assert_eq!(st, 200, "{asset}");
    assert!(hdr(&h, "content-security-policy").is_none(), "{asset}");
    let off = server(fake(), dist.path(), None);
    let (st, h, _) = get(&off, "/app/pokemon/pikachu", &[]);
    assert_eq!(st, 200);
    assert!(hdr(&h, "content-security-policy").is_none());
    assert!(hdr(&h, "content-security-policy-report-only").is_none());
}

#[test]
fn a_bad_csp_refuses_to_boot() {
    let dist = based();
    let mut cfg = config(dist.path());
    cfg.csp = Some(CspConfig {
        script_src: vec!["'unsafe-inline'".into()],
        ..Default::default()
    });
    let e = brust_server::start(cfg).err().expect("refused");
    assert!(
        e.starts_with("csp: ") && e.contains("script_src_unsafe"),
        "{e}"
    );
}
