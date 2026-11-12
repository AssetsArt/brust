//! F539 (B1): the `Content-Security-Policy` brust sends when `[csp]` is on. Every inline script brust writes itself (the
//! base path and actions-client globals, `Core::action_prefix_tag`) is fixed for the server's lifetime, so its
//! `sha256-…` source is computed once at [`Core::new`](crate::Core::new) and the whole header value is prebuilt there.
//! Only those prebuilt tags are hashed: an inline script found in a rendered page is never blessed (a raw sink would
//! become authorised script). A page answers with the header only when it is HTML, and a header the loader set wins.
use http::{HeaderMap, HeaderName, HeaderValue};
use sha2::{Digest, Sha256};

/// `enforce` sends `Content-Security-Policy`; `report-only` sends `Content-Security-Policy-Report-Only`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CspMode {
    #[default]
    Enforce,
    ReportOnly,
}

/// `[csp]` in `brust.toml`. Present = on. Each list adds sources to the directive brust composes; see [`compose`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CspConfig {
    pub mode: CspMode,
    /// Extra `script-src` sources. Sources that void the hashes ([`voids_hashes`]) are refused unless `script_src_unsafe`.
    pub script_src: Vec<String>,
    /// Opt-in for the sources [`voids_hashes`] names in `script_src`.
    pub script_src_unsafe: bool,
    /// Extra `style-src-elem` sources (`<style>` and `<link rel=stylesheet>`), keywords included, e.g. `'unsafe-inline'`
    /// for an app that writes `<style>` inline.
    pub style_src: Vec<String>,
    pub connect_src: Vec<String>,
    pub img_src: Vec<String>,
    pub font_src: Vec<String>,
    /// `frame-ancestors`; empty = the directive is not sent (framing stays as it is without `[csp]`).
    pub frame_ancestors: Vec<String>,
    pub report_uri: Option<String>,
}

impl CspConfig {
    pub fn validate(&self) -> Result<(), String> {
        let lists: [(&str, &[String]); 6] = [
            ("script_src", &self.script_src),
            ("style_src", &self.style_src),
            ("connect_src", &self.connect_src),
            ("img_src", &self.img_src),
            ("font_src", &self.font_src),
            ("frame_ancestors", &self.frame_ancestors),
        ];
        for (name, list) in lists {
            for s in list {
                source(s).map_err(|e| format!("{name}: {e}"))?;
            }
        }
        if let Some(u) = &self.report_uri {
            source(u).map_err(|e| format!("report_uri: {e}"))?;
        }
        // Not unlocked by script_src_unsafe: it does not weaken the policy, it breaks every page.
        if let Some(s) = self
            .script_src
            .iter()
            .find(|s| s.trim().eq_ignore_ascii_case("'strict-dynamic'"))
        {
            return Err(format!(
                "script_src: {s} is not supported: under it browsers ignore 'self' and host sources, so every brust \
                 <script src> (runtime, islands, navigation) would be blocked; it works only with nonces, which brust \
                 does not add yet"
            ));
        }
        if !self.script_src_unsafe
            && let Some(s) = self.script_src.iter().find(|s| voids_hashes(s))
        {
            return Err(format!(
                "script_src: {s} would let any script run and void the hash policy ('unsafe-inline' is ignored next to \
                 hashes; 'unsafe-eval' / 'unsafe-hashes' allow eval / inline handlers; data:, blob:, filesystem:, * and a \
                 bare scheme such as https: allow scripts from anywhere); list hosts (https://cdn.example.com) instead, \
                 or set script_src_unsafe = true to send it anyway"
            ));
        }
        Ok(())
    }
}

/// A `script-src` source that lets script in past the hashes: the unsafe keywords (not `'wasm-unsafe-eval'`), `*`, and a
/// bare scheme (`https:`, `data:`, `blob:`, `filesystem:`, …). A host (`https://cdn.example.com`, `*.example.com`) is fine.
pub fn voids_hashes(s: &str) -> bool {
    let k = s.trim().to_ascii_lowercase();
    if matches!(
        k.as_str(),
        "'unsafe-inline'" | "'unsafe-eval'" | "'unsafe-hashes'" | "*"
    ) {
        return true;
    }
    let Some(scheme) = k.strip_suffix(':') else {
        return false;
    };
    let mut c = scheme.chars();
    c.next().is_some_and(|f| f.is_ascii_alphabetic())
        && c.all(|x| x.is_ascii_alphanumeric() || matches!(x, '+' | '-' | '.'))
}

/// One source expression: one header-safe token run that cannot end the directive or start another.
fn source(s: &str) -> Result<(), String> {
    if s.trim().is_empty() {
        return Err("an empty source".into());
    }
    if let Some(c) = s
        .chars()
        .find(|c| matches!(c, ';' | ',') || c.is_control() || !c.is_ascii())
    {
        return Err(format!(
            "{s:?} holds {c:?}: one source per entry, ASCII, no ';' or ','"
        ));
    }
    // A quoted keyword is `'…'` whole; a quote anywhere else would merge into the next source.
    let quotes = s.matches('\'').count();
    let t = s.trim();
    if quotes != 0 && !(quotes == 2 && t.len() > 2 && t.starts_with('\'') && t.ends_with('\'')) {
        return Err(format!(
            "{s:?} has unbalanced quotes: write a keyword as 'keyword'"
        ));
    }
    Ok(())
}

/// `sha256-<base64>` of each inline `<script>` element in `tags` (brust's own prebuilt tags: plain `<script>` with no
/// attributes, text never holding `</script>`).
pub fn script_hashes(tags: &str) -> Vec<String> {
    const OPEN: &str = "<script>";
    const CLOSE: &str = "</script>";
    let mut out = Vec::new();
    let mut rest = tags;
    while let Some(i) = rest.find(OPEN) {
        let body = &rest[i + OPEN.len()..];
        let Some(j) = body.find(CLOSE) else { break };
        out.push(format!(
            "'sha256-{}'",
            base64(&Sha256::digest(&body.as_bytes()[..j]))
        ));
        rest = &body[j + CLOSE.len()..];
    }
    out
}

fn base64(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut o = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        for k in 0..4 {
            if k <= c.len() {
                o.push(T[(n >> (18 - 6 * k) & 63) as usize] as char);
            } else {
                o.push('=');
            }
        }
    }
    o
}

/// The policy: `default-src 'self'`, scripts from `'self'` plus brust's hashes, style elements from `'self'`, style
/// attributes allowed (the compiler prints `style=""` and `x-bind-style` sets it; an attribute cannot run script),
/// no plugins, no `<base>` elsewhere. `connect_origin` is the actions client's cross-origin `base_url`.
pub fn compose(cfg: &CspConfig, hashes: &[String], connect_origin: Option<&str>) -> String {
    let mut d: Vec<String> = vec!["default-src 'self'".into()];
    let list = |name: &str, base: &[&str], extra: &[String]| {
        let mut v = vec![name.to_string()];
        v.extend(base.iter().map(|s| s.to_string()));
        v.extend(extra.iter().map(|s| s.trim().to_string()));
        v.join(" ")
    };
    let mut script: Vec<&str> = vec!["'self'"];
    script.extend(hashes.iter().map(String::as_str));
    d.push(list("script-src", &script, &cfg.script_src));
    d.push(list("style-src-elem", &["'self'"], &cfg.style_src));
    d.push("style-src-attr 'unsafe-inline'".into());
    // Fallback for browsers without -elem/-attr (Safari < 15.4): CSP3 browsers ignore `style-src` when both are present,
    // so the policy above is unchanged for them; older ones keep style attributes instead of losing them to
    // `default-src 'self'`. Styles only: scripts stay strict.
    let extra: Vec<String> = cfg
        .style_src
        .iter()
        .filter(|s| !s.trim().eq_ignore_ascii_case("'unsafe-inline'") && s.trim() != "'self'")
        .cloned()
        .collect();
    d.push(list("style-src", &["'self'", "'unsafe-inline'"], &extra));
    let mut connect = vec!["'self'"];
    connect.extend(connect_origin);
    if connect.len() > 1 || !cfg.connect_src.is_empty() {
        d.push(list("connect-src", &connect, &cfg.connect_src));
    }
    if !cfg.img_src.is_empty() {
        d.push(list("img-src", &["'self'"], &cfg.img_src));
    }
    if !cfg.font_src.is_empty() {
        d.push(list("font-src", &["'self'"], &cfg.font_src));
    }
    d.push("object-src 'none'".into());
    d.push("base-uri 'self'".into());
    if !cfg.frame_ancestors.is_empty() {
        d.push(list("frame-ancestors", &[], &cfg.frame_ancestors));
    }
    if let Some(u) = &cfg.report_uri {
        d.push(format!("report-uri {}", u.trim()));
    }
    d.join("; ")
}

/// The prebuilt header: its name for the mode and its value.
#[derive(Clone, Debug)]
pub(crate) struct Resolved {
    name: HeaderName,
    value: HeaderValue,
}

impl Resolved {
    pub(crate) fn new(
        cfg: &CspConfig,
        tags: Option<&str>,
        connect_origin: Option<&str>,
    ) -> Result<Self, String> {
        let hashes = tags.map(script_hashes).unwrap_or_default();
        let value = HeaderValue::from_str(&compose(cfg, &hashes, connect_origin))
            .map_err(|e| format!("not a header value: {e}"))?;
        let name = match cfg.mode {
            CspMode::Enforce => http::header::CONTENT_SECURITY_POLICY,
            CspMode::ReportOnly => http::header::CONTENT_SECURITY_POLICY_REPORT_ONLY,
        };
        Ok(Resolved { name, value })
    }

    /// Stamps an HTML response, unless it already carries this header (a loader's own policy wins).
    pub(crate) fn stamp(&self, h: &mut HeaderMap) {
        let html = h
            .get(http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|t| t.trim_start().to_ascii_lowercase().starts_with("text/html"));
        if html {
            h.entry(self.name.clone())
                .or_insert_with(|| self.value.clone());
        }
    }

    #[cfg(test)]
    pub(crate) fn value(&self) -> &str {
        self.value.to_str().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> CspConfig {
        CspConfig::default()
    }

    #[test]
    fn base64_matches_the_rfc_vectors() {
        for (i, o) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(i.as_bytes()), o);
        }
    }

    #[test]
    fn the_hash_is_the_sha256_of_the_exact_script_text() {
        // `echo -n 'globalThis.__BRUST_BASE_PATH__="/x"' | openssl dgst -sha256 -binary | base64`
        let h = script_hashes("<script>globalThis.__BRUST_BASE_PATH__=\"/x\"</script>");
        assert_eq!(h, ["'sha256-FM/S+GbVJy4D1ZH9gTlh5rBg4y99plna5CnSe5ChKrQ='"]);
    }

    #[test]
    fn each_script_element_of_the_prebuilt_tags_gets_its_own_hash() {
        let tags = "<script>a=1</script><script>b=2;c=3</script>";
        let h = script_hashes(tags);
        assert_eq!(h.len(), 2);
        assert_eq!(h[0], script_hashes("<script>a=1</script>")[0]);
        assert_eq!(h[1], script_hashes("<script>b=2;c=3</script>")[0]);
    }

    #[test]
    fn the_base_policy() {
        assert_eq!(
            compose(&cfg(), &["'sha256-x'".into()], None),
            "default-src 'self'; script-src 'self' 'sha256-x'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; \
             style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'"
        );
    }

    #[test]
    fn extras_and_the_actions_origin_join_their_directives() {
        let c = CspConfig {
            script_src: vec!["https://cdn.example".into()],
            style_src: vec!["'unsafe-inline'".into()],
            connect_src: vec!["wss://ws.example".into()],
            img_src: vec!["data:".into()],
            font_src: vec!["https://fonts.example".into()],
            frame_ancestors: vec!["'none'".into()],
            report_uri: Some("/csp-report".into()),
            ..cfg()
        };
        assert_eq!(
            compose(&c, &[], Some("https://api.example")),
            "default-src 'self'; script-src 'self' https://cdn.example; style-src-elem 'self' 'unsafe-inline'; \
             style-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline'; \
             connect-src 'self' https://api.example wss://ws.example; \
             img-src 'self' data:; font-src 'self' https://fonts.example; object-src 'none'; base-uri 'self'; \
             frame-ancestors 'none'; report-uri /csp-report"
        );
    }

    #[test]
    fn the_style_src_fallback_carries_style_extras_and_never_scripts() {
        let c = CspConfig {
            script_src: vec!["https://cdn.example".into()],
            style_src: vec!["https://fonts.example".into(), "'UNSAFE-INLINE'".into()],
            ..cfg()
        };
        let p = compose(&c, &["'sha256-x'".into()], None);
        let dir = |name: &str| {
            p.split("; ")
                .find(|d| d.split(' ').next() == Some(name))
                .unwrap_or_else(|| panic!("{name} in {p}"))
                .to_string()
        };
        assert_eq!(
            dir("style-src"),
            "style-src 'self' 'unsafe-inline' https://fonts.example"
        );
        assert_eq!(
            dir("style-src-elem"),
            "style-src-elem 'self' https://fonts.example 'UNSAFE-INLINE'"
        );
        assert_eq!(
            dir("script-src"),
            "script-src 'self' 'sha256-x' https://cdn.example"
        );
        assert!(!dir("script-src").contains("unsafe-inline"), "{p}");
    }

    #[test]
    fn keywords_are_accepted_and_injection_is_refused() {
        let ok = |s: &str| {
            CspConfig {
                style_src: vec![s.into()],
                ..cfg()
            }
            .validate()
        };
        for s in [
            "'unsafe-inline'",
            "'self'",
            "'none'",
            "'nonce-abc'",
            "'sha256-AbC+/='",
            "https://x.example",
            "data:",
        ] {
            assert!(ok(s).is_ok(), "{s}");
        }
        for s in [
            "",
            " ",
            "a;b",
            "a,b",
            "a\nb",
            "'unsafe-inline",
            "x'",
            "'a' 'b'",
            "é",
            "''",
        ] {
            assert!(ok(s).is_err(), "{s:?}");
        }
        assert!(
            CspConfig {
                report_uri: Some("/r; script-src *".into()),
                ..cfg()
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn sources_that_void_the_hashes_need_the_second_flag() {
        for s in [
            "'unsafe-hashes'",
            "data:",
            "blob:",
            "filesystem:",
            "*",
            " https: ",
            "HTTP:",
            "ws:",
        ] {
            let c = CspConfig {
                script_src: vec![s.into()],
                ..cfg()
            };
            assert!(
                c.validate().unwrap_err().contains("script_src_unsafe"),
                "{s:?}"
            );
            assert!(
                CspConfig {
                    script_src_unsafe: true,
                    ..c
                }
                .validate()
                .is_ok(),
                "{s:?}"
            );
        }
        for s in [
            "https://cdn.example.com",
            "*.example.com",
            "https://*.example.com",
            "'self'",
            "'wasm-unsafe-eval'",
            "'sha256-AbC='",
            "'nonce-x'",
        ] {
            let c = CspConfig {
                script_src: vec![s.into()],
                ..cfg()
            };
            assert!(c.validate().is_ok(), "{s:?}");
        }
        // other directives take them freely
        let c = CspConfig {
            img_src: vec!["data:".into(), "blob:".into(), "https:".into()],
            style_src: vec!["*".into()],
            ..cfg()
        };
        assert!(c.validate().is_ok());
    }

    #[test]
    fn strict_dynamic_is_refused_even_with_the_second_flag() {
        for s in ["'strict-dynamic'", " 'STRICT-DYNAMIC' "] {
            for unsafe_ok in [false, true] {
                let e = CspConfig {
                    script_src: vec!["https://cdn.example".into(), s.into()],
                    script_src_unsafe: unsafe_ok,
                    ..cfg()
                }
                .validate()
                .unwrap_err();
                assert!(
                    e.contains("ignore 'self' and host sources") && e.contains("nonces"),
                    "{e}"
                );
            }
        }
        // only script-src means it
        assert!(
            CspConfig {
                style_src: vec!["'strict-dynamic'".into()],
                ..cfg()
            }
            .validate()
            .is_ok()
        );
    }

    #[test]
    fn unsafe_script_keywords_need_the_second_flag() {
        for s in ["'unsafe-inline'", "'UNSAFE-EVAL'"] {
            let c = CspConfig {
                script_src: vec![s.into()],
                ..cfg()
            };
            assert!(
                c.validate().unwrap_err().contains("script_src_unsafe"),
                "{s}"
            );
            assert!(
                CspConfig {
                    script_src_unsafe: true,
                    ..c
                }
                .validate()
                .is_ok()
            );
        }
        assert!(
            CspConfig {
                style_src: vec!["'unsafe-inline'".into()],
                ..cfg()
            }
            .validate()
            .is_ok()
        );
    }

    #[test]
    fn stamps_html_only_and_a_loader_policy_wins() {
        let r = Resolved::new(&cfg(), None, None).unwrap();
        let mut h = HeaderMap::new();
        h.insert(
            http::header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        r.stamp(&mut h);
        assert!(h.get(http::header::CONTENT_SECURITY_POLICY).is_none());
        h.insert(
            http::header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
        r.stamp(&mut h);
        assert_eq!(
            h.get(http::header::CONTENT_SECURITY_POLICY).unwrap(),
            r.value()
        );
        let mut own = HeaderMap::new();
        own.insert(
            http::header::CONTENT_TYPE,
            HeaderValue::from_static("text/html"),
        );
        own.insert(
            http::header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'none'"),
        );
        r.stamp(&mut own);
        assert_eq!(
            own.get_all(http::header::CONTENT_SECURITY_POLICY)
                .iter()
                .count(),
            1
        );
        assert_eq!(
            own.get(http::header::CONTENT_SECURITY_POLICY).unwrap(),
            "default-src 'none'"
        );
    }

    #[test]
    fn report_only_uses_its_own_header() {
        let r = Resolved::new(
            &CspConfig {
                mode: CspMode::ReportOnly,
                ..cfg()
            },
            None,
            None,
        )
        .unwrap();
        let mut h = HeaderMap::new();
        h.insert(
            http::header::CONTENT_TYPE,
            HeaderValue::from_static("text/html"),
        );
        r.stamp(&mut h);
        assert!(h.get(http::header::CONTENT_SECURITY_POLICY).is_none());
        assert!(
            h.get(http::header::CONTENT_SECURITY_POLICY_REPORT_ONLY)
                .is_some()
        );
    }
}
