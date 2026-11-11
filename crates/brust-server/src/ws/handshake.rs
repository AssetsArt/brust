//! F529 D9: the WebSocket opening handshake (RFC 6455 §4.2.1), checked before any worker runs.
use http::{HeaderMap, HeaderValue, Method, Version, header};

/// Why a request that asked for `Upgrade: websocket` cannot have it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// 400 with this text.
    Bad(&'static str),
    /// 426 + `Sec-WebSocket-Version: 13`: a version this server does not speak.
    Version,
}

/// Does this request ask to become a WebSocket? A GET whose `Upgrade` lists the `websocket` token (any case).
pub(crate) fn asks(method: &Method, headers: &HeaderMap) -> bool {
    method == Method::GET
        && tokens(headers, header::UPGRADE).any(|t| t.eq_ignore_ascii_case("websocket"))
}

/// The handshake checks after [`asks`]: HTTP/1.1, `Connection: Upgrade`, `Sec-WebSocket-Version: 13` and one
/// `Sec-WebSocket-Key` that is 16 bytes of base64. Returns the key.
pub(crate) fn check(version: Version, headers: &HeaderMap) -> Result<HeaderValue, Refusal> {
    if version != Version::HTTP_11 {
        // RFC 8441 (HTTP/2 extended CONNECT) is not supported; HTTP/1.0 has no upgrade.
        return Err(Refusal::Bad("a WebSocket upgrade needs HTTP/1.1"));
    }
    if !tokens(headers, header::CONNECTION).any(|t| t.eq_ignore_ascii_case("upgrade")) {
        return Err(Refusal::Bad(
            "a WebSocket upgrade needs Connection: Upgrade",
        ));
    }
    let mut versions = headers.get_all(header::SEC_WEBSOCKET_VERSION).iter();
    match (versions.next(), versions.next()) {
        (None, _) => return Err(Refusal::Bad("missing Sec-WebSocket-Version")),
        (Some(v), None) if v.as_bytes().trim_ascii() == b"13" => {}
        _ => return Err(Refusal::Version),
    }
    let mut keys = headers.get_all(header::SEC_WEBSOCKET_KEY).iter();
    match (keys.next(), keys.next()) {
        (Some(k), None) if is_key(k.as_bytes()) => Ok(k.clone()),
        _ => Err(Refusal::Bad("Sec-WebSocket-Key must be 16 bytes of base64")),
    }
}

/// `Sec-WebSocket-Accept` for `key`.
pub(crate) fn accept(key: &HeaderValue) -> HeaderValue {
    let v = tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
    HeaderValue::from_str(&v).expect("base64 is a valid header value")
}

/// 16 bytes in base64: 22 alphabet characters, the last carrying only 2 bits, then `==`.
fn is_key(k: &[u8]) -> bool {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    k.len() == 24
        && k.ends_with(b"==")
        && k[..22].iter().all(|&c| val(c).is_some())
        && val(k[21]).is_some_and(|v| v & 0x0f == 0)
}

/// The comma-separated tokens of every `name` header, trimmed.
fn tokens(headers: &HeaderMap, name: header::HeaderName) -> impl Iterator<Item = &str> {
    headers
        .get_all(name)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.append(
                header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        m
    }

    const KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";

    fn good() -> Vec<(&'static str, &'static str)> {
        vec![
            ("upgrade", "websocket"),
            ("connection", "keep-alive, Upgrade"),
            ("sec-websocket-version", "13"),
            ("sec-websocket-key", KEY),
        ]
    }

    #[test]
    fn the_rfc_sample_key_derives_the_rfc_accept() {
        let k = check(Version::HTTP_11, &h(&good())).unwrap();
        assert_eq!(accept(&k), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn asks_needs_a_get_with_the_websocket_token() {
        assert!(asks(&Method::GET, &h(&[("upgrade", "foo, WebSocket")])));
        assert!(!asks(&Method::POST, &h(&[("upgrade", "websocket")])));
        assert!(!asks(&Method::GET, &h(&[("upgrade", "h2c")])));
        assert!(!asks(&Method::GET, &h(&[])));
    }

    #[test]
    fn every_broken_handshake_is_refused() {
        let without = |name: &str| -> Vec<(&str, &str)> {
            good().into_iter().filter(|(k, _)| *k != name).collect()
        };
        let with = |name: &'static str, v: &'static str| -> Vec<(&str, &str)> {
            let mut g = without(name);
            g.push((name, v));
            g
        };
        assert!(matches!(
            check(Version::HTTP_2, &h(&good())),
            Err(Refusal::Bad(_))
        ));
        assert!(matches!(
            check(Version::HTTP_10, &h(&good())),
            Err(Refusal::Bad(_))
        ));
        assert!(matches!(
            check(Version::HTTP_11, &h(&without("connection"))),
            Err(Refusal::Bad(_))
        ));
        assert!(matches!(
            check(Version::HTTP_11, &h(&with("connection", "keep-alive"))),
            Err(Refusal::Bad(_))
        ));
        assert!(matches!(
            check(Version::HTTP_11, &h(&without("sec-websocket-version"))),
            Err(Refusal::Bad(_))
        ));
        assert_eq!(
            check(Version::HTTP_11, &h(&with("sec-websocket-version", "8"))),
            Err(Refusal::Version)
        );
        let mut two = good();
        two.push(("sec-websocket-version", "13"));
        assert_eq!(check(Version::HTTP_11, &h(&two)), Err(Refusal::Version));
        for bad in [
            "",
            "dGhlIHNhbXBsZSBub25jZQ",       // no padding
            "dGhlIHNhbXBsZSBub25jZQ=",      // 23 chars
            "dGhlIHNhbXBsZSBub25jZR==",     // the last char carries bits a 16-byte key has not
            "dGhlIHNhbXBsZSBub25j*Q==",     // not base64
            "dGhlIHNhbXBsZSBub25jZQ==dGhl", // too long
        ] {
            assert!(
                matches!(
                    check(Version::HTTP_11, &h(&with("sec-websocket-key", bad))),
                    Err(Refusal::Bad(_))
                ),
                "{bad:?}"
            );
        }
        let mut keys = good();
        keys.push(("sec-websocket-key", KEY));
        assert!(matches!(
            check(Version::HTTP_11, &h(&keys)),
            Err(Refusal::Bad(_))
        ));
    }
}
