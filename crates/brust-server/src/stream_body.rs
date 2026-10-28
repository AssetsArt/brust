//! F475: the streamed request body of a listed `{ parse: 'none' }` action. The hyper body waits
//! unread in the call's `FetchCell`; the worker pulls it a chunk at a time (`pullFetchBody`), so
//! hyper reads the socket only as fast as the app consumes it and the bytes in flight are about
//! one chunk, whatever `max_stream_bytes` is.
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use brust_core::host::ReadErr;
use bytes::{Bytes, BytesMut};
use http_body::Body;

/// A pull hands the worker up to this many bytes: the frames hyper already holds are joined up
/// to it, so a 256 MiB upload is a few hundred napi crossings, not one per TCP read.
pub(crate) const PULL_CHUNK_BYTES: usize = 1 << 20;

/// The body a stream reads: hyper `Incoming` in production, any body in tests.
pub(crate) type DynBody =
    Pin<Box<dyn Body<Data = Bytes, Error = Box<dyn std::error::Error + Send + Sync>> + Send>>;

/// The bounds of one streamed body.
#[derive(Clone, Copy, Debug)]
pub(crate) struct StreamLimits {
    /// `max_stream_bytes`.
    pub max: u64,
    /// `stream_idle_ms`: the longest a pull may wait for the client's next byte.
    pub idle: Duration,
    /// `stream_total_ms`: the whole call, from the request's admission.
    pub total: Duration,
    /// The app's own silence between pulls (and after the last one): the call timeout.
    pub call_timeout: Duration,
}

/// One pull's answer.
#[derive(Debug, PartialEq, Eq)]
pub enum Pull {
    Chunk(Bytes),
    /// The body ended with exactly the declared length (or none was declared).
    End,
    /// The stream failed; the same reason is kept for the reply ([`StreamBody::abort`]).
    Abort(ReadErr),
}

/// One admitted stream under `max_streams`; released when the stream is dropped (the call's cell
/// and every pending pull let go of it), not when the request returns.
pub(crate) struct Admission(Arc<AtomicUsize>);

impl Admission {
    pub(crate) fn try_new(n: &Arc<AtomicUsize>, cap: usize) -> Option<Self> {
        n.try_update(Ordering::AcqRel, Ordering::Acquire, |k| {
            (k < cap).then_some(k + 1)
        })
        .ok()
        .map(|_| Self(Arc::clone(n)))
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// The source of stream tokens (process-wide; only equality with the slot's current call matters).
static NEXT_TOKEN: AtomicU32 = AtomicU32::new(1);

/// The streamed body of one `fetch` call (F475), shared by its `FetchCell` and the call's deadline.
pub struct StreamBody {
    /// Matches the token sent in A1: a reader the app kept past its call can never pull the body
    /// of the next call that claims the same slot.
    pub(crate) token: u32,
    /// `None` once ended or aborted. An async lock: one pull at a time, held across the read.
    body: tokio::sync::Mutex<Option<DynBody>>,
    declared: Option<u64>,
    limits: StreamLimits,
    started: Instant,
    seen: AtomicU64,
    /// ms after `started` of the last pull's start or end: the deadline re-arms from it.
    last_ms: AtomicU64,
    abort: parking_lot::Mutex<Option<ReadErr>>,
    /// The body ended whole: a deadline after that is the app's (504), not the stream's.
    done: AtomicBool,
    _admission: Admission,
}

impl StreamBody {
    pub(crate) fn new(
        body: DynBody,
        declared: Option<u64>,
        limits: StreamLimits,
        admission: Admission,
    ) -> Self {
        Self {
            token: NEXT_TOKEN.fetch_add(1, Ordering::Relaxed),
            body: tokio::sync::Mutex::new(Some(body)),
            declared,
            limits,
            started: Instant::now(),
            seen: AtomicU64::new(0),
            last_ms: AtomicU64::new(0),
            abort: parking_lot::Mutex::new(None),
            done: AtomicBool::new(false),
            _admission: admission,
        }
    }

    /// Why the stream failed, if it did: the reply becomes 413/408/400 whatever the app answered.
    pub fn abort(&self) -> Option<ReadErr> {
        *self.abort.lock()
    }

    /// The call deadline (the slot's): the app may be silent for the call timeout (or, while a pull
    /// waits on the client, `stream_idle_ms`) after the last pull, never past `stream_total_ms`.
    pub(crate) fn deadline(&self) -> Instant {
        let last = self.started + Duration::from_millis(self.last_ms.load(Ordering::Relaxed));
        let quiet = self.limits.call_timeout.max(self.limits.idle);
        (last + quiet).min(self.started + self.limits.total)
    }

    /// The slot deadline fired: `Slow` (408) unless a pull already recorded a reason or the body
    /// had ended whole (then the deadline is the app's own, 504).
    pub(crate) fn note_deadline(&self) {
        if !self.done.load(Ordering::Acquire) {
            self.abort.lock().get_or_insert(ReadErr::Slow);
        }
    }

    fn touch(&self) {
        let ms = self.started.elapsed().as_millis() as u64;
        self.last_ms.fetch_max(ms, Ordering::Relaxed);
    }

    fn fail(&self, why: ReadErr) -> Pull {
        let mut a = self.abort.lock();
        Pull::Abort(*a.get_or_insert(why))
    }

    /// The next chunk: waits up to `stream_idle_ms` for the first frame, then joins the frames
    /// already buffered up to [`PULL_CHUNK_BYTES`]. Exactly the declared length or an error, never
    /// a short success (F474's rule).
    pub async fn pull(&self) -> Pull {
        self.touch();
        let mut g = self.body.lock().await;
        // A failed stream stays failed; past the ceiling its body is kept only for `discard`.
        if let Some(e) = self.abort() {
            return Pull::Abort(e);
        }
        let Some(body) = g.as_mut() else {
            return self.end();
        };
        let first = match tokio::time::timeout(self.limits.idle, next_data(body)).await {
            Err(_) => Err(ReadErr::Slow),
            Ok(r) => r,
        };
        let mut out = match first.and_then(|d| d.map(|d| self.count(&d).map(|()| d)).transpose()) {
            Ok(Some(d)) => BytesMut::from(&d[..]),
            Ok(None) => {
                *g = None;
                self.touch();
                return self.end();
            }
            Err(e) => {
                if e != ReadErr::TooLarge {
                    *g = None;
                }
                return self.fail(e);
            }
        };
        // Join what hyper already holds, without waiting for more.
        let mut ended = false;
        while out.len() < PULL_CHUNK_BYTES {
            let mut cx = Context::from_waker(std::task::Waker::noop());
            match body.as_mut().poll_frame(&mut cx) {
                Poll::Pending => break,
                Poll::Ready(None) => {
                    ended = true;
                    break;
                }
                Poll::Ready(Some(Err(_))) => {
                    *g = None;
                    return self.fail(ReadErr::Io);
                }
                Poll::Ready(Some(Ok(f))) => {
                    if let Ok(d) = f.into_data() {
                        if let Err(e) = self.count(&d) {
                            if e != ReadErr::TooLarge {
                                *g = None;
                            }
                            return self.fail(e);
                        }
                        out.extend_from_slice(&d);
                    }
                }
            }
        }
        if ended {
            // A short body still hands over what came; the abort is recorded and the next pull reports it.
            *g = None;
            self.end();
        }
        self.touch();
        Pull::Chunk(out.freeze())
    }

    /// After a refusal past the ceiling, read and throw away up to `max` more bytes for at most `wait`, so the
    /// client has finished sending when the 413 closes the connection (F127: otherwise the kernel resets it and
    /// the client may never see the 413). Then the body is dropped.
    pub(crate) async fn discard(&self, max: usize, wait: Duration) {
        let mut g = self.body.lock().await;
        let Some(body) = g.as_mut() else { return };
        let mut n = 0usize;
        let _ = tokio::time::timeout(wait, async {
            while n < max {
                match next_data(body).await {
                    Ok(Some(d)) => n += d.len(),
                    _ => return,
                }
            }
        })
        .await;
        *g = None;
    }

    /// Count `d` against the ceiling and the declared length.
    fn count(&self, d: &Bytes) -> Result<(), ReadErr> {
        let seen = self.seen.fetch_add(d.len() as u64, Ordering::Relaxed) + d.len() as u64;
        if seen > self.limits.max {
            self.abort.lock().get_or_insert(ReadErr::TooLarge);
            return Err(ReadErr::TooLarge);
        }
        if self.declared.is_some_and(|n| seen > n) {
            self.abort.lock().get_or_insert(ReadErr::Io);
            return Err(ReadErr::Io);
        }
        Ok(())
    }

    /// The body ended: a short count against the declared length is an error.
    fn end(&self) -> Pull {
        let seen = self.seen.load(Ordering::Relaxed);
        if self.declared.is_some_and(|n| seen != n) {
            return self.fail(ReadErr::Io);
        }
        self.done.store(true, Ordering::Release);
        Pull::End
    }
}

/// The next data frame (trailers skipped), `None` at the end, `Io` on a body error.
async fn next_data(body: &mut DynBody) -> Result<Option<Bytes>, ReadErr> {
    loop {
        match std::future::poll_fn(|cx| body.as_mut().poll_frame(cx)).await {
            None => return Ok(None),
            Some(Err(_)) => return Err(ReadErr::Io),
            Some(Ok(f)) => {
                if let Ok(d) = f.into_data()
                    && !d.is_empty()
                {
                    return Ok(Some(d));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body::Frame;
    use http_body_util::StreamBody as Frames;
    use std::convert::Infallible;

    type Sent = Result<Frame<Bytes>, Infallible>;

    /// A stream over `chunks` (each `n` bytes of `b'a'`) and a sender for more; dropping the sender ends it.
    fn body(chunks: &[usize]) -> (DynBody, tokio::sync::mpsc::Sender<Sent>) {
        let (tx, rx) = tokio::sync::mpsc::channel(chunks.len().max(1));
        for &n in chunks {
            tx.try_send(Ok(Frame::data(Bytes::from(vec![b'a'; n]))))
                .unwrap();
        }
        let b = Frames::new(tokio_stream::wrappers::ReceiverStream::new(rx))
            .map_err(|e: Infallible| -> Box<dyn std::error::Error + Send + Sync> { match e {} });
        (Box::pin(b), tx)
    }

    fn limits(max: u64) -> StreamLimits {
        StreamLimits {
            max,
            idle: Duration::from_millis(100),
            total: Duration::from_secs(60),
            call_timeout: Duration::from_secs(5),
        }
    }

    fn stream(b: DynBody, declared: Option<u64>, max: u64) -> StreamBody {
        let n = Arc::new(AtomicUsize::new(0));
        StreamBody::new(b, declared, limits(max), Admission::try_new(&n, 1).unwrap())
    }

    /// Pull to the end: the bytes, and how it ended.
    async fn drain(st: &StreamBody) -> (usize, Pull) {
        let mut n = 0;
        loop {
            match st.pull().await {
                Pull::Chunk(b) => n += b.len(),
                end => return (n, end),
            }
        }
    }

    use http_body_util::BodyExt;

    #[tokio::test]
    async fn buffered_frames_join_up_to_a_chunk_and_the_end_is_exact() {
        let (b, tx) = body(&[1000; 3]);
        drop(tx);
        let st = stream(b, Some(3000), 1 << 20);
        assert_eq!(st.pull().await, Pull::Chunk(Bytes::from(vec![b'a'; 3000])));
        assert_eq!(st.pull().await, Pull::End);
        assert_eq!(st.pull().await, Pull::End);
        assert_eq!(st.abort(), None);
        // 16 KiB frames: a tokio channel yields Pending past its coop budget (128 polls), hyper's does not.
        const F: usize = 16 << 10;
        let big = (PULL_CHUNK_BYTES / F) + 4;
        let (b, tx) = body(&vec![F; big]);
        drop(tx);
        let st = stream(b, None, 1 << 30);
        let Pull::Chunk(first) = st.pull().await else {
            panic!("a chunk")
        };
        assert!(first.len() >= PULL_CHUNK_BYTES && first.len() < PULL_CHUNK_BYTES + F);
        assert_eq!(drain(&st).await, (big * F - first.len(), Pull::End));
    }

    #[tokio::test]
    async fn past_the_ceiling_is_too_large_and_stays_so() {
        let (b, tx) = body(&[1024; 5]);
        drop(tx);
        let st = stream(b, None, 4096);
        assert_eq!(drain(&st).await.1, Pull::Abort(ReadErr::TooLarge));
        assert_eq!(st.abort(), Some(ReadErr::TooLarge));
        assert_eq!(st.pull().await, Pull::Abort(ReadErr::TooLarge));
        // The refused body is kept for the bounded read-out, then dropped.
        assert!(st.body.lock().await.is_some());
        st.discard(1 << 20, Duration::from_secs(1)).await;
        assert!(st.body.lock().await.is_none());
        // Exactly the ceiling is fine.
        let (b, tx) = body(&[1024; 4]);
        drop(tx);
        assert_eq!(drain(&stream(b, None, 4096)).await, (4096, Pull::End));
    }

    #[tokio::test]
    async fn a_short_or_long_body_against_its_declared_length_is_io() {
        let (b, tx) = body(&[100]);
        drop(tx);
        let st = stream(b, Some(101), 1 << 20);
        assert_eq!(drain(&st).await, (100, Pull::Abort(ReadErr::Io)));
        let (b, tx) = body(&[100, 2]);
        drop(tx);
        let st = stream(b, Some(101), 1 << 20);
        assert_eq!(drain(&st).await.1, Pull::Abort(ReadErr::Io));
        assert_eq!(st.abort(), Some(ReadErr::Io));
    }

    #[tokio::test]
    async fn no_byte_within_the_idle_time_is_slow() {
        let (b, tx) = body(&[10]);
        let st = stream(b, None, 1 << 20);
        assert!(matches!(st.pull().await, Pull::Chunk(_)));
        let t0 = Instant::now();
        assert_eq!(st.pull().await, Pull::Abort(ReadErr::Slow));
        assert!(t0.elapsed() >= Duration::from_millis(100));
        drop(tx);
    }

    #[tokio::test]
    async fn the_deadline_moves_with_each_pull_and_never_passes_the_total() {
        let (b, tx) = body(&[10, 10]);
        let st = stream(b, None, 1 << 20);
        let d0 = st.deadline();
        assert!(d0 <= st.started + Duration::from_secs(5) + Duration::from_millis(1));
        tokio::time::sleep(Duration::from_millis(20)).await;
        st.pull().await;
        assert!(st.deadline() > d0);
        drop(tx);
        let total = StreamLimits {
            total: Duration::from_millis(50),
            ..limits(1 << 20)
        };
        let n = Arc::new(AtomicUsize::new(0));
        let (b, _tx) = body(&[]);
        let st = StreamBody::new(b, None, total, Admission::try_new(&n, 1).unwrap());
        assert_eq!(st.deadline(), st.started + Duration::from_millis(50));
    }

    #[tokio::test]
    async fn a_deadline_is_the_stream_s_fault_only_before_its_end() {
        let (b, tx) = body(&[10]);
        drop(tx);
        let st = stream(b, None, 1 << 20);
        drain(&st).await;
        st.note_deadline();
        assert_eq!(st.abort(), None);
        let (b, _tx) = body(&[10]);
        let st = stream(b, None, 1 << 20);
        st.note_deadline();
        assert_eq!(st.abort(), Some(ReadErr::Slow));
    }

    #[test]
    fn admission_is_capped_and_released_on_drop() {
        let n = Arc::new(AtomicUsize::new(0));
        let a = Admission::try_new(&n, 2).unwrap();
        let b = Admission::try_new(&n, 2).unwrap();
        assert!(Admission::try_new(&n, 2).is_none());
        drop(a);
        let c = Admission::try_new(&n, 2).unwrap();
        drop((b, c));
        assert_eq!(n.load(Ordering::Acquire), 0);
    }
}
