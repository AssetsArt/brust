# Implementation plan — static asset gzip compression

Spec: `docs/superpowers/specs/2026-06-03-static-compression-design.md`
Branch: `feat/static-compression` (off main)

**Gates baked into every task:**
- Rust CI mirror (memory `release-mirror-ci-gates`): `cargo fmt --all -- --check`,
  `cargo clippy --all-targets --locked -D warnings`, `cargo test` — all green.
- TS lint: `bun run ci` (biome) clean.
- After the Rust change, **rebuild the addon** before any bun test that boots the
  server: `cd runtime && bun run build:debug` (memory `stale-napi-node-after-compiler-change`).
- `git add <explicit paths>` only — never `-A`.

Single implementer can do all tasks in sequence (one cohesive Rust change, one branch,
no parallel-conflict). TDD: Rust unit tests live in `compress.rs #[cfg(test)]` — write
them alongside the impl and run `cargo test` red→green.

## Spec coverage

| Spec section | Task |
|---|---|
| `compress.rs` (accepts_gzip / is_compressible / gzip / gzip_cached / maybe_compress) + unit tests | T1 |
| Cargo `flate2`, `lib.rs` `mod compress;` | T1 |
| `server.rs` 3 static branches via a `static_response` helper | T2 |
| Integration test | T3 |

---

## T1 — `compress.rs` module + Cargo + lib registration

**`crates/brust/Cargo.toml`** — add to `[dependencies]` (moka already present):
```toml
flate2 = "1"
```

**`crates/brust/src/lib.rs`** — add `mod compress;` alphabetically near `mod cache;`.

**`crates/brust/src/compress.rs`** (new) — complete:
```rust
//! gzip compression for STATIC asset responses (islands / css / public).
//! Scope is static assets only — dynamic SSR / SAB / action / SSE paths are
//! untouched. See docs/superpowers/specs/2026-06-03-static-compression-design.md.
use std::io::Write;
use std::sync::Arc;

use flate2::Compression;
use flate2::write::GzEncoder;
use moka::sync::Cache;
use once_cell::sync::Lazy;

/// Below this size the header + CPU overhead outweighs the saving.
const MIN_SIZE: usize = 1024;

/// Process-global cache of gzipped bodies keyed by absolute asset path. Used in
/// PROD only — assets are immutable for the process lifetime, so a path key needs
/// no mtime. Dev compresses fresh (see `gzip_cached`) so a hot-reloaded file is
/// never served stale.
static GZIP_CACHE: Lazy<Cache<String, Arc<Vec<u8>>>> = Lazy::new(|| Cache::new(512));

/// True if Accept-Encoding offers gzip with a non-zero q-value. Absent → false.
pub fn accepts_gzip(accept_encoding: Option<&str>) -> bool {
    let Some(ae) = accept_encoding else {
        return false;
    };
    for tok in ae.split(',') {
        let mut it = tok.split(';').map(str::trim);
        if it.next().unwrap_or("").eq_ignore_ascii_case("gzip") {
            let mut q = 1.0_f32;
            for p in it {
                if let Some(v) = p.strip_prefix("q=").or_else(|| p.strip_prefix("Q=")) {
                    q = v.trim().parse().unwrap_or(1.0);
                }
            }
            if q > 0.0 {
                return true;
            }
        }
    }
    false
}

/// Allowlist of compressible content types. Substring-safe: content types carry a
/// `; charset=utf-8` suffix, so match the media type before `;`.
pub fn is_compressible(content_type: &str) -> bool {
    let ct = content_type.split(';').next().unwrap_or("").trim();
    ct.starts_with("text/")
        || matches!(
            ct,
            "application/javascript" | "application/json" | "application/xml" | "image/svg+xml"
        )
}

/// gzip `bytes` (level 6). `None` if the output is not smaller (incompressible).
pub fn gzip(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut enc = GzEncoder::new(Vec::with_capacity(bytes.len() / 2 + 32), Compression::new(6));
    enc.write_all(bytes).ok()?;
    let out = enc.finish().ok()?;
    (out.len() < bytes.len()).then_some(out)
}

/// Prod: memoize per path. Dev: compress fresh (no cache → never stale on reload).
fn gzip_cached(path: &str, bytes: &[u8], dev: bool) -> Option<Vec<u8>> {
    if dev {
        return gzip(bytes);
    }
    if let Some(hit) = GZIP_CACHE.get(path) {
        return Some((*hit).clone());
    }
    let out = gzip(bytes)?;
    GZIP_CACHE.insert(path.to_string(), Arc::new(out.clone()));
    Some(out)
}

/// Negotiate + maybe compress a static asset. Returns the body to send and the
/// Content-Encoding (`Some("gzip")` or `None` for identity). Body passed by value;
/// on identity it is returned unchanged (no copy).
pub fn maybe_compress(
    accept_encoding: Option<&str>,
    content_type: &str,
    path: &str,
    bytes: Vec<u8>,
    dev: bool,
) -> (Vec<u8>, Option<&'static str>) {
    if bytes.len() >= MIN_SIZE
        && is_compressible(content_type)
        && accepts_gzip(accept_encoding)
        && let Some(gz) = gzip_cached(path, &bytes, dev)
    {
        return (gz, Some("gzip"));
    }
    (bytes, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::GzDecoder;
    use std::io::Read;

    #[test]
    fn accepts_gzip_negotiation() {
        assert!(accepts_gzip(Some("gzip")));
        assert!(accepts_gzip(Some("gzip, br")));
        assert!(accepts_gzip(Some("br, gzip")));
        assert!(accepts_gzip(Some("gzip;q=1.0")));
        assert!(!accepts_gzip(Some("gzip;q=0")));
        assert!(!accepts_gzip(Some("gzip; q=0.0")));
        assert!(!accepts_gzip(Some("identity")));
        assert!(!accepts_gzip(Some("br")));
        assert!(!accepts_gzip(None));
    }

    #[test]
    fn compressible_allowlist() {
        assert!(is_compressible("text/css; charset=utf-8"));
        assert!(is_compressible("application/javascript; charset=utf-8"));
        assert!(is_compressible("image/svg+xml"));
        assert!(is_compressible("application/json"));
        assert!(!is_compressible("image/png"));
        assert!(!is_compressible("font/woff2"));
        assert!(!is_compressible("application/gzip"));
    }

    #[test]
    fn gzip_round_trips() {
        let raw = b"console.log('hello');".repeat(200); // > MIN_SIZE, compressible
        let gz = gzip(&raw).expect("compressible input gzips smaller");
        assert!(gz.len() < raw.len());
        let mut dec = GzDecoder::new(&gz[..]);
        let mut back = Vec::new();
        dec.read_to_end(&mut back).unwrap();
        assert_eq!(back, raw);
    }

    #[test]
    fn gzip_none_when_not_smaller() {
        // 16 random-ish bytes don't compress below their own size.
        let raw: Vec<u8> = (0u8..16).collect();
        assert!(gzip(&raw).is_none());
    }

    #[test]
    fn maybe_compress_gates() {
        let js = b"x".repeat(2048);
        // happy path
        let (body, enc) = maybe_compress(Some("gzip"), "application/javascript", "/a.js", js.clone(), true);
        assert_eq!(enc, Some("gzip"));
        assert!(body.len() < js.len());
        // no accept-encoding → identity
        let (body, enc) = maybe_compress(None, "application/javascript", "/a.js", js.clone(), true);
        assert_eq!(enc, None);
        assert_eq!(body, js);
        // incompressible type → identity
        let (_, enc) = maybe_compress(Some("gzip"), "image/png", "/a.png", js.clone(), true);
        assert_eq!(enc, None);
        // below MIN_SIZE → identity
        let small = b"x".repeat(100);
        let (_, enc) = maybe_compress(Some("gzip"), "text/css", "/a.css", small, true);
        assert_eq!(enc, None);
    }
}
```
> `&& let … =` chained let-conditions require Rust 2024 / recent toolchain. The repo
> already uses `if let Some(file) = … && …` (server.rs:352-354), so the toolchain
> supports it. If `cargo` rejects the chained `&&  let` in `maybe_compress`, nest the
> `if let` instead (functionally identical).

**Verify:** `cargo test -p brust compress` green; `cargo clippy --all-targets --locked -D warnings` clean; `cargo fmt --all -- --check` clean.

---

## T2 — wire the 3 static branches (`server.rs`)

Add a private helper near `asset_cache_control` (server.rs:21) that centralizes
negotiation + header assembly for all three branches:

```rust
/// Build a static-asset response: negotiate gzip, set Cache-Control + Vary, and
/// Content-Encoding when compressed. `path` is the on-disk path (cache key).
fn static_asset_response(buf: &[u8], content_type: &str, path: &str, bytes: Vec<u8>) -> Vec<u8> {
    let dev = crate::is_dev_mode();
    let accept = parse_header_value(buf, "accept-encoding");
    let (body, encoding) =
        crate::compress::maybe_compress(accept.as_deref(), content_type, path, bytes, dev);
    let mut extra: Vec<(String, String)> = vec![
        ("Cache-Control".to_string(), asset_cache_control(dev).to_string()),
        ("Vary".to_string(), "Accept-Encoding".to_string()),
    ];
    if let Some(enc) = encoding {
        extra.push(("Content-Encoding".to_string(), enc.to_string()));
    }
    http::build_response(200, content_type, &extra, body)
}
```

Replace the response build in each branch (the `Ok(bytes) => { let extra = […]; let resp = http::build_response(...) }` blocks):

- **islands** (server.rs ~288-299):
  ```rust
  Ok(bytes) => {
      let resp = static_asset_response(
          &buf,
          "application/javascript; charset=utf-8",
          &file_path.to_string_lossy(),
          bytes,
      );
      if s.write_all(resp).await.is_err() { return; }
      continue;
  }
  ```
- **css** (server.rs ~328-335): same, `content_type = "text/css; charset=utf-8"`.
- **public** (server.rs ~356-362):
  ```rust
  if let Ok(bytes) = tokio::fs::read(&file_path).await {
      let ct = content_type_for(&file_path);
      let resp = static_asset_response(&buf, ct, &file_path.to_string_lossy(), bytes);
      if s.write_all(resp).await.is_err() { return; }
      continue;
  }
  ```

Confirm `buf` (the function-level request buffer, server.rs:210) and `parse_header_value`
(server.rs:1822) are in scope at all three branches — they are (same function). Do NOT
reference `header_end` (not in scope here).

**Verify:** `cargo clippy --all-targets --locked -D warnings` + `cargo fmt --check` + `cargo test` green. Then rebuild addon: `cd runtime && bun run build:debug`.

---

## T3 — integration test (`tests/static-compression.test.ts`)

Mirror `tests/integration.test.ts` harness (`startServer`/`freePort`/`readPortLine`).
Boot `tests/fixtures/app/index.ts` (source mode builds islands at boot →
`/_brust/islands/_react-dom.js` exists and is > MIN_SIZE).

- `GET /_brust/islands/_react-dom.js` with header `Accept-Encoding: gzip`:
  - status 200, `content-encoding: gzip`, `vary` contains `Accept-Encoding`.
  - read the response as a buffer, gunzip (`Bun.gunzipSync` / `zlib`), assert the
    decompressed length > the compressed `content-length` (proves it was compressed)
    and that it's valid JS (starts with the same bytes as the on-disk file, or just
    non-empty + decompresses without error).
- `GET /_brust/islands/_react-dom.js` **without** Accept-Encoding:
  - status 200, NO `content-encoding` header, `content-length` == raw file size.
- A CSS asset `GET /_brust/css/app.css` with gzip (if the fixture has app.css) →
  `content-encoding: gzip`. (If absent, skip — islands case is the load-bearing one.)
- Assert `cache-control` is still present (unchanged) on the compressed response.

Confirm `runtime/*.node` rebuilt (T2) before running. Stop the server in `finally`.

**Verify:** `bun test tests/static-compression.test.ts` green; full `bun test tests/` + `bun test runtime/` no regression; `bun run ci` clean.

---

## Final gate (orchestrator, Phase 6)
- `cargo fmt --all -- --check` · `cargo clippy --all-targets --locked -D warnings` · `cargo test` (re-run by me)
- rebuild addon · `bun test tests/` + `bun test runtime/` green · `bun run ci` clean
- manual: `curl -H 'Accept-Encoding: gzip' -D - …/_react-dom.js` shows `Content-Encoding: gzip` + transfer ≈ ⅓ of 185 KB; `curl` without the header → no encoding, full size
- read `git diff` on server.rs for scope creep (only the 3 branches + helper)
