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

/// F544: `default_src` / `base_uri`: `'self'` (the default) or `'none'`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SelfOrNone {
    #[default]
    SelfOrigin,
    None,
}

impl SelfOrNone {
    /// `"self"` or `"none"` (the config spelling); `name` names the key in the error.
    pub fn parse(v: Option<&str>, name: &str) -> Result<Self, String> {
        match v {
            None | Some("self") => Ok(SelfOrNone::SelfOrigin),
            Some("none") => Ok(SelfOrNone::None),
            Some(o) => Err(format!("{name} must be \"self\" or \"none\" (got {o:?})")),
        }
    }

    fn keyword(self) -> &'static str {
        match self {
            SelfOrNone::SelfOrigin => "'self'",
            SelfOrNone::None => "'none'",
        }
    }
}

/// The request-host placeholder (F544): `wss://{host}` is the request's own authority, expanded per response.
pub const HOST: &str = "{host}";

/// `[csp]` in `brust.toml`. Present = on. Each list adds sources to the directive brust composes; see [`compose`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CspConfig {
    pub mode: CspMode,
    /// F544: `default-src`; with `None` brust names every directive its own runtime needs.
    pub default_src: SelfOrNone,
    /// F544: `base-uri`.
    pub base_uri: SelfOrNone,
    /// F544: `form-action 'self'` plus these (it does not fall back to `default-src`).
    pub form_action: Vec<String>,
    /// F544: sent only when set (with `'self'` first under `default_src = 'self'`).
    pub frame_src: Vec<String>,
    pub media_src: Vec<String>,
    pub worker_src: Vec<String>,
    pub manifest_src: Vec<String>,
    /// F544: `object-src` sources; empty = `'none'`.
    pub object_src: Vec<String>,
    /// F544: a static render (F541): `{host}` sources are dropped, there is no request to take the host from.
    pub drop_host: bool,
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
        let lists: [(&str, &[String]); 12] = [
            ("script_src", &self.script_src),
            ("style_src", &self.style_src),
            ("connect_src", &self.connect_src),
            ("img_src", &self.img_src),
            ("font_src", &self.font_src),
            ("frame_ancestors", &self.frame_ancestors),
            ("form_action", &self.form_action),
            ("frame_src", &self.frame_src),
            ("media_src", &self.media_src),
            ("worker_src", &self.worker_src),
            ("manifest_src", &self.manifest_src),
            ("object_src", &self.object_src),
        ];
        for (name, list) in lists {
            for s in list {
                source(s).map_err(|e| format!("{name}: {e}"))?;
            }
        }
        if let Some(u) = &self.report_uri {
            source(u).map_err(|e| format!("report_uri: {e}"))?;
        }
        // F544: a per-request host as a script source would let any vhost pointed at this server serve script.
        if let Some(s) = self.script_src.iter().find(|s| s.contains(HOST)) {
            return Err(format!(
                "script_src: {s} uses {HOST}, which is refused here: a script source taken from the request's Host would \
                 let any host name that reaches this server serve script; name the hosts"
            ));
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

/// A `script-src` source that lets script in past the hashes: the unsafe keywords (not `'wasm-unsafe-eval'`), a bare
/// scheme (`https:`, `data:`, `blob:`, `filesystem:`, …), and any source whose host part is exactly `*` (`*`, `https://*`,
/// `*:443`, `https://*:*/path`): a lone `*` host matches every host. A host (`https://cdn.example.com`, `*.example.com`) is
/// fine.
pub fn voids_hashes(s: &str) -> bool {
    let k = s.trim().to_ascii_lowercase();
    if matches!(
        k.as_str(),
        "'unsafe-inline'" | "'unsafe-eval'" | "'unsafe-hashes'"
    ) {
        return true;
    }
    if k.strip_suffix(':').is_some_and(is_scheme) {
        return true;
    }
    let rest = match k.split_once("://") {
        Some((scheme, rest)) if is_scheme(scheme) => rest,
        _ => k.as_str(),
    };
    rest.split([':', '/']).next() == Some("*")
}

fn is_scheme(s: &str) -> bool {
    let mut c = s.chars();
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

/// The policy: `default-src` (`'self'`, or `'none'` with every directive brust's runtime needs named), scripts from
/// `'self'` plus brust's hashes, style elements from `'self'`, style attributes allowed (the compiler prints `style=""` and
/// `x-bind-style` sets it; an attribute cannot run script), forms posting to `'self'`, no plugins, `<base>` limited.
/// `connect_origin` is the actions client's cross-origin `base_url`. Sources may still hold `{host}` ([`HOST`]):
/// [`Resolved`] expands or drops them per response.
pub fn compose(cfg: &CspConfig, hashes: &[String], connect_origin: Option<&str>) -> String {
    let none = cfg.default_src == SelfOrNone::None;
    let mut d: Vec<String> = vec![format!("default-src {}", cfg.default_src.keyword())];
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
    // `default-src`. Styles only: scripts stay strict.
    let extra: Vec<String> = cfg
        .style_src
        .iter()
        .filter(|s| !s.trim().eq_ignore_ascii_case("'unsafe-inline'") && s.trim() != "'self'")
        .cloned()
        .collect();
    d.push(list("style-src", &["'self'", "'unsafe-inline'"], &extra));
    // F544: under `default-src 'none'` brust names what its own runtime loads: navigation and action fetches
    // (connect), the images a navigation preloads and the fonts and images brust-built CSS serves from client/.
    let mut connect = vec!["'self'"];
    connect.extend(connect_origin);
    if none || connect.len() > 1 || !cfg.connect_src.is_empty() {
        d.push(list("connect-src", &connect, &cfg.connect_src));
    }
    if none || !cfg.img_src.is_empty() {
        d.push(list("img-src", &["'self'"], &cfg.img_src));
    }
    if none || !cfg.font_src.is_empty() {
        d.push(list("font-src", &["'self'"], &cfg.font_src));
    }
    // F544: what the app opens up itself; under `default-src 'self'` its own origin stays allowed.
    let own: &[&str] = if none { &[] } else { &["'self'"] };
    for (name, extra) in [
        ("frame-src", &cfg.frame_src),
        ("media-src", &cfg.media_src),
        ("worker-src", &cfg.worker_src),
        ("manifest-src", &cfg.manifest_src),
    ] {
        if !extra.is_empty() {
            d.push(list(name, own, extra));
        }
    }
    if cfg.object_src.is_empty() {
        d.push("object-src 'none'".into());
    } else {
        d.push(list("object-src", &[], &cfg.object_src));
    }
    d.push(format!("base-uri {}", cfg.base_uri.keyword()));
    d.push(list("form-action", &["'self'"], &cfg.form_action));
    if !cfg.frame_ancestors.is_empty() {
        d.push(list("frame-ancestors", &[], &cfg.frame_ancestors));
    }
    if let Some(u) = &cfg.report_uri {
        d.push(format!("report-uri {}", u.trim()));
    }
    d.join("; ")
}

/// F544: `host` (the request's authority) when it is a plain `hostname[:port]` or `[ipv6][:port]`, the only form a
/// `{host}` source is ever expanded with; anything else (the Host header is the client's to write) is `None`.
pub fn safe_host(host: &str) -> Option<&str> {
    let (name, port) = if let Some(rest) = host.strip_prefix('[') {
        let (ip, after) = rest.split_once(']')?;
        if ip.is_empty()
            || !ip
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.')
        {
            return None;
        }
        (None, after)
    } else {
        match host.rfind(':') {
            Some(i) => (Some(&host[..i]), &host[i..]),
            None => (Some(host), ""),
        }
    };
    let port_ok = port.is_empty()
        || port
            .strip_prefix(':')
            .is_some_and(|p| (1..=5).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()));
    let name_ok = name.is_none_or(|n| {
        !n.is_empty()
            && n.len() <= 253
            && n.split('.').all(|l| {
                !l.is_empty()
                    && l.len() <= 63
                    && !l.starts_with('-')
                    && !l.ends_with('-')
                    && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
    });
    (port_ok && name_ok).then_some(host)
}

/// The response already says it varies by `Host` (or by everything).
fn varies_by_host(h: &HeaderMap) -> bool {
    h.get_all(http::header::VARY)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|t| matches!(t.trim().to_ascii_lowercase().as_str(), "host" | "*"))
}

/// `value` with each `{host}` source expanded with `host`, or dropped when `host` is `None` (unsafe, or no request).
/// A directive left with no source keeps its name: an empty list allows nothing.
pub fn expand_host(value: &str, host: Option<&str>) -> String {
    value
        .split("; ")
        .map(|d| {
            d.split(' ')
                .enumerate()
                .filter_map(|(i, t)| {
                    if i == 0 || !t.contains(HOST) {
                        Some(t.to_string())
                    } else {
                        host.map(|h| t.replace(HOST, h))
                    }
                })
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// F541: the header (name, value) a server with this `[csp]`, base path and actions sends, composed exactly as
/// [`Core::new`](crate::Core::new) does; for a build that has no server to ask (the Cloudflare assets' `_headers`).
pub fn header_for(
    cfg: &CspConfig,
    base: &str,
    actions: Option<&crate::config::ActionsConfig>,
    client: Option<&crate::config::ActionsClient>,
) -> Result<(String, String), String> {
    cfg.validate()?;
    let tags = crate::core::page_globals(base, actions, client);
    let r = Resolved::new(
        cfg,
        tags.as_deref(),
        client.and_then(|c| c.base_url.as_deref()),
    )?;
    let value = r.value.to_str().map_err(|e| e.to_string())?.to_string();
    Ok((r.name.as_str().to_string(), value))
}

/// F541: how a static page carries the policy a server sends as a header. A `<meta http-equiv>` policy cannot hold
/// `frame-ancestors`, `report-uri`, `report-to` or `sandbox` (browsers ignore them there), and there is no report-only
/// meta: those go to one header rule of the static host instead.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StaticPolicy {
    /// The `content` of `<meta http-equiv="Content-Security-Policy">`; `None` in report-only mode.
    pub meta: Option<String>,
    /// The header the host still sends for every path: (name, value).
    pub header: Option<(String, String)>,
}

/// Directives a meta policy ignores.
const HEADER_ONLY: [&str; 4] = ["frame-ancestors", "report-uri", "report-to", "sandbox"];

/// Splits the header a server sends (`name`, `value`, as [`Resolved`] composed them) for a static page.
pub fn split_for_meta(name: &str, value: &str) -> StaticPolicy {
    if name.eq_ignore_ascii_case(http::header::CONTENT_SECURITY_POLICY_REPORT_ONLY.as_str()) {
        return StaticPolicy {
            meta: None,
            header: Some((
                "Content-Security-Policy-Report-Only".into(),
                value.to_string(),
            )),
        };
    }
    let (header, meta): (Vec<&str>, Vec<&str>) = value
        .split(';')
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .partition(|d| {
            let n = d.split_ascii_whitespace().next().unwrap_or("");
            HEADER_ONLY.iter().any(|h| n.eq_ignore_ascii_case(h))
        });
    StaticPolicy {
        meta: (!meta.is_empty()).then(|| meta.join("; ")),
        header: (!header.is_empty()).then(|| ("Content-Security-Policy".into(), header.join("; "))),
    }
}

/// The prebuilt header: its name for the mode and its value; with a `{host}` source, the template it is expanded from
/// per response (F544).
#[derive(Clone, Debug)]
pub(crate) struct Resolved {
    name: HeaderName,
    value: HeaderValue,
    /// The composed policy when a source holds `{host}`: `value` is then the policy with those sources dropped.
    template: Option<String>,
}

impl Resolved {
    pub(crate) fn new(
        cfg: &CspConfig,
        tags: Option<&str>,
        connect_origin: Option<&str>,
    ) -> Result<Self, String> {
        let hashes = tags.map(script_hashes).unwrap_or_default();
        let composed = compose(cfg, &hashes, connect_origin);
        let template = (composed.contains(HOST) && !cfg.drop_host).then(|| composed.clone());
        let value = HeaderValue::from_str(&expand_host(&composed, None))
            .map_err(|e| format!("not a header value: {e}"))?;
        let name = match cfg.mode {
            CspMode::Enforce => http::header::CONTENT_SECURITY_POLICY,
            CspMode::ReportOnly => http::header::CONTENT_SECURITY_POLICY_REPORT_ONLY,
        };
        Ok(Resolved {
            name,
            value,
            template,
        })
    }

    /// The policy has a `{host}` source: [`stamp`](Self::stamp) wants the request's authority.
    pub(crate) fn needs_host(&self) -> bool {
        self.template.is_some()
    }

    /// Stamps an HTML response, unless it already carries a policy of either kind (a loader's own wins; F544: an enforced
    /// one also keeps brust's report-only one off). `host` is the request's authority: a `{host}` source is expanded with
    /// it when it is a plain host ([`safe_host`]), dropped otherwise.
    pub(crate) fn stamp(&self, h: &mut HeaderMap, host: Option<&str>) {
        let html = h
            .get(http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|t| t.trim_start().to_ascii_lowercase().starts_with("text/html"));
        if !html
            || h.contains_key(http::header::CONTENT_SECURITY_POLICY)
            || h.contains_key(http::header::CONTENT_SECURITY_POLICY_REPORT_ONLY)
        {
            return;
        }
        let value = match (&self.template, host.and_then(safe_host)) {
            (Some(t), Some(host)) => HeaderValue::from_str(&expand_host(t, Some(host)))
                .unwrap_or_else(|_| self.value.clone()),
            _ => self.value.clone(),
        };
        h.insert(self.name.clone(), value);
        // The policy depends on the Host whenever it has a {host} source (expanded or dropped): a shared cache in front
        // must not serve one Host's policy for another.
        if self.template.is_some() && !varies_by_host(h) {
            h.append(http::header::VARY, HeaderValue::from_static("Host"));
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
             style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; form-action 'self'"
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
             form-action 'self'; frame-ancestors 'none'; report-uri /csp-report"
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

    /// script-src sources that void the hashes / that do not (shared with config-csp.test.ts).
    const VOIDS: [&str; 19] = [
        "'unsafe-inline'",
        "'unsafe-eval'",
        "'unsafe-hashes'",
        "data:",
        "blob:",
        "filesystem:",
        " https: ",
        "HTTP:",
        "ws:",
        "*",
        "https://*",
        "HTTP://*",
        "http://*",
        "*:443",
        "*:*",
        "https://*:*",
        "https://*/path",
        "*/x",
        "wss://*:8443/a",
    ];
    const KEEPS: [&str; 10] = [
        "https://cdn.example.com",
        "*.example.com",
        "https://*.example.com",
        "https://*.example.com:443",
        "https://cdn.example.com/*",
        "cdn.example.com:*",
        "'self'",
        "'wasm-unsafe-eval'",
        "'sha256-AbC='",
        "'nonce-x'",
    ];

    #[test]
    fn sources_that_void_the_hashes_need_the_second_flag() {
        // The same table as packages/brust/test/config-csp.test.ts.
        for s in VOIDS {
            assert!(voids_hashes(s), "{s:?}");
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
        for s in KEEPS {
            assert!(!voids_hashes(s), "{s:?}");
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
        r.stamp(&mut h, None);
        assert!(h.get(http::header::CONTENT_SECURITY_POLICY).is_none());
        h.insert(
            http::header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
        r.stamp(&mut h, None);
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
        r.stamp(&mut own, None);
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
    fn a_static_page_gets_the_meta_able_directives_and_the_host_the_rest() {
        let c = CspConfig {
            frame_ancestors: vec!["'none'".into()],
            report_uri: Some("/r".into()),
            ..cfg()
        };
        let r = Resolved::new(&c, Some("<script>a=1</script>"), None).unwrap();
        let s = split_for_meta(r.name.as_str(), r.value());
        let meta = s.meta.unwrap();
        assert!(
            meta.starts_with("default-src 'self'; script-src 'self' 'sha256-"),
            "{meta}"
        );
        assert!(
            !meta.contains("frame-ancestors") && !meta.contains("report-uri"),
            "{meta}"
        );
        // every other directive is kept, in order
        let all: Vec<&str> = r.value().split("; ").collect();
        let kept: Vec<&str> = meta.split("; ").collect();
        assert_eq!(
            kept,
            all.iter()
                .copied()
                .filter(|d| !d.starts_with("frame-ancestors") && !d.starts_with("report-uri"))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            s.header,
            Some((
                "Content-Security-Policy".into(),
                "frame-ancestors 'none'; report-uri /r".into()
            ))
        );
        // the base policy needs no header rule
        let base = Resolved::new(&cfg(), None, None).unwrap();
        let s = split_for_meta(base.name.as_str(), base.value());
        assert_eq!(s.meta.as_deref(), Some(base.value()));
        assert_eq!(s.header, None);
    }

    #[test]
    fn header_for_is_what_a_server_with_the_same_config_sends() {
        let actions = crate::config::ActionsConfig {
            prefix: "/site/rpc".into(),
            ..Default::default()
        };
        let (name, value) = header_for(&cfg(), "/site", Some(&actions), None).unwrap();
        assert_eq!(name, "content-security-policy");
        let tags = crate::core::page_globals("/site", Some(&actions), None).unwrap();
        assert_eq!(tags.matches("<script>").count(), 2, "{tags}");
        let r = Resolved::new(&cfg(), Some(&tags), None).unwrap();
        assert_eq!(value, r.value());
        for h in script_hashes(&tags) {
            assert!(value.contains(&h), "{h} in {value}");
        }
        assert!(
            header_for(
                &CspConfig {
                    script_src: vec!["*".into()],
                    ..cfg()
                },
                "",
                None,
                None
            )
            .is_err()
        );
    }

    #[test]
    fn report_only_is_a_header_rule_and_no_meta() {
        let r = Resolved::new(
            &CspConfig {
                mode: CspMode::ReportOnly,
                ..cfg()
            },
            None,
            None,
        )
        .unwrap();
        let s = split_for_meta(r.name.as_str(), r.value());
        assert_eq!(s.meta, None);
        assert_eq!(
            s.header,
            Some((
                "Content-Security-Policy-Report-Only".into(),
                r.value().to_string()
            ))
        );
        // header names are case-insensitive
        assert_eq!(
            split_for_meta("content-security-policy-report-only", "x").meta,
            None
        );
        assert_eq!(
            split_for_meta("CONTENT-SECURITY-POLICY", "a b; sandbox")
                .header
                .unwrap()
                .1,
            "sandbox"
        );
    }

    fn dir(p: &str, name: &str) -> Option<String> {
        p.split("; ")
            .find(|d| d.split(' ').next() == Some(name))
            .map(str::to_string)
    }

    #[test]
    fn form_action_is_always_sent_with_its_extras() {
        assert_eq!(
            dir(&compose(&cfg(), &[], None), "form-action").unwrap(),
            "form-action 'self'"
        );
        let c = CspConfig {
            form_action: vec!["https://pay.example".into()],
            ..cfg()
        };
        assert_eq!(
            dir(&compose(&c, &[], None), "form-action").unwrap(),
            "form-action 'self' https://pay.example"
        );
    }

    #[test]
    fn default_src_none_names_every_directive_brusts_runtime_needs() {
        let c = CspConfig {
            default_src: SelfOrNone::None,
            ..cfg()
        };
        let p = compose(&c, &["'sha256-x'".into()], Some("https://api.example"));
        assert!(p.starts_with("default-src 'none'; "), "{p}");
        for (name, want) in [
            ("script-src", "script-src 'self' 'sha256-x'"),
            ("style-src-elem", "style-src-elem 'self'"),
            ("style-src-attr", "style-src-attr 'unsafe-inline'"),
            ("connect-src", "connect-src 'self' https://api.example"),
            ("img-src", "img-src 'self'"),
            ("font-src", "font-src 'self'"),
            ("form-action", "form-action 'self'"),
            ("object-src", "object-src 'none'"),
            ("base-uri", "base-uri 'self'"),
        ] {
            assert_eq!(dir(&p, name).as_deref(), Some(want), "{name} in {p}");
        }
        // nothing brust loads needs these: not sent unless the app lists them
        for name in ["frame-src", "media-src", "worker-src", "manifest-src"] {
            assert_eq!(dir(&p, name), None, "{name} in {p}");
        }
        // under 'self' the runtime directives stay implied by default-src
        let s = compose(&cfg(), &[], None);
        for name in ["connect-src", "img-src", "font-src"] {
            assert_eq!(dir(&s, name), None, "{name} in {s}");
        }
    }

    #[test]
    fn new_lists_keep_self_under_default_self_and_base_uri_and_object_src_override() {
        let lists = CspConfig {
            frame_src: vec!["https://v.example".into()],
            media_src: vec!["https://m.example".into()],
            worker_src: vec!["blob:".into()],
            manifest_src: vec!["https://cdn.example".into()],
            object_src: vec!["https://o.example".into()],
            base_uri: SelfOrNone::None,
            ..cfg()
        };
        let p = compose(&lists, &[], None);
        assert_eq!(
            dir(&p, "frame-src").unwrap(),
            "frame-src 'self' https://v.example"
        );
        assert_eq!(
            dir(&p, "media-src").unwrap(),
            "media-src 'self' https://m.example"
        );
        assert_eq!(dir(&p, "worker-src").unwrap(), "worker-src 'self' blob:");
        assert_eq!(
            dir(&p, "manifest-src").unwrap(),
            "manifest-src 'self' https://cdn.example"
        );
        assert_eq!(
            dir(&p, "object-src").unwrap(),
            "object-src https://o.example"
        );
        assert_eq!(dir(&p, "base-uri").unwrap(), "base-uri 'none'");
        let none = compose(
            &CspConfig {
                default_src: SelfOrNone::None,
                ..lists
            },
            &[],
            None,
        );
        assert_eq!(
            dir(&none, "frame-src").unwrap(),
            "frame-src https://v.example"
        );
        // every new list is validated like the others
        assert!(
            CspConfig {
                worker_src: vec!["a;b".into()],
                ..cfg()
            }
            .validate()
            .unwrap_err()
            .starts_with("worker_src:")
        );
        assert!(
            SelfOrNone::parse(Some("some"), "csp: default_src")
                .unwrap_err()
                .contains("default_src")
        );
    }

    #[test]
    fn the_host_grammar() {
        for good in [
            "example.com",
            "a-b.example.com:8443",
            "localhost",
            "127.0.0.1:3000",
            "[::1]",
            "[2001:db8::1]:443",
            "xn--bcher-kva.example",
        ] {
            assert_eq!(safe_host(good), Some(good), "{good}");
        }
        for bad in [
            "",
            "a b.example",
            "a'.example",
            "example.com;script-src *",
            "example.com, evil",
            "exa\"mple",
            "bücher.example",
            "-a.example",
            "a-.example",
            "a..example",
            "example.com:",
            "example.com:123456",
            "example.com:80a",
            "[::1",
            "[]",
            "[::1]x",
            "evil.example\r\nset-cookie: a=b",
            "user@example.com",
        ] {
            assert_eq!(safe_host(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_host_source_is_expanded_with_a_safe_host_and_dropped_otherwise() {
        let c = CspConfig {
            connect_src: vec!["wss://{host}".into(), "https://api.example".into()],
            frame_src: vec!["https://{host}/embed".into()],
            ..cfg()
        };
        let r = Resolved::new(&c, None, None).unwrap();
        assert!(r.needs_host());
        // the prebuilt value (no request, or a bad host) has the {host} sources dropped, never echoed
        assert!(
            !r.value().contains("{host}")
                && r.value()
                    .contains("connect-src 'self' https://api.example;"),
            "{}",
            r.value()
        );
        let html = || {
            let mut h = HeaderMap::new();
            h.insert(
                http::header::CONTENT_TYPE,
                HeaderValue::from_static("text/html"),
            );
            h
        };
        let mut h = html();
        r.stamp(&mut h, Some("shop.example:8443"));
        let v = h[http::header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .to_string();
        assert!(
            v.contains("connect-src 'self' wss://shop.example:8443 https://api.example;"),
            "{v}"
        );
        assert!(
            v.contains("frame-src 'self' https://shop.example:8443/embed"),
            "{v}"
        );
        // an attacker's Host (header injection, a second directive, a quote): dropped, the rest of the policy kept
        for evil in [
            "evil.example; script-src *",
            "evil.example\r\nx: y",
            "'unsafe-inline'",
            "a b",
            "",
        ] {
            let mut h = html();
            r.stamp(&mut h, Some(evil));
            let v = h[http::header::CONTENT_SECURITY_POLICY].to_str().unwrap();
            assert_eq!(v, r.value(), "{evil:?}");
            assert!(!v.contains("evil") && !v.contains("*"), "{v}");
        }
        // no request authority: dropped
        let mut h = html();
        r.stamp(&mut h, None);
        assert_eq!(h[http::header::CONTENT_SECURITY_POLICY], r.value());
        // a static render drops them for good: no template, nothing to expand
        let s = Resolved::new(
            &CspConfig {
                drop_host: true,
                ..c
            },
            None,
            None,
        )
        .unwrap();
        assert!(!s.needs_host());
        // a directive whose only extra was {host} keeps its name and 'self'
        assert_eq!(
            expand_host(
                "default-src 'none'; frame-src https://{host}; img-src 'self'",
                None
            ),
            "default-src 'none'; frame-src; img-src 'self'"
        );
        // no {host} anywhere: prebuilt, the request is never looked at, and no Vary is added
        let plain = Resolved::new(&cfg(), None, None).unwrap();
        assert!(!plain.needs_host());
        let mut h = html();
        plain.stamp(&mut h, Some("shop.example"));
        assert!(h.get(http::header::VARY).is_none());
    }

    #[test]
    fn a_host_policy_varies_by_host_once() {
        let r = Resolved::new(
            &CspConfig {
                connect_src: vec!["wss://{host}".into()],
                ..cfg()
            },
            None,
            None,
        )
        .unwrap();
        for (before, want) in [
            (None, vec!["Host"]),
            (Some("Accept-Encoding"), vec!["Accept-Encoding", "Host"]),
            (Some("accept-encoding, HOST"), vec!["accept-encoding, HOST"]),
            (Some("*"), vec!["*"]),
        ] {
            for host in [Some("shop.example"), Some("bad host"), None] {
                let mut h = HeaderMap::new();
                h.insert(
                    http::header::CONTENT_TYPE,
                    HeaderValue::from_static("text/html"),
                );
                if let Some(v) = before {
                    h.insert(http::header::VARY, HeaderValue::from_static(v));
                }
                r.stamp(&mut h, host);
                let got: Vec<&str> = h
                    .get_all(http::header::VARY)
                    .iter()
                    .map(|v| v.to_str().unwrap())
                    .collect();
                assert_eq!(got, want, "{before:?} {host:?}");
            }
        }
    }

    #[test]
    fn host_is_refused_in_script_src_and_allowed_elsewhere() {
        let e = CspConfig {
            script_src: vec!["https://{host}".into()],
            script_src_unsafe: true,
            ..cfg()
        }
        .validate()
        .unwrap_err();
        assert!(e.contains("{host}") && e.contains("script_src"), "{e}");
        for (k, c) in [
            (
                "connect",
                CspConfig {
                    connect_src: vec!["wss://{host}".into()],
                    ..cfg()
                },
            ),
            (
                "img",
                CspConfig {
                    img_src: vec!["https://{host}".into()],
                    ..cfg()
                },
            ),
            (
                "form",
                CspConfig {
                    form_action: vec!["https://{host}".into()],
                    ..cfg()
                },
            ),
            (
                "style",
                CspConfig {
                    style_src: vec!["https://{host}".into()],
                    ..cfg()
                },
            ),
        ] {
            assert!(c.validate().is_ok(), "{k}");
        }
    }

    #[test]
    fn a_response_with_either_policy_gets_neither_from_brust() {
        for mode in [CspMode::Enforce, CspMode::ReportOnly] {
            let r = Resolved::new(&CspConfig { mode, ..cfg() }, None, None).unwrap();
            for own in [
                http::header::CONTENT_SECURITY_POLICY,
                http::header::CONTENT_SECURITY_POLICY_REPORT_ONLY,
            ] {
                let mut h = HeaderMap::new();
                h.insert(
                    http::header::CONTENT_TYPE,
                    HeaderValue::from_static("text/html"),
                );
                h.insert(own.clone(), HeaderValue::from_static("default-src 'none'"));
                r.stamp(&mut h, None);
                assert_eq!(h.len(), 2, "{mode:?} over {own}");
                assert_eq!(h[&own], "default-src 'none'");
            }
        }
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
        r.stamp(&mut h, None);
        assert!(h.get(http::header::CONTENT_SECURITY_POLICY).is_none());
        assert!(
            h.get(http::header::CONTENT_SECURITY_POLICY_REPORT_ONLY)
                .is_some()
        );
    }
}
