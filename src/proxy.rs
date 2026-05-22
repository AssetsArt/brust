use http::{Response, StatusCode};
use tokio::sync::OnceCell;
use tracing::{error, warn};

use crate::ipc::{recv_frame, send_frame, Frame};
use crate::pool::WorkerPool;
use crate::router::RouteTable;

pub struct Brust {
    pub pool: OnceCell<WorkerPool>,
    pub router: OnceCell<RouteTable>,
}

impl Brust {
    pub fn new() -> Self {
        Self {
            pool: OnceCell::new(),
            router: OnceCell::new(),
        }
    }
}

pub async fn handle_path(brust: &Brust, path: &str) -> Response<Vec<u8>> {
    let pool = match brust.pool.get() {
        Some(p) => p,
        None => return text_response(StatusCode::SERVICE_UNAVAILABLE, b"workers not ready"),
    };
    let router = brust.router.get().expect("router set together with pool");

    let route_id = match router.match_path(path) {
        Some(id) => id,
        None => return text_response(StatusCode::NOT_FOUND, b"not found"),
    };

    let worker = pool.pick_least_busy();
    let _guard = worker.in_flight_guard();
    let mut stream = worker.socket.lock().await;

    if let Err(e) = send_frame(&mut *stream, &Frame::Render {
        route_id,
        url: path.to_owned(),
    })
    .await
    {
        error!(worker_id = worker.id, error = %e, "send_frame failed");
        return text_response(StatusCode::BAD_GATEWAY, b"upstream send failed");
    }

    match recv_frame(&mut *stream).await {
        Ok(Frame::RenderOk { html }) => html_response(StatusCode::OK, html.into_bytes()),
        Ok(Frame::RenderErr { message }) => {
            warn!(worker_id = worker.id, %message, "render error");
            text_response(StatusCode::INTERNAL_SERVER_ERROR, message.as_bytes())
        }
        Ok(other) => {
            error!(worker_id = worker.id, ?other, "unexpected frame from worker");
            text_response(StatusCode::BAD_GATEWAY, b"unexpected upstream frame")
        }
        Err(e) => {
            error!(worker_id = worker.id, error = %e, "recv_frame failed; worker likely dead");
            // Skeleton: fail loud. The supervisor will notice on the next health check, but
            // we don't have health checks yet, so we return 502 to the client. Subsequent
            // requests routed to this worker will also fail; the process should be restarted
            // by the operator.
            text_response(StatusCode::BAD_GATEWAY, b"upstream connection lost")
        }
    }
}

fn html_response(status: StatusCode, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(http::header::CONTENT_LENGTH, body.len())
        .body(body)
        .expect("response builds")
}

fn text_response(status: StatusCode, body: &[u8]) -> Response<Vec<u8>> {
    let body = body.to_vec();
    Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(http::header::CONTENT_LENGTH, body.len())
        .body(body)
        .expect("response builds")
}
