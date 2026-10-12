//! `NativeHost`: the [`Host`] the core pipeline runs on here — the Bun worker pool behind the SAB
//! dispatch seam, `dist/` on the local disk, hyper bodies and tokio timers.
use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use brust_core::body::{header_str, is_framing_header};
use brust_core::config::ACTION_INLINE_BODY_BYTES;
use brust_core::host::{ActionCall, CallError, Clock, Host, ReadErr, StaticRoot};
use brust_core::plan::{PlanCell, PlanSeed, PlannedCall};
use brust_core::protocol::{
    FetchBody, FetchRequest, FetchResponse, JobsRequest, JobsResponse, LoaderRequest,
    LoaderResponse,
};
use brust_core::static_rules::content_type_for;
use bytes::Bytes;
use http::{HeaderMap, Response};
use http_body_util::{BodyExt, LengthLimitError, Limited};
use hyper::body::Incoming;

use crate::cache::job_cache::JobCache;
use crate::cache::l1::L1Cache;
use crate::dispatch::{CallKind, call_worker, call_worker_fetch, call_worker_planned};
use crate::pool::{PlanBox, WorkerPool};
use crate::server::static_assets::static_asset_response;

/// The worker pool, the served `dist/` and the two call timeouts.
pub(crate) struct NativeHost {
    pub(crate) pool: Arc<WorkerPool>,
    pub(crate) dist_dir: PathBuf,
    pub(crate) claim_timeout: Duration,
    pub(crate) call_timeout: Duration,
}

impl Clock for NativeHost {
    /// Nanoseconds since the first reading in this process (`Instant`: monotonic).
    #[inline]
    fn now_ns(&self) -> u64 {
        static EPOCH: LazyLock<Instant> = LazyLock::new(Instant::now);
        EPOCH.elapsed().as_nanos() as u64
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
    async fn action(&self, call: ActionCall<'_>) -> Result<FetchResponse, CallError> {
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
        let mut pairs: Vec<(Cow<str>, Cow<str>)> = call
            .headers
            .iter()
            .filter(|(n, _)| !is_framing_header(n.as_str()))
            .map(|(n, v)| {
                (
                    Cow::Borrowed(n.as_str()),
                    String::from_utf8_lossy(v.as_bytes()),
                )
            })
            .collect();
        // R8: HTTP/2 carries the host in `:authority`, not a `host` header.
        if !call.headers.contains_key(http::header::HOST)
            && let Some(au) = call.authority
        {
            pairs.push((Cow::Borrowed("host"), Cow::Owned(au.to_owned())));
        }
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

/// The whole body, at most `cap` bytes. A declared Content-Length over the cap is refused before any read; a chunked
/// body is cut off by [`Limited`] the moment it passes the cap; the whole read must finish within `deadline`.
async fn read_capped<B>(b: B, cap: usize, deadline: std::time::Duration) -> Result<Bytes, ReadErr>
where
    B: http_body::Body<Data = Bytes>,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    if b.size_hint().lower() > cap as u64 {
        return Err(ReadErr::TooLarge);
    }
    let Ok(read) = tokio::time::timeout(deadline, Limited::new(b, cap).collect()).await else {
        return Err(ReadErr::Slow);
    };
    match read {
        Ok(c) => Ok(c.to_bytes()),
        Err(e) if e.downcast_ref::<LengthLimitError>().is_some() => Err(ReadErr::TooLarge),
        Err(_) => Err(ReadErr::Io),
    }
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

    #[tokio::test]
    async fn read_capped_gives_up_on_a_trickled_body() {
        let pending = StreamBody::new(tokio_stream::pending::<Result<Frame<Bytes>, Infallible>>());
        let d = std::time::Duration::from_millis(50);
        assert_eq!(read_capped(pending, 1024, d).await, Err(ReadErr::Slow));
    }
}
