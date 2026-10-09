//! The per-request `brust::request` log line (spec §7, DEBUG level). Own binary: the global
//! tracing subscriber installed here is private to this process.
mod common;

use std::io::Write;
use std::sync::Mutex;

use common::*;

static LINES: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// A `MakeWriter` target that appends each formatted event to [`LINES`].
struct MockWriter;

impl Write for MockWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        LINES
            .lock()
            .unwrap()
            .push(String::from_utf8_lossy(buf).into_owned());
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn one_request_line_per_page_with_route_status_cache_calls_duration() {
    // Global (not scoped): the events fire on the server's runtime threads.
    tracing_subscriber::fmt()
        .with_writer(|| MockWriter)
        .with_ansi(false)
        // The request line is DEBUG (2026-10-10: INFO flooded the terminal under load); the
        // default filter `brust=info` hides it, `RUST_LOG=brust=debug` shows it.
        .with_max_level(tracing::Level::DEBUG)
        .init();

    let s = boot(fake());
    for path in ["/pokemon/pikachu", "/", "/pokemon/pikachu"] {
        let (status, _, body) = get(&s, path, &[]);
        assert_eq!(status, 200, "{path}: {body}");
    }

    let lines: Vec<String> = LINES
        .lock()
        .unwrap()
        .iter()
        .filter(|l| l.contains("brust::request"))
        .cloned()
        .collect();
    let want = [
        "route=r2 status=200 cache=MISS bun_calls=2",
        "route=r1 status=200 cache=- bun_calls=0",
        "route=r2 status=200 cache=HIT bun_calls=0",
    ];
    assert_eq!(lines.len(), want.len(), "{lines:#?}");
    for (line, w) in lines.iter().zip(want) {
        assert!(line.contains(w), "want `{w}` in {line}");
        assert!(line.contains("dur_ms="), "no dur_ms in {line}");
    }
}
