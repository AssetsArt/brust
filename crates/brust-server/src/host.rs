//! `NativeHost`: the [`Host`] the core pipeline runs on here — the Bun worker pool behind the SAB
//! dispatch seam, `dist/` on the local disk, hyper bodies and tokio timers.
use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use brust_core::body::{header_str, is_request_hop_header};
use brust_core::config::ACTION_INLINE_BODY_BYTES;
use brust_core::host::{ActionCall, ActionReply, CallError, Clock, Host, ReadErr, StaticRoot};
use brust_core::plan::{PlanCell, PlanSeed, PlannedCall};
use brust_core::protocol::{
    FetchBody, FetchRequest, JobsRequest, JobsResponse, LoaderRequest, LoaderResponse,
};
use brust_core::static_rules::content_type_for;
use bytes::Bytes;
use http::{HeaderMap, Response};
use http_body_util::BodyExt;
use hyper::body::Incoming;

use crate::cache::job_cache::JobCache;
use crate::cache::l1::L1Cache;
use crate::dispatch::{
    CallKind, call_worker, call_worker_cache_get, call_worker_cache_set, call_worker_fetch,
    call_worker_planned,
};
use crate::pool::{PlanBox, WorkerPool};
use crate::server::static_assets::static_asset_response;
use brust_core::l2::{L2Counters, L2Key, L2Lookup, L2Page, L2Probe, L2SetMeta};

/// The worker pool, the served `dist/` and the two call timeouts.
pub(crate) struct NativeHost {
    pub(crate) pool: Arc<WorkerPool>,
    pub(crate) dist_dir: PathBuf,
    pub(crate) claim_timeout: Duration,
    pub(crate) call_timeout: Duration,
    /// L10: the cap `put_fetch_reply` applies to a loader/jobs heap reply.
    pub(crate) max_loader_response_bytes: usize,
    /// The cache adapter's `(get_timeout, max_body_bytes)`; `None` = no L2 calls.
    pub(crate) l2: Option<(Duration, usize)>,
}

impl Clock for NativeHost {
    /// Nanoseconds since the first reading in this process (`Instant`: monotonic).
    #[inline]
    fn now_ns(&self) -> u64 {
        static EPOCH: LazyLock<Instant> = LazyLock::new(Instant::now);
        EPOCH.elapsed().as_nanos() as u64
    }

    fn wall_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64)
    }
}

impl Host for NativeHost {
    type Body = Incoming;
    type L1 = L1Cache;
    type Jobs = JobCache;
    const PLAN_OFFER: bool = true;

    /// The seed rides the claimed slot's plan cell (one `Box`); after the call the cell holds the
    /// plan `plan_in_call` built, or nothing (declined, or not offered).
    async fn loader(
        &self,
        req: &LoaderRequest<'_>,
        offer: Option<PlanSeed>,
    ) -> Result<(LoaderResponse, Option<PlannedCall>), CallError> {
        let seed = offer.map(|s| -> PlanBox { Box::new(PlanCell::Seed(s)) });
        let (r, cell) = call_worker_planned::<_, LoaderResponse>(
            &self.pool,
            self.claim_timeout,
            self.call_timeout,
            CallKind::Loader,
            req,
            seed,
        )
        .await?;
        let planned = match cell.and_then(|b| b.downcast::<PlanCell>().ok()).map(|b| *b) {
            Some(PlanCell::Planned(pc)) => Some(pc),
            _ => None,
        };
        Ok((r, planned))
    }

    async fn jobs(&self, req: &JobsRequest<'_>) -> Result<JobsResponse, CallError> {
        call_worker::<_, JobsResponse>(
            &self.pool,
            self.claim_timeout,
            self.call_timeout,
            CallKind::Jobs,
            req,
        )
        .await
    }

    async fn read_body(&self, body: Incoming, cap: usize) -> Result<Bytes, ReadErr> {
        read_capped(body, cap, self.call_timeout).await
    }

    /// One `fetch` worker call. A body over [`ACTION_INLINE_BODY_BYTES`] waits in the call's cell
    /// for `takeFetchBody` (F82); a smaller one crosses inline as text or base64 (R2).
    async fn action(&self, call: ActionCall<'_>) -> Result<ActionReply, CallError> {
        let (fb, heap_body) = match call.body {
            None => (None, None),
            Some(b) if b.len() > ACTION_INLINE_BODY_BYTES => {
                (Some(FetchBody::Heap(b.len())), Some(b))
            }
            Some(b) => (
                Some(brust_core::actions::encode_body(
                    header_str(call.headers, "content-type")
                        .as_deref()
                        .unwrap_or(""),
                    b,
                )),
                None,
            ),
        };
        let full = call.full;
        let query = full.split_once('?').map_or("", |(_, q)| q);
        let pairs = worker_request_headers(call.headers, call.authority);
        let req = FetchRequest {
            method: call.method,
            url: full,
            headers: pairs,
            body: fb,
            req: brust_core::routing::routes::build_request_envelope(
                call.method,
                full,
                query,
                call.headers,
                None,
            ),
        };
        call_worker_fetch(
            &self.pool,
            self.claim_timeout,
            self.call_timeout,
            &req,
            heap_body,
        )
        .await
        .map(ActionReply::Fetch)
    }

    /// `/_brust/<rel>` serves `dist/client/` only (`safe_rel` admits `client/<file>`), `/public/`
    /// serves `dist/public/`; a symlink out of the served directory or a missing file is `None`.
    async fn static_file(
        &self,
        root: StaticRoot,
        rel: &str,
        headers: &HeaderMap,
        head: bool,
    ) -> Option<Response<Bytes>> {
        let served = match root {
            StaticRoot::Brust => self.dist_dir.join("client"),
            StaticRoot::Public => self.dist_dir.join("public"),
        };
        let file = match root {
            StaticRoot::Brust => self.dist_dir.join(rel),
            StaticRoot::Public => served.join(rel),
        };
        if !inside_root(&served, &file).await {
            return None;
        }
        let bytes = tokio::fs::read(&file).await.ok()?;
        let accept_enc = header_str(headers, "accept-encoding").unwrap_or_default();
        Some(static_asset_response(
            &accept_enc,
            content_type_for(&file),
            &file.to_string_lossy(),
            bytes,
            head,
            false,
        ))
    }

    /// One `cache` `get` on any worker, the claim and the call bounded by `get_timeout` (R2, R7):
    /// a timed-out call's remainder keeps its slot until JS settles (`Detach`), as any call's.
    async fn l2_get(&self, p: &L2Probe<'_>) -> L2Lookup {
        let Some((get_timeout, cap)) = self.l2 else {
            return L2Lookup::Off;
        };
        let call = call_worker_cache_get(
            &self.pool,
            self.claim_timeout,
            self.call_timeout,
            &p.key.0,
            cap,
        );
        match tokio::time::timeout(get_timeout, call).await {
            Err(_) | Ok(Err(CallError::Deadline)) => L2Lookup::Timeout,
            Ok(Err(e)) => L2Lookup::Failed(e.to_string()),
            Ok(Ok(l)) => l,
        }
    }

    /// A background `cache` `set` that never waits for a slot: none free → dropped (R2, R5).
    fn l2_set(&self, key: L2Key, page: L2Page, meta: L2SetMeta, counters: &Arc<L2Counters>) {
        let (pool, call_timeout, n) = (
            Arc::clone(&self.pool),
            self.call_timeout,
            Arc::clone(counters),
        );
        tokio::spawn(async move {
            let r = call_worker_cache_set(&pool, Duration::ZERO, call_timeout, &key.0, page, &meta)
                .await;
            n.bump(match r {
                Ok(true) => "sets",
                Ok(false) => "set_refused",
                Err(CallError::Timeout | CallError::NoWorkers) => "set_dropped",
                Err(_) => "errors",
            });
        });
    }
}

/// `file` resolved through every symlink still lies under `root` (resolved
/// too: `dist/` itself may sit behind a symlink). A symlink under `dist/` that
/// points outside the served directory, or a missing file, is `false`.
async fn inside_root(root: &std::path::Path, file: &std::path::Path) -> bool {
    let (Ok(root), Ok(file)) = (
        tokio::fs::canonicalize(root).await,
        tokio::fs::canonicalize(file).await,
    ) else {
        return false;
    };
    file.starts_with(&root) && file != root
}

/// After a body is refused (over the cap) this much more of it is read and thrown away, for at most
/// [`DISCARD_TIMEOUT`], so the client has finished sending when the connection closes. A server that answers and
/// closes while the client is still writing makes the kernel reset the connection: the client then sees
/// `EPIPE`/`ECONNRESET` instead of the 413 that is already on the wire (F127). A body longer than this still ends
/// in a reset: the bound is what keeps a refused upload from holding the connection.
const DISCARD_AFTER_REFUSAL: usize = 1 << 20;
const DISCARD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// The headers an action's `Request` carries: the client's, less the hop-by-hop pair and the dev token (F474: the
/// client's `Content-Length` stays), and `host` from `:authority` when HTTP/2 sent none (R8).
fn worker_request_headers<'a>(
    headers: &'a HeaderMap,
    authority: Option<&str>,
) -> Vec<(Cow<'a, str>, Cow<'a, str>)> {
    let mut pairs: Vec<(Cow<str>, Cow<str>)> = headers
        .iter()
        .filter(|(n, _)| {
            !is_request_hop_header(n.as_str())
                && n.as_str() != brust_core::trace::REQUEST_TOKEN_HEADER
        })
        .map(|(n, v)| {
            (
                Cow::Borrowed(n.as_str()),
                String::from_utf8_lossy(v.as_bytes()),
            )
        })
        .collect();
    if !headers.contains_key(http::header::HOST)
        && let Some(au) = authority
    {
        pairs.push((Cow::Borrowed("host"), Cow::Owned(au.to_owned())));
    }
    pairs
}

/// The whole body, at most `cap` bytes. A declared Content-Length over the cap is refused before any byte is kept; a
/// chunked body is refused the moment it passes the cap; the whole read must finish within `deadline`. A refused body
/// is then drained (see [`DISCARD_AFTER_REFUSAL`]) before `TooLarge` is returned.
async fn read_capped<B>(b: B, cap: usize, deadline: std::time::Duration) -> Result<Bytes, ReadErr>
where
    B: http_body::Body<Data = Bytes>,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let mut b = std::pin::pin!(b);
    let mut over = b.size_hint().lower() > cap as u64;
    let mut kept: Vec<u8> = Vec::new();
    let mut seen = 0usize;
    if !over {
        let read = async {
            while let Some(frame) = b.frame().await {
                let Ok(frame) = frame else {
                    return Err(ReadErr::Io);
                };
                if let Ok(data) = frame.into_data() {
                    seen += data.len();
                    if seen > cap {
                        over = true;
                        return Ok(());
                    }
                    kept.extend_from_slice(&data);
                }
            }
            Ok(())
        };
        match tokio::time::timeout(deadline, read).await {
            Err(_) => return Err(ReadErr::Slow),
            Ok(Err(e)) => return Err(e),
            Ok(Ok(())) => {}
        }
    }
    if !over {
        return Ok(Bytes::from(kept));
    }
    let mut discarded = 0usize;
    let _ = tokio::time::timeout(DISCARD_TIMEOUT, async {
        while discarded < DISCARD_AFTER_REFUSAL {
            match b.frame().await {
                Some(Ok(frame)) => discarded += frame.into_data().map_or(0, |d| d.len()),
                _ => return,
            }
        }
    })
    .await;
    Err(ReadErr::TooLarge)
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body::Frame;
    use http_body_util::{Full, StreamBody};
    use std::convert::Infallible;

    fn chunks(
        n: usize,
        size: usize,
    ) -> StreamBody<tokio_stream::Iter<std::vec::IntoIter<Result<Frame<Bytes>, Infallible>>>> {
        let v: Vec<_> = (0..n)
            .map(|_| Ok(Frame::data(Bytes::from(vec![b'a'; size]))))
            .collect();
        StreamBody::new(tokio_stream::iter(v))
    }

    #[tokio::test]
    async fn read_capped_by_length_and_by_stream() {
        let full = |n: usize| Full::new(Bytes::from(vec![b'a'; n]));
        assert_eq!(
            read_capped(full(1025), 1024, T).await,
            Err(ReadErr::TooLarge)
        );
        assert_eq!(read_capped(full(1024), 1024, T).await.unwrap().len(), 1024);
        assert_eq!(
            read_capped(chunks(3, 512), 1024, T).await,
            Err(ReadErr::TooLarge)
        );
        assert_eq!(
            read_capped(chunks(2, 512), 1024, T).await.unwrap().len(),
            1024
        );
    }

    const T: std::time::Duration = std::time::Duration::from_secs(5);

    fn names<'a>(p: &'a [(Cow<'_, str>, Cow<'_, str>)]) -> Vec<&'a str> {
        p.iter().map(|(n, _)| n.as_ref()).collect()
    }

    #[test]
    fn the_action_sees_the_clients_content_length() {
        let mut h = HeaderMap::new();
        h.insert("host", "a.test".parse().unwrap());
        h.insert("content-type", "application/zip".parse().unwrap());
        h.insert("content-length", "1024".parse().unwrap());
        let p = worker_request_headers(&h, None);
        let cl = p
            .iter()
            .find(|(n, _)| n == "content-length")
            .map(|(_, v)| v.as_ref());
        assert_eq!(cl, Some("1024"));
    }

    #[test]
    fn a_chunked_request_has_no_content_length_and_the_hop_pair_stops_here() {
        let mut h = HeaderMap::new();
        h.insert("host", "a.test".parse().unwrap());
        h.insert("transfer-encoding", "chunked".parse().unwrap());
        h.insert("connection", "keep-alive".parse().unwrap());
        h.insert("x-brust-dev-token", "t".parse().unwrap());
        let p = worker_request_headers(&h, None);
        assert_eq!(names(&p), ["host"]);
    }

    #[test]
    fn host_comes_from_the_authority_when_http2_sent_none() {
        let h = HeaderMap::new();
        let p = worker_request_headers(&h, Some("b.test"));
        assert_eq!(names(&p), ["host"]);
        assert_eq!(p[0].1, "b.test");
    }

    #[tokio::test]
    async fn read_capped_gives_up_on_a_trickled_body() {
        let pending = StreamBody::new(tokio_stream::pending::<Result<Frame<Bytes>, Infallible>>());
        let d = std::time::Duration::from_millis(50);
        assert_eq!(read_capped(pending, 1024, d).await, Err(ReadErr::Slow));
    }
}
