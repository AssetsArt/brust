//! The request head as the core reads it, from a Workers request's URL and headers (host-tested).
use http::{HeaderMap, HeaderName, HeaderValue};

/// `(authority, path?query)` of an absolute URL (workerd hands the full URL). The fragment is
/// dropped; a missing path is `/`. `None` for a URL without `scheme://`.
pub fn split_url(url: &str) -> Option<(&str, String)> {
    let (_, rest) = url.split_once("://")?;
    let rest = rest.split('#').next().unwrap_or(rest);
    let cut = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(cut);
    let full = if tail.starts_with('/') {
        tail.to_owned()
    } else {
        format!("/{tail}")
    };
    Some((authority, full))
}

/// Header pairs into a map: repeated names kept in order, invalid names/values skipped.
pub fn header_map(pairs: impl IntoIterator<Item = (String, String)>) -> HeaderMap {
    let mut h = HeaderMap::new();
    for (k, v) in pairs {
        if let (Ok(n), Ok(v)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(&v),
        ) {
            h.append(n, v);
        }
    }
    h
}

/// The headers an action's `Request` carries: the client's, less the hop-by-hop pair (F474: the client's
/// `Content-Length` stays), and `host` from `:authority` when none was sent (R8). Non-UTF-8 values are lossy.
pub fn action_request_headers(headers: &HeaderMap, authority: Option<&str>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = headers
        .iter()
        .filter(|(n, _)| !brust_core::body::is_request_hop_header(n.as_str()))
        .map(|(n, v)| (n.as_str().to_owned(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect();
    if !headers.contains_key(http::header::HOST)
        && let Some(au) = authority
    {
        out.push(("host".to_owned(), au.to_owned()));
    }
    out
}

/// The action request's URL: `http://<host>` + `full` when the `host` header (else the URL
/// authority) is a plain host, else `http://localhost` (parity with `actions-bridge.ts` `toRequest`).
pub fn action_url(headers: &HeaderMap, authority: Option<&str>, full: &str) -> String {
    let host = headers
        .get(http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .or(authority)
        .filter(|h| {
            !h.is_empty()
                && h.bytes().all(|b| {
                    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']')
                })
        })
        .unwrap_or("localhost");
    format!("http://{host}{full}")
}

/// A GET/HEAD of `/_brust/cache/stats` (the R11 gate runs before the core sees it).
pub fn is_stats(method: &str, full: &str) -> bool {
    matches!(method, "GET" | "HEAD") && full.split('?').next() == Some("/_brust/cache/stats")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(a: &'static str, p: &str) -> Option<(&'static str, String)> {
        Some((a, p.to_owned()))
    }

    #[test]
    fn an_action_request_keeps_the_clients_content_length_and_drops_the_hop_pair() {
        let mut h = HeaderMap::new();
        h.insert("host", "a.test".parse().unwrap());
        h.insert("content-length", "1024".parse().unwrap());
        h.insert("transfer-encoding", "chunked".parse().unwrap());
        h.insert("connection", "keep-alive".parse().unwrap());
        let p = action_request_headers(&h, None);
        assert!(p.contains(&("content-length".into(), "1024".into())));
        assert!(p.iter().all(|(n, _)| n != "transfer-encoding" && n != "connection"));
        // chunked: no length to keep, none invented
        h.remove("content-length");
        assert!(action_request_headers(&h, None).iter().all(|(n, _)| n != "content-length"));
    }

    #[test]
    fn an_action_request_takes_host_from_the_authority_when_none_was_sent() {
        let h = HeaderMap::new();
        assert_eq!(action_request_headers(&h, Some("b.test")), [("host".to_string(), "b.test".to_string())]);
        assert!(action_request_headers(&h, None).is_empty());
    }

    #[test]
    fn split_url_takes_authority_and_path_query() {
        assert_eq!(
            split_url("https://a.example:8443/x?q=1"),
            s("a.example:8443", "/x?q=1")
        );
        assert_eq!(split_url("https://a.example"), s("a.example", "/"));
        assert_eq!(split_url("http://h/p?q#frag"), s("h", "/p?q"));
        assert_eq!(split_url("http://h?q"), s("h", "/?q"));
        assert_eq!(split_url("not a url"), None);
    }

    #[test]
    fn header_map_keeps_repeats_and_skips_invalid_pairs() {
        let h = header_map(vec![
            ("set-cookie".to_string(), "a=1".to_string()),
            ("set-cookie".to_string(), "b=2".to_string()),
            ("bad name".to_string(), "x".to_string()),
            ("x-ok".to_string(), "v\u{1}".to_string()),
        ]);
        let c: Vec<_> = h.get_all("set-cookie").iter().collect();
        assert_eq!(c, ["a=1", "b=2"]);
        assert_eq!(h.len(), 2);
    }

    #[test]
    fn action_url_uses_a_plain_host_else_localhost() {
        let mut h = HeaderMap::new();
        h.insert("host", HeaderValue::from_static("app.example:8787"));
        assert_eq!(
            action_url(&h, None, "/a?x=1"),
            "http://app.example:8787/a?x=1"
        );
        assert_eq!(
            action_url(&HeaderMap::new(), Some("[::1]:80"), "/a"),
            "http://[::1]:80/a"
        );
        let mut bad = HeaderMap::new();
        bad.insert("host", HeaderValue::from_static("evil/x"));
        assert_eq!(action_url(&bad, None, "/a"), "http://localhost/a");
        assert_eq!(
            action_url(&HeaderMap::new(), None, "/a"),
            "http://localhost/a"
        );
    }

    #[test]
    fn is_stats_only_for_get_and_head_of_the_stats_path() {
        assert!(is_stats("GET", "/_brust/cache/stats"));
        assert!(is_stats("HEAD", "/_brust/cache/stats?x=1"));
        assert!(!is_stats("POST", "/_brust/cache/stats"));
        assert!(!is_stats("GET", "/_brust/cache/statsx"));
        assert!(!is_stats("GET", "/"));
    }
}
