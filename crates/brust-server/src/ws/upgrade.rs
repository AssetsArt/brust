//! F529: a WebSocket upgrade under the actions prefix. The handshake is checked here (400 / 426) and the gates
//! (501 off, 503 draining or full) before the request goes the way of any action — core's cross-site rule (403),
//! then the app's `fetch` on the worker with the fewest sockets (D5), whose route hooks may refuse it like any request.
//! A `101` from the app becomes the switch: the accept headers go on, and a task takes the connection over.
use std::net::SocketAddr;
use std::sync::Arc;

use brust_core::protocol::WsAccepted;
use brust_core::routing::routes::normalize_request_path;
use http::{HeaderValue, Request, Response, StatusCode, header};
use hyper::body::Incoming;
use tokio::sync::mpsc;

use super::WS_PICK;
use super::handshake::{self, Refusal};
use super::hub::{Admit, Opts, WsPick};
use super::socket::{self, Accepted};
use crate::config::Server;
use crate::server::body::{ResponseBody, canned_500, full_body};

/// What the connection a request came on lends a socket: the peer, and a clone of its drain barrier token.
pub(crate) struct ConnCtx {
    pub(crate) peer: SocketAddr,
    pub(crate) token: Option<mpsc::Sender<()>>,
}

/// A GET asking for `Upgrade: websocket` on a path under the actions prefix. Anywhere else the header is ignored
/// (the request is the plain request it also is).
pub(crate) fn wants(req: &Request<Incoming>, server: &Server) -> bool {
    handshake::asks(req.method(), req.headers())
        && server
            .core
            .actions
            .as_ref()
            .is_some_and(|a| a.is_under(&normalize_request_path(req.uri().path())))
}

fn text(status: StatusCode, msg: &str) -> Response<ResponseBody> {
    let mut r = Response::new(full_body(msg.as_bytes().to_vec()));
    *r.status_mut() = status;
    r.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    r
}

pub(crate) async fn handle(
    mut req: Request<Incoming>,
    server: &Server,
    ctx: &ConnCtx,
) -> Response<ResponseBody> {
    let key = match handshake::check(req.version(), req.headers()) {
        Ok(k) => k,
        Err(Refusal::Bad(why)) => return text(StatusCode::BAD_REQUEST, why),
        Err(Refusal::Version) => {
            let mut r = text(
                StatusCode::UPGRADE_REQUIRED,
                "unsupported Sec-WebSocket-Version",
            );
            r.headers_mut().insert(
                header::SEC_WEBSOCKET_VERSION,
                HeaderValue::from_static("13"),
            );
            return r;
        }
    };
    let Some(hub) = server.core.host.pool.ws_hub() else {
        return text(StatusCode::NOT_IMPLEMENTED, "WebSockets are not available");
    };
    let permit = match hub.admit() {
        Ok(p) => p,
        Err(Admit::Off) => {
            return text(StatusCode::NOT_IMPLEMENTED, "WebSockets are not available");
        }
        Err(Admit::Draining) => {
            return text(StatusCode::SERVICE_UNAVAILABLE, "server is shutting down");
        }
        Err(Admit::Full) => {
            return text(
                StatusCode::SERVICE_UNAVAILABLE,
                "too many WebSocket connections",
            );
        }
    };
    let on = hyper::upgrade::on(&mut req);
    let pick = Arc::new(WsPick::default());
    let mut resp = WS_PICK
        .scope(Arc::clone(&pick), crate::pipeline::handle_core(req, server))
        .await;
    if resp.status() != StatusCode::SWITCHING_PROTOCOLS {
        return resp;
    }
    let Some(acc) = resp.extensions_mut().remove::<WsAccepted>() else {
        tracing::error!("a 101 without its accept");
        return canned_500();
    };
    let Some(count) = pick.take() else {
        // The call ran on no worker this request picked: the socket could not be pinned.
        tracing::error!("websocket accept without a picked worker");
        return canned_500();
    };
    let h = resp.headers_mut();
    h.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    h.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
    h.insert(header::SEC_WEBSOCKET_ACCEPT, handshake::accept(&key));
    h.remove(header::CONTENT_LENGTH);
    let opts = Opts::clamp(hub.config(), &acc.opts);
    tokio::spawn(socket::run(
        hub,
        on,
        Accepted {
            local: acc.worker_local_id,
            opts,
            remote: ctx.peer,
            permit,
            count,
            token: ctx.token.clone(),
        },
    ));
    resp
}
