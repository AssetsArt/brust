//! Shared integration-test helpers (`mod common;` in each test binary). Each
//! binary compiles this module on its own and uses a different subset, so
//! unused items are expected per binary.
#![allow(dead_code)]

pub mod fake_bun;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use brust_server::{Config, Server, Tuning, start};
use serde_json::{Value, json};

pub use fake_bun::{FakeBun, FakeBunHandle};

pub fn fx() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/dist")
}

/// Default `loader`: the same data for every route; `pokemon.name` = the
/// `name` param (null when the route has none).
pub fn default_loader(req: Value) -> Value {
    json!({"ok": true, "data": {
        "pokemon": {
            "name": req["params"]["name"],
            "stats": {"hp": 35},
            "moves": [{"name": "tackle"}, {"name": "growl"}]
        },
        "team": ["a"],
        "who": "anon"
    }})
}

/// One `jobs` result for one job call (the default fake's rules).
pub fn default_job(call: &Value) -> Value {
    let id = call["id"].as_str().unwrap_or_default();
    let value = if id.ends_with("detailPage_c3/j0") {
        json!({"_s1": "HP 35"})
    } else if id.starts_with("moveCard_d4/j0/") {
        json!({"_s1": format!("MOVE {}", call["inputs"]["move"]["name"].as_str().unwrap_or("?"))})
    } else if id == "teamBuilder_h8/ssr" {
        json!("<ul><li>a</li></ul>")
    } else {
        panic!("default jobs fake: unexpected job id {id}")
    };
    json!({"id": id, "value": value})
}

/// Default `jobs`: one result per call via [`default_job`].
pub fn default_jobs(req: Value) -> Value {
    let results: Vec<Value> = req["jobs"]
        .as_array()
        .expect("jobs array")
        .iter()
        .map(default_job)
        .collect();
    json!({ "results": results })
}

pub fn fake() -> Arc<FakeBun> {
    FakeBun::new(default_loader, default_jobs)
}

pub fn config(dist_dir: &Path) -> Config {
    Config {
        addr: "127.0.0.1:0".parse().unwrap(),
        dist_dir: dist_dir.to_path_buf(),
        expected_workers: 1,
        tuning: Tuning {
            claim_timeout_ms: 500,
            ..Default::default()
        },
        ..Default::default()
    }
}

/// Boot on port 0 from the fixture `dist/` and register `fake` as the one worker.
pub fn boot(fake: Arc<FakeBun>) -> Arc<Server> {
    boot_in(fake, &fx())
}

/// Like [`boot`] with another `dist/` (see [`temp_dist`]).
pub fn boot_in(fake: Arc<FakeBun>, dist_dir: &Path) -> Arc<Server> {
    let s = start(config(dist_dir)).expect("start");
    s.register_worker(Box::new(FakeBunHandle(fake)));
    s
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let dst = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &dst);
        } else {
            std::fs::copy(e.path(), dst).unwrap();
        }
    }
}

/// A copy of the fixture `dist/` with `edit` applied to its manifest JSON.
pub fn temp_dist(edit: impl FnOnce(&mut Value)) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    copy_dir(&fx(), dir.path());
    let mp = dir.path().join("manifest.json");
    let mut m: Value = serde_json::from_slice(&std::fs::read(&mp).unwrap()).unwrap();
    edit(&mut m);
    std::fs::write(&mp, serde_json::to_vec(&m).unwrap()).unwrap();
    dir
}

pub fn get(s: &Server, path: &str, headers: &[(&str, &str)]) -> (u16, http::HeaderMap, String) {
    request(s, "GET", path, headers)
}

pub fn request(
    s: &Server,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> (u16, http::HeaderMap, String) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let tcp = tokio::net::TcpStream::connect(s.local_addr())
            .await
            .unwrap();
        let (mut sender, conn) =
            hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(tcp))
                .await
                .unwrap();
        tokio::spawn(conn);
        let mut b = http::Request::builder()
            .method(method)
            .uri(path)
            .header("host", "fx");
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        let resp = sender
            .send_request(
                b.body(http_body_util::Empty::<bytes::Bytes>::new())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (parts, body) = resp.into_parts();
        let bytes = http_body_util::BodyExt::collect(body)
            .await
            .unwrap()
            .to_bytes();
        (
            parts.status.as_u16(),
            parts.headers,
            String::from_utf8_lossy(&bytes).into_owned(),
        )
    })
}

/// `/_brust/cache/stats` parsed.
pub fn stats(s: &Server) -> Value {
    let (status, _, body) = get(s, "/_brust/cache/stats", &[]);
    assert_eq!(status, 200, "{body}");
    serde_json::from_str(&body).expect("stats JSON")
}

/// The `x-brust-cache` header, if any.
pub fn cache_hdr(h: &http::HeaderMap) -> Option<&str> {
    h.get("x-brust-cache").and_then(|v| v.to_str().ok())
}
