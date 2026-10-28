//! Shared integration-test helpers (`mod common;` in each test binary). Each
//! binary compiles this module on its own and uses a different subset, so
//! unused items are expected per binary.
#![allow(dead_code)]

pub mod fake_bun;

/// `html` without the `brust-l` level markers (F453: the comments around every inner chain level).
pub fn unmarked(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(i) = rest.find("<!--") {
        let after = &rest[i + 4..];
        let end = after.find("-->").map_or(rest.len(), |e| i + 4 + e + 3);
        let keep = !(after.starts_with("brust-l:") || after.starts_with("/brust-l:"));
        out.push_str(&rest[..if keep { end } else { i }]);
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

use std::path::{Path, PathBuf};
use std::sync::Arc;

use brust_server::{Config, Server, Tuning, start};
use serde_json::{Value, json};

#[allow(unused_imports)]
pub use fake_bun::{FakeBun, FakeBunHandle, FakeEntry, FakeL2, Gate};

/// Every test boots its own server (a runtime, a listener, its connections) and a binary runs its tests in
/// parallel: lift the soft open-file limit toward the hard one once, or a shell at the macOS default (256) fails
/// boots and accepts with EMFILE ("Too many open files").
fn raise_fd_limit() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        #[cfg(unix)]
        // SAFETY: plain getrlimit/setrlimit on a zeroed, owned struct.
        unsafe {
            let mut l: libc::rlimit = std::mem::zeroed();
            // macOS refuses a soft limit over OPEN_MAX (10240) even when the hard one is unlimited.
            if libc::getrlimit(libc::RLIMIT_NOFILE, &mut l) == 0 && l.rlim_cur < 10240 {
                l.rlim_cur = l.rlim_max.min(10240);
                libc::setrlimit(libc::RLIMIT_NOFILE, &l);
            }
        }
    });
}

/// The A2 frame a `fetch` responder answers: `[u32 LE meta_len][meta JSON {status, headers}][body]`.
pub fn frame(status: u16, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
    let meta = serde_json::to_vec(&json!({"status": status, "headers": headers}))
        .expect("frame meta serialises");
    let mut f = (meta.len() as u32).to_le_bytes().to_vec();
    f.extend_from_slice(&meta);
    f.extend_from_slice(body);
    f
}

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
    // Ids are `<componentId>/<jobId>` (chain) or
    // `<parentId>/<childId>_<k>/<jobId>[/<row>]` (child instance); key on
    // `componentId` + the job id so both shapes resolve.
    let component = call["componentId"].as_str().unwrap_or_default();
    let segs: Vec<&str> = id.split('/').collect();
    let job = if segs.first() == Some(&component) {
        segs.get(1).copied()
    } else {
        segs.get(2).copied()
    };
    let value = match (component, job) {
        ("detailPage_c3", Some("j0")) => json!({"_s1": "HP 35"}),
        ("moveCard_d4", Some("j0")) => json!({"_s1": format!(
            "MOVE {}",
            call["inputs"]["move"]["name"].as_str().unwrap_or("?")
        )}),
        ("teamPage_g7", Some("j0")) | ("teamBuilder_h8", Some("ssr"))
            if call["target"] == "teamBuilder_h8" =>
        {
            json!("<ul><li>a</li></ul>")
        }
        _ => panic!("default jobs fake: unexpected job id {id}"),
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
    raise_fd_limit();
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

/// Boot on port 0 from the fixture `dist/` and register `fake` as the one worker, bound to
/// the server so it takes the plan offer (M3-P P6).
pub fn boot(fake: Arc<FakeBun>) -> Arc<Server> {
    boot_in(fake, &fx())
}

/// Like [`boot`] with `tweak` applied to the [`Tuning`] first.
pub fn boot_with(fake: Arc<FakeBun>, tweak: impl FnOnce(&mut Tuning)) -> Arc<Server> {
    let mut cfg = config(&fx());
    tweak(&mut cfg.tuning);
    let s = start(cfg).expect("start");
    let id = s.register_worker(Box::new(FakeBunHandle(Arc::clone(&fake))));
    fake.bind(&s, id);
    s
}

/// Like [`boot`] with another `dist/` (see [`temp_dist`]).
pub fn boot_in(fake: Arc<FakeBun>, dist_dir: &Path) -> Arc<Server> {
    let s = start(config(dist_dir)).expect("start");
    let id = s.register_worker(Box::new(FakeBunHandle(Arc::clone(&fake))));
    fake.bind(&s, id);
    s
}

/// The `L2Config` of the L2 tests: adapter `custom`, namespace `t`, build `b1`.
pub fn l2_config(get_timeout_ms: u64, max_body_bytes: usize) -> brust_core::l2::L2Config {
    brust_core::l2::L2Config {
        adapter: "custom".into(),
        get_timeout: std::time::Duration::from_millis(get_timeout_ms),
        max_body_bytes,
        namespace: "t".into(),
        build_id: "b1".into(),
    }
}

/// Like [`boot_in`] with a cache adapter configured.
pub fn boot_l2(fake: Arc<FakeBun>, dist_dir: &Path, l2: brust_core::l2::L2Config) -> Arc<Server> {
    let mut cfg = config(dist_dir);
    cfg.l2 = Some(l2);
    let s = start(cfg).expect("start");
    let id = s.register_worker(Box::new(FakeBunHandle(Arc::clone(&fake))));
    fake.bind(&s, id);
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

/// Like [`request`], with the body as raw bytes (gzip bodies are not UTF-8).
pub fn request_raw(
    s: &Server,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> (u16, http::HeaderMap, Vec<u8>) {
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
        (parts.status.as_u16(), parts.headers, bytes.to_vec())
    })
}

/// gunzip `bytes` (panics on a malformed stream).
pub fn gunzip(bytes: &[u8]) -> Vec<u8> {
    use std::io::Read;
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_end(&mut out)
        .expect("valid gzip");
    out
}

/// A header's value as `&str`, if present.
pub fn hdr<'a>(h: &'a http::HeaderMap, name: &str) -> Option<&'a str> {
    h.get(name).and_then(|v| v.to_str().ok())
}

/// A copy of the fixture `dist/` with two routes rendering one page whose
/// document is padded to about `pad` bytes of compressible text: `/sized`
/// (L1-cached, tag `sized`) and `/sized-nc` (no cache). The page prints the
/// loader's `who` and one `useId`, so a stale or mis-rendered body shows.
pub fn sized_dist(pad: usize) -> tempfile::TempDir {
    let dist = temp_dist(|m| {
        let routes = m["routes"].as_array_mut().unwrap();
        routes.push(json!({"id": "r9", "pattern": "/sized", "chain": ["appLayout_a1", "sizedPage_z1"],
            "loaders": ["r9"], "cache": {"ttl_seconds": 60, "prefix": null, "bypass": null, "tags": ["sized"]},
            "catch_all": false}));
        routes.push(
            json!({"id": "r10", "pattern": "/sized-nc", "chain": ["appLayout_a1", "sizedPage_z1"],
            "loaders": ["r10"], "cache": null, "catch_all": false}),
        );
        m["components"]["sizedPage_z1"] = json!({"tier": "static",
            "template": "jinja/sizedPage_z1.jinja", "jobs": [], "children": [],
            "client": null, "needs_worker": true, "use_id_slots": 1});
    });
    let words = "lorem ipsum dolor sit amet consectetur ";
    let filler: String = words.chars().cycle().take(pad).collect();
    std::fs::write(
        dist.path().join("jinja/sizedPage_z1.jinja"),
        format!(
            r#"<main id="{{{{ _id0 | attr_str | e }}}}"><h1>{{{{ who | e }}}}</h1><p>{filler}</p></main>"#
        ),
    )
    .unwrap();
    dist
}

/// Like [`boot_in`] with an actions subtree (and optionally CORS) configured (M3-F).
pub fn boot_actions(
    fake: Arc<FakeBun>,
    dist_dir: &Path,
    actions: brust_server::ActionsConfig,
    cors: Option<brust_server::CorsConfig>,
) -> Arc<Server> {
    let mut cfg = config(dist_dir);
    cfg.actions = Some(actions);
    cfg.cors = cors;
    let s = start(cfg).expect("start");
    let id = s.register_worker(Box::new(FakeBunHandle(Arc::clone(&fake))));
    fake.bind(&s, id);
    s
}

/// `e` and its whole `source()` chain, so a hyper failure says which layer (BodyWrite, Io, BrokenPipe …) broke.
fn describe(e: &(dyn std::error::Error + 'static)) -> String {
    let mut out = format!("{e:?}");
    let mut src = e.source();
    while let Some(c) = src {
        out.push_str(&format!(" <- {c:?}"));
        src = c.source();
    }
    out
}

/// One HTTP/1.1 request carrying `body` on a fresh connection (`host: fx` unless given). The error is the
/// full description of what the client saw, so a failing test explains itself (F127).
async fn try_send<B>(
    s: &Server,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: B,
) -> Result<(u16, http::HeaderMap, Vec<u8>), String>
where
    B: http_body::Body<Data = bytes::Bytes> + Send + 'static,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let tcp = tokio::net::TcpStream::connect(s.local_addr())
        .await
        .map_err(|e| format!("connect: {}", describe(&e)))?;
    let (mut sender, conn) =
        hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(tcp))
            .await
            .map_err(|e| format!("handshake: {}", describe(&e)))?;
    tokio::spawn(conn);
    let mut b = http::Request::builder().method(method).uri(path);
    if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("host")) {
        b = b.header("host", "fx");
    }
    for (k, v) in headers {
        b = b.header(*k, *v);
    }
    let resp = sender
        .send_request(b.body(body).unwrap())
        .await
        .map_err(|e| format!("send_request: {}", describe(&e)))?;
    let (parts, body) = resp.into_parts();
    let bytes = http_body_util::BodyExt::collect(body)
        .await
        .map_err(|e| format!("reading the response body: {}", describe(&e)))?
        .to_bytes();
    Ok((parts.status.as_u16(), parts.headers, bytes.to_vec()))
}

async fn send<B>(
    s: &Server,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: B,
) -> (u16, http::HeaderMap, Vec<u8>)
where
    B: http_body::Body<Data = bytes::Bytes> + Send + 'static,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    try_send(s, method, path, headers, body)
        .await
        .unwrap_or_else(|e| panic!("{method} {path}: {e}"))
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}

/// A request with a buffered body (`Full` → the client sends Content-Length).
pub fn request_body(
    s: &Server,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Vec<u8>,
) -> (u16, http::HeaderMap, Vec<u8>) {
    block_on(send(
        s,
        method,
        path,
        headers,
        http_body_util::Full::new(bytes::Bytes::from(body)),
    ))
}

type ChunkStream = tokio_stream::wrappers::ReceiverStream<
    Result<http_body::Frame<bytes::Bytes>, std::convert::Infallible>,
>;

/// A request whose body streams `chunks` with no size hint (→ `Transfer-Encoding: chunked`). A failure panics with
/// the client error AND how many chunks had been handed to the body when it happened.
pub fn request_chunked(
    s: &Server,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    chunks: Vec<Vec<u8>>,
) -> (u16, http::HeaderMap, Vec<u8>) {
    block_on(async {
        let total = chunks.len();
        let handed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        let counted = Arc::clone(&handed);
        tokio::spawn(async move {
            for c in chunks {
                if tx
                    .send(Ok(http_body::Frame::data(bytes::Bytes::from(c))))
                    .await
                    .is_err()
                {
                    return;
                }
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        });
        let body: http_body_util::StreamBody<ChunkStream> =
            http_body_util::StreamBody::new(tokio_stream::wrappers::ReceiverStream::new(rx));
        try_send(s, method, path, headers, body).await.unwrap_or_else(|e| {
            panic!(
                "{method} {path}: {e}; chunks handed to the body: {}/{total} (the server may have answered and closed first)",
                handed.load(std::sync::atomic::Ordering::SeqCst)
            )
        })
    })
}

/// A request whose body never ends (the sender stays alive); panics unless the answer arrives
/// within 2 s — proof the server answered without reading the body.
pub fn request_open_body(
    s: &Server,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> (u16, http::HeaderMap, Vec<u8>) {
    block_on(async {
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        tx.send(Ok(http_body::Frame::data(bytes::Bytes::from_static(b"x"))))
            .await
            .unwrap();
        let body: http_body_util::StreamBody<ChunkStream> =
            http_body_util::StreamBody::new(tokio_stream::wrappers::ReceiverStream::new(rx));
        let r = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            send(s, method, path, headers, body),
        )
        .await
        .unwrap_or_else(|_| panic!("{method} {path}: no answer within 2 s (body read?)"));
        drop(tx);
        r
    })
}
