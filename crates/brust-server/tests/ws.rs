//! F529: WebSockets under the actions prefix, end to end over real TCP: a tungstenite client, the fake worker
//! answering the upgrade `fetch` with `101` + `ws`, and a fake [`WsSink`] standing in for the worker's handlers.
mod common;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use brust_core::config::WsConfig;
use brust_server::ws::{BoxFuture, socket_id, socket_parts};
use brust_server::{ActionsConfig, Server, WsData, WsEvent, WsHub, WsSink, start};
use bytes::Bytes;
use common::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

const PATH: &str = "/_brust/action/live";

type Client = WebSocketStream<TcpStream>;

// ----- the fake worker side -----

/// The A2 frame of an accepted upgrade: `101` + `ws: {id, ...opts}`.
fn accept_frame(id: u32, opts: &Value) -> Vec<u8> {
    let mut ws = json!({ "id": id });
    for (k, v) in opts.as_object().unwrap() {
        ws[k] = v.clone();
    }
    let meta =
        serde_json::to_vec(&json!({"status": 101, "headers": [["set-cookie", "sid=1"]], "ws": ws}))
            .unwrap();
    let mut f = (meta.len() as u32).to_le_bytes().to_vec();
    f.extend_from_slice(&meta);
    f
}

/// A worker whose `.ws()` route accepts with `opts`, unless the request carries `x-deny` (a guard's 401).
fn ws_worker(opts: Value) -> Arc<FakeBun> {
    let next = AtomicU32::new(1);
    fake().with_fetch(move |req: Value| {
        let denied = req["headers"]
            .as_array()
            .is_some_and(|h| h.iter().any(|p| p[0] == "x-deny"));
        if denied {
            return frame(401, &[("content-type", "text/plain")], b"no");
        }
        accept_frame(next.fetch_add(1, Ordering::SeqCst), &opts)
    })
}

/// The handlers: every event is logged; `echo` sends a message back; messages park while `hold` is set (D6).
#[derive(Default)]
struct Sink {
    hub: OnceLock<Arc<WsHub>>,
    log: Mutex<Vec<(u32, u32, WsEvent)>>,
    echo: bool,
    hold: Option<tokio::sync::watch::Receiver<bool>>,
}

impl WsSink for Sink {
    fn deliver(&self, worker: u32, local: u32, ev: WsEvent) -> BoxFuture<'static, ()> {
        self.log.lock().unwrap().push((worker, local, ev.clone()));
        if self.echo
            && let WsEvent::Message(d) = &ev
        {
            self.hub
                .get()
                .unwrap()
                .send(socket_id(worker, local), d.clone());
        }
        let hold = self
            .hold
            .clone()
            .filter(|_| matches!(ev, WsEvent::Message(_)));
        Box::pin(async move {
            if let Some(mut h) = hold {
                while *h.borrow() {
                    if h.changed().await.is_err() {
                        return;
                    }
                }
            }
        })
    }
}

impl Sink {
    fn events(&self) -> Vec<(u32, u32, WsEvent)> {
        self.log.lock().unwrap().clone()
    }

    fn of(&self, id: u64) -> Vec<WsEvent> {
        let (w, l) = socket_parts(id);
        self.events()
            .into_iter()
            .filter(|(ew, el, _)| (*ew, *el) == (w, l))
            .map(|(_, _, e)| e)
            .collect()
    }

    fn opened(&self) -> Vec<u64> {
        self.events()
            .into_iter()
            .filter(|(_, _, e)| *e == WsEvent::Open)
            .map(|(w, l, _)| socket_id(w, l))
            .collect()
    }
}

struct App {
    server: Arc<Server>,
    sink: Arc<Sink>,
    workers: Vec<Arc<FakeBun>>,
}

fn app_with(
    ws: WsConfig,
    opts: Value,
    workers: usize,
    sink: Sink,
    cors: Option<brust_server::CorsConfig>,
) -> App {
    let mut cfg = config(&fx());
    cfg.expected_workers = workers as u32;
    cfg.actions = Some(ActionsConfig {
        ws,
        ..ActionsConfig::default()
    });
    cfg.cors = cors;
    let server = start(cfg).expect("start");
    let workers: Vec<Arc<FakeBun>> = (0..workers)
        .map(|_| {
            let f = ws_worker(opts.clone());
            let id = server.register_worker(Box::new(FakeBunHandle(Arc::clone(&f))));
            f.bind(&server, id);
            f
        })
        .collect();
    let sink = Arc::new(sink);
    let _ = sink.hub.set(server.ws_hub());
    assert!(server.set_ws_sink(Arc::clone(&sink) as Arc<dyn WsSink>));
    assert!(
        !server.set_ws_sink(Arc::clone(&sink) as Arc<dyn WsSink>),
        "installed once"
    );
    App {
        server,
        sink,
        workers,
    }
}

fn app(ws: WsConfig) -> App {
    app_with(ws, json!({}), 1, echo_sink(), None)
}

fn echo_sink() -> Sink {
    Sink {
        echo: true,
        ..Default::default()
    }
}

/// Quiet timers unless a test wants them.
fn quiet() -> WsConfig {
    WsConfig {
        idle_timeout_s: 0,
        ping_interval_s: 0,
        ..WsConfig::default()
    }
}

// ----- the client side -----

async fn connect(s: &Server, path: &str, headers: &[(&str, &str)]) -> Result<Client, WsError> {
    let addr = s.local_addr();
    let mut req = format!("ws://{addr}{path}").into_client_request().unwrap();
    for (k, v) in headers {
        req.headers_mut().insert(
            http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
            http::HeaderValue::from_str(v).unwrap(),
        );
    }
    let tcp = TcpStream::connect(addr).await.unwrap();
    tokio_tungstenite::client_async(req, tcp)
        .await
        .map(|(ws, resp)| {
            assert_eq!(resp.status(), 101);
            assert_eq!(
                resp.headers()
                    .get("set-cookie")
                    .and_then(|v| v.to_str().ok()),
                Some("sid=1"),
                "the route's headers ride the 101"
            );
            ws
        })
}

async fn open(s: &Server) -> Client {
    connect(s, PATH, &[]).await.expect("101")
}

fn refused(r: Result<Client, WsError>) -> u16 {
    match r {
        Err(WsError::Http(resp)) => resp.status().as_u16(),
        Err(e) => panic!("{e}"),
        Ok(_) => panic!("upgraded"),
    }
}

/// The next data or close message (pings are answered by tungstenite and skipped).
async fn next(c: &mut Client) -> Message {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), c.next()).await {
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
            Ok(Some(Ok(m))) => return m,
            other => panic!("no message: {other:?}"),
        }
    }
}

/// The close frame the server sent, reading past anything queued before it.
async fn close_of(c: &mut Client) -> CloseFrame {
    loop {
        match next(c).await {
            Message::Close(Some(f)) => return f,
            Message::Close(None) => panic!("close without a frame"),
            _ => continue,
        }
    }
}

async fn until(what: &str, f: impl Fn() -> bool) {
    for _ in 0..500 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

/// A raw request; the response head.
async fn raw(s: &Server, req: &str) -> String {
    let mut tcp = TcpStream::connect(s.local_addr()).await.unwrap();
    tcp.write_all(req.as_bytes()).await.unwrap();
    head_of(&mut tcp).await
}

async fn head_of(tcp: &mut TcpStream) -> String {
    let mut buf = Vec::new();
    let mut b = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = tokio::time::timeout(Duration::from_secs(5), tcp.read(&mut b))
            .await
            .unwrap()
            .unwrap();
        assert!(n > 0, "closed: {}", String::from_utf8_lossy(&buf));
        buf.extend_from_slice(&b[..n]);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn upgrade_req(path: &str, extra: &str) -> String {
    format!("GET {path} HTTP/1.1\r\nHost: x\r\n{extra}\r\n")
}

const GOOD: &str = "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";

// ----- the tests -----

#[tokio::test(flavor = "multi_thread")]
async fn a_socket_echoes_text_and_binary_and_reports_the_peers_close() {
    let a = app(quiet());
    let mut c = open(&a.server).await;
    c.send(Message::text("hi")).await.unwrap();
    assert_eq!(next(&mut c).await, Message::text("hi"));
    c.send(Message::binary(vec![0u8, 1, 255])).await.unwrap();
    assert_eq!(next(&mut c).await, Message::binary(vec![0u8, 1, 255]));
    let id = a.sink.opened()[0];
    assert_eq!(a.server.ws_hub().open_total(), 1);
    assert!(
        a.server
            .ws_hub()
            .remote_addr(id)
            .unwrap()
            .ip()
            .is_loopback()
    );
    c.close(Some(CloseFrame {
        code: 4001.into(),
        reason: "bye".into(),
    }))
    .await
    .unwrap();
    until("the close event", || {
        a.sink
            .of(id)
            .last()
            .is_some_and(|e| matches!(e, WsEvent::Close { .. }))
    })
    .await;
    assert_eq!(
        a.sink.of(id),
        vec![
            WsEvent::Open,
            WsEvent::Message(WsData::Text("hi".into())),
            WsEvent::Message(WsData::Binary(Bytes::from_static(&[0, 1, 255]))),
            WsEvent::Close {
                code: 4001,
                reason: "bye".into()
            },
        ]
    );
    assert_eq!(a.server.ws_hub().open_total(), 0);
    assert_eq!(a.server.ws_hub().open_count(socket_parts(id).0), 0);
    assert_eq!(
        a.server.ws_hub().send(id, WsData::Text("late".into())),
        0,
        "closed: dropped"
    );
    // the upgrade was one ordinary fetch call, carrying the handshake headers
    assert_eq!(a.workers[0].fetch_count(), 1);
    let f = a.workers[0].last_fetch().unwrap();
    assert_eq!(f["method"], "GET");
    assert_eq!(f["url"], PATH);
}

#[tokio::test(flavor = "multi_thread")]
async fn broken_handshakes_are_refused_before_any_worker() {
    let a = app(quiet());
    let bad = [
        (
            "Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n",
            "400",
        ),
        (
            "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n",
            "400",
        ),
        (
            "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: short==\r\n",
            "400",
        ),
        (
            "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n",
            "400",
        ),
    ];
    for (h, want) in bad {
        let head = raw(&a.server, &upgrade_req(PATH, h)).await;
        assert!(head.starts_with(&format!("HTTP/1.1 {want}")), "{h}: {head}");
    }
    let head = raw(
        &a.server,
        &upgrade_req(PATH, "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 8\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"),
    )
    .await;
    assert!(head.starts_with("HTTP/1.1 426"), "{head}");
    assert!(
        head.to_ascii_lowercase()
            .contains("sec-websocket-version: 13"),
        "{head}"
    );
    // HTTP/1.0 cannot upgrade
    let head = raw(
        &a.server,
        &format!("GET {PATH} HTTP/1.0\r\nHost: x\r\n{GOOD}\r\n"),
    )
    .await;
    assert!(
        head.starts_with("HTTP/1.0 400") || head.starts_with("HTTP/1.1 400"),
        "{head}"
    );
    assert_eq!(
        a.workers[0].fetch_count(),
        0,
        "no worker call for a broken handshake"
    );
    // the same raw handshake done right switches, and the accept key is the RFC's
    let head = raw(&a.server, &upgrade_req(PATH, GOOD)).await;
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    assert!(head.contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="), "{head}");
    // outside the prefix the header is ignored: no switch
    let head = raw(&a.server, &upgrade_req("/", GOOD)).await;
    assert!(!head.starts_with("HTTP/1.1 101"), "{head}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_foreign_origin_is_refused_and_a_guard_refusal_keeps_its_status() {
    let a = app(quiet());
    assert_eq!(
        refused(connect(&a.server, PATH, &[("origin", "https://evil.example")]).await),
        403
    );
    assert_eq!(a.workers[0].fetch_count(), 0, "refused before the worker");
    let host = a.server.local_addr().to_string();
    let _same = connect(&a.server, PATH, &[("origin", &format!("http://{host}"))])
        .await
        .expect("same origin");
    let _plain = open(&a.server).await; // no Origin: a non-browser client
    assert_eq!(
        refused(connect(&a.server, PATH, &[("x-deny", "1")]).await),
        401
    );
    until("two sockets", || a.server.ws_hub().open_total() == 2).await;
    assert_eq!(
        a.server.ws_hub().open_count(0),
        2,
        "the refused upgrade is not counted"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_oversized_message_closes_with_1009() {
    let a = app(WsConfig {
        max_payload_bytes: 1024,
        ..quiet()
    });
    let mut c = open(&a.server).await;
    c.send(Message::binary(vec![7u8; 1024])).await.unwrap();
    assert_eq!(
        next(&mut c).await,
        Message::binary(vec![7u8; 1024]),
        "the limit itself passes"
    );
    c.send(Message::binary(vec![7u8; 1025])).await.unwrap();
    let f = close_of(&mut c).await;
    assert_eq!(u16::from(f.code), 1009);
    let id = a.sink.opened()[0];
    until("the close event", || {
        a.sink
            .of(id)
            .iter()
            .any(|e| matches!(e, WsEvent::Close { .. }))
    })
    .await;
    assert!(a.sink.of(id).contains(&WsEvent::Close {
        code: 1009,
        reason: "message too big".into()
    }));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_silent_client_is_closed_after_the_idle_timeout() {
    let a = app(WsConfig {
        idle_timeout_s: 1,
        ..quiet()
    });
    let mut c = open(&a.server).await;
    let t0 = std::time::Instant::now();
    let f = close_of(&mut c).await;
    let took = t0.elapsed();
    assert_eq!(
        (u16::from(f.code), f.reason.as_str()),
        (1001, "idle timeout")
    );
    assert!(
        took >= Duration::from_millis(900) && took < Duration::from_secs(4),
        "{took:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_server_pings_and_hears_the_clients_pings() {
    let a = app(WsConfig {
        ping_interval_s: 1,
        ..quiet()
    });
    let mut c = open(&a.server).await;
    let got = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(Ok(Message::Ping(_))) = c.next().await {
                return;
            }
        }
    })
    .await;
    assert!(got.is_ok(), "no server ping");
    c.send(Message::Ping(Bytes::from_static(b"p1")))
        .await
        .unwrap();
    let pong = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(Ok(Message::Pong(b))) = c.next().await {
                return b;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(&pong[..], b"p1");
    let id = a.sink.opened()[0];
    until("the ping event", || {
        a.sink
            .of(id)
            .contains(&WsEvent::Ping(Bytes::from_static(b"p1")))
    })
    .await;
    // the client's pong to the server's ping reaches the handlers too
    until("a pong event", || {
        a.sink.of(id).iter().any(|e| matches!(e, WsEvent::Pong(_)))
    })
    .await;
    // a route with sendPings: false gets none
    let b = app_with(
        WsConfig {
            ping_interval_s: 1,
            ..quiet()
        },
        json!({"sendPings": false}),
        1,
        echo_sink(),
        None,
    );
    let mut c = open(&b.server).await;
    let none = tokio::time::timeout(Duration::from_millis(1800), async {
        loop {
            if let Some(Ok(Message::Ping(_))) = c.next().await {
                return;
            }
        }
    })
    .await;
    assert!(none.is_err(), "sendPings: false still pinged");
}

/// Fill the outbound queue of a client that does not read; the D7 codes in the order they come.
async fn fill(hub: &WsHub, id: u64) -> Vec<i64> {
    // not a divisor of the limit: the queue holds whole messages, so it cannot land on the limit exactly
    let chunk = "x".repeat(300_000);
    let mut codes = Vec::new();
    for _ in 0..2000 {
        let r = hub.send(id, WsData::Text(chunk.clone()));
        if codes.last() != Some(&r) {
            codes.push(r);
        }
        if r == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    codes
}

#[tokio::test(flavor = "multi_thread")]
async fn back_pressure_answers_minus_one_then_zero_and_drains() {
    let a = app_with(quiet(), json!({}), 1, Sink::default(), None);
    let mut c = open(&a.server).await;
    let id = a.sink.opened()[0];
    let codes = fill(&a.server.ws_hub(), id).await;
    assert_eq!(
        codes,
        vec![300_000, -1, 0],
        "accepted, accepted past the limit, dropped"
    );
    // the client reads everything: the queue empties and the handlers hear `drain`
    let reader = tokio::spawn(async move {
        while let Some(Ok(m)) = c.next().await {
            if m.is_close() {
                break;
            }
        }
    });
    until("the drain event", || {
        a.sink.of(id).contains(&WsEvent::Drain)
    })
    .await;
    assert!(
        a.server.ws_hub().send(id, WsData::Text("after".into())) > 0,
        "accepts again"
    );
    reader.abort();
    // closeOnBackpressureLimit: past the limit the socket closes with 1013
    let b = app_with(
        quiet(),
        json!({"closeOnBackpressureLimit": true, "backpressureLimit": 65536}),
        1,
        Sink::default(),
        None,
    );
    let mut c = open(&b.server).await;
    let id = b.sink.opened()[0];
    let codes = fill(&b.server.ws_hub(), id).await;
    assert_eq!(codes.last(), Some(&0));
    assert_eq!(u16::from(close_of(&mut c).await.code), 1013);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slow_handler_holds_at_eight_unsettled_events_then_delivers_in_order() {
    let (tx, rx) = tokio::sync::watch::channel(true);
    let a = app_with(
        quiet(),
        json!({}),
        1,
        Sink {
            hold: Some(rx),
            ..Default::default()
        },
        None,
    );
    let mut c = open(&a.server).await;
    for i in 0..20 {
        c.send(Message::text(format!("m{i}"))).await.unwrap();
    }
    let id = a.sink.opened()[0];
    until("eight messages", || a.sink.of(id).len() == 9).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        a.sink.of(id).len(),
        9,
        "Open + 8 unsettled messages, no more read"
    );
    tx.send(false).unwrap();
    until("all twenty", || a.sink.of(id).len() == 21).await;
    let got: Vec<WsEvent> = a.sink.of(id).into_iter().skip(1).collect();
    let want: Vec<WsEvent> = (0..20)
        .map(|i| WsEvent::Message(WsData::Text(format!("m{i}"))))
        .collect();
    assert_eq!(got, want);
}

#[tokio::test(flavor = "multi_thread")]
async fn sockets_spread_over_workers_and_topics_cross_them() {
    let a = app_with(quiet(), json!({}), 2, Sink::default(), None);
    let mut cs = Vec::new();
    for _ in 0..4 {
        cs.push(open(&a.server).await);
    }
    until("four sockets", || a.server.ws_hub().open_total() == 4).await;
    let hub = a.server.ws_hub();
    // D5: fewest open sockets first, so 2 + 2
    assert_eq!((hub.open_count(0), hub.open_count(1)), (2, 2));
    assert_eq!(a.workers[0].fetch_count() + a.workers[1].fetch_count(), 4);
    let ids = a.sink.opened();
    let (on0, on1): (Vec<u64>, Vec<u64>) = ids.iter().partition(|&&id| socket_parts(id).0 == 0);
    assert_eq!((on0.len(), on1.len()), (2, 2));
    for &id in &ids {
        assert!(hub.subscribe(id, "room"));
        assert!(hub.is_subscribed(id, "room"));
    }
    assert!(hub.subscribe(ids[0], "other"));
    assert_eq!(
        hub.subscriptions(ids[0]),
        vec!["other".to_string(), "room".to_string()]
    );
    // a socket of worker 0 publishes: every other subscriber gets it, on both workers, itself not
    let from = on0[0];
    assert_eq!(
        hub.publish("room", WsData::Text("hello".into()), Some(from)),
        3 * 5
    );
    for (c, id) in cs.iter_mut().zip(&ids) {
        if *id == from {
            continue;
        }
        assert_eq!(next(c).await, Message::text("hello"));
    }
    // a server-level publish (no except) reaches all four
    assert_eq!(hub.publish("room", WsData::Text("all".into()), None), 4 * 3);
    for c in cs.iter_mut() {
        let m = next(c).await;
        assert_eq!(m, Message::text("all"));
    }
    assert!(hub.unsubscribe(ids[1], "room"));
    assert!(!hub.unsubscribe(ids[1], "room"));
    assert_eq!(hub.publish("room", WsData::Text("x".into()), None), 3);
    assert_eq!(hub.publish("nobody", WsData::Text("x".into()), None), 0);
    // a closed socket leaves its topics
    drop(cs);
    until("all closed", || hub.open_total() == 0).await;
    assert_eq!(hub.publish("room", WsData::Text("x".into()), None), 0);
    assert!(!hub.is_subscribed(ids[0], "other"));
}

#[tokio::test(flavor = "multi_thread")]
async fn publish_to_self_keeps_the_publisher() {
    let a = app_with(
        quiet(),
        json!({"publishToSelf": true}),
        1,
        Sink::default(),
        None,
    );
    let mut c = open(&a.server).await;
    let id = a.sink.opened()[0];
    let hub = a.server.ws_hub();
    hub.subscribe(id, "t");
    assert_eq!(
        hub.publish("t", WsData::Binary(Bytes::from_static(b"me")), Some(id)),
        2
    );
    assert_eq!(next(&mut c).await, Message::binary(b"me".to_vec()));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_app_closes_and_terminates() {
    let a = app(quiet());
    let mut c = open(&a.server).await;
    let id = a.sink.opened()[0];
    a.server.ws_hub().send(id, WsData::Text("first".into()));
    a.server.ws_hub().close(id, 4000, "done");
    assert_eq!(
        next(&mut c).await,
        Message::text("first"),
        "queued frames go out before the close"
    );
    let f = close_of(&mut c).await;
    assert_eq!((u16::from(f.code), f.reason.as_str()), (4000, "done"));
    until("the close event", || {
        a.sink
            .of(id)
            .last()
            .is_some_and(|e| matches!(e, WsEvent::Close { .. }))
    })
    .await;
    assert_eq!(
        a.sink.of(id).last().unwrap(),
        &WsEvent::Close {
            code: 4000,
            reason: "done".into()
        }
    );

    let mut c = open(&a.server).await;
    let id = *a.sink.opened().last().unwrap();
    a.server.ws_hub().terminate(id);
    let end = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match c.next().await {
                None | Some(Err(_)) => return None,
                Some(Ok(Message::Close(f))) => return f,
                Some(Ok(_)) => {}
            }
        }
    })
    .await
    .unwrap();
    assert!(end.is_none(), "terminate sends no close frame: {end:?}");
    until("the close event", || {
        a.sink
            .of(id)
            .last()
            .is_some_and(|e| matches!(e, WsEvent::Close { .. }))
    })
    .await;
    assert_eq!(
        a.sink.of(id).last().unwrap(),
        &WsEvent::Close {
            code: 1006,
            reason: String::new()
        }
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_drain_closes_sockets_with_1001_and_refuses_upgrades_with_503() {
    let a = app(quiet());
    let mut c = open(&a.server).await;
    // a connection that is mid-request when the drain starts finishes that request: an upgrade, refused
    let mut late = TcpStream::connect(a.server.local_addr()).await.unwrap();
    late.write_all(format!("GET {PATH} HTTP/1.1\r\nHost: x\r\n").as_bytes())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    a.server.request_drain(3000);
    let f = close_of(&mut c).await;
    assert_eq!((u16::from(f.code), f.reason.as_str()), (1001, "going away"));
    late.write_all(format!("{GOOD}\r\n").as_bytes())
        .await
        .unwrap();
    let head = head_of(&mut late).await;
    assert!(head.starts_with("HTTP/1.1 503"), "{head}");
    // the client answers the close (tungstenite does it on read): the drain ends well before its deadline
    let t0 = std::time::Instant::now();
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        while c.next().await.is_some() {}
    })
    .await;
    tokio::time::timeout(Duration::from_secs(5), a.server.wait_drain_done())
        .await
        .expect("drain done");
    assert!(t0.elapsed() < Duration::from_secs(2), "{:?}", t0.elapsed());
    let id = a.sink.opened()[0];
    until("the close event", || {
        a.sink
            .of(id)
            .last()
            .is_some_and(|e| matches!(e, WsEvent::Close { .. }))
    })
    .await;
    assert_eq!(
        a.sink.of(id).last().unwrap(),
        &WsEvent::Close {
            code: 1001,
            reason: "going away".into()
        }
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_socket_that_never_answers_the_drain_is_cut_at_the_deadline() {
    let a = app(quiet());
    let _c = open(&a.server).await; // never read: never answers the close
    let t0 = std::time::Instant::now();
    a.server.request_drain(500);
    tokio::time::timeout(Duration::from_secs(5), a.server.wait_drain_done())
        .await
        .expect("drain done");
    let took = t0.elapsed();
    assert!(
        took >= Duration::from_millis(400) && took < Duration::from_secs(3),
        "{took:?}"
    );
    until("closed", || a.server.ws_hub().open_total() == 0).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn max_connections_and_the_off_switches_answer_503_and_501() {
    let a = app(WsConfig {
        max_connections: 1,
        ..quiet()
    });
    let c = open(&a.server).await;
    assert_eq!(refused(connect(&a.server, PATH, &[]).await), 503);
    drop(c);
    until("the first closed", || a.server.ws_hub().open_total() == 0).await;
    let mut ok = false;
    for _ in 0..100 {
        if connect(&a.server, PATH, &[]).await.is_ok() {
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(ok, "the permit came back");

    // enabled = false
    let b = app(WsConfig {
        enabled: false,
        ..quiet()
    });
    assert_eq!(refused(connect(&b.server, PATH, &[]).await), 501);
    assert_eq!(b.workers[0].fetch_count(), 0);

    // no worker side installed
    let mut cfg = config(&fx());
    cfg.actions = Some(ActionsConfig::default());
    let s = start(cfg).expect("start");
    let f = ws_worker(json!({}));
    s.register_worker(Box::new(FakeBunHandle(Arc::clone(&f))));
    assert_eq!(refused(connect(&s, PATH, &[]).await), 501);
    assert_eq!(f.fetch_count(), 0);
}
