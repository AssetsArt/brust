//! Optional in-process TLS termination via `tokio-rustls`.
//!
//! OFF by default: when `AppState::tls()` is `None`, the accept loop runs the
//! plaintext H1/H2 path unchanged. When a cert+key are configured, the accept
//! loop wraps each TCP stream in the [`tokio_rustls::TlsAcceptor`] built here
//! BEFORE handing it to hyper. ALPN advertises `h2` (preferred) + `http/1.1`,
//! so `auto::Builder` negotiates HTTP/2 over TLS and falls back to HTTP/1.1.

use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Once};

use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::TlsAcceptor;

/// Minimum TLS protocol version the server will negotiate. Default
/// [`TlsMinVersion::Tls12`] keeps rustls' own safe defaults (TLS 1.2 + 1.3);
/// [`TlsMinVersion::Tls13`] restricts to TLS 1.3 only for hardened/compliance
/// deployments. Set via the `tlsMinVersion` napi option (`"1.2"` / `"1.3"`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TlsMinVersion {
    /// rustls default: TLS 1.2 + 1.3 (no RC4/export/CBC-without-MAC).
    #[default]
    Tls12,
    /// TLS 1.3 only.
    Tls13,
}

/// Configured cert + key paths for in-process TLS termination. Built by the
/// napi binding when BOTH `tlsCertPath` and `tlsKeyPath` are supplied; absent
/// otherwise (plaintext).
#[derive(Clone, Debug)]
pub struct TlsConfig {
    pub cert_path: PathBuf,
    pub key_path: PathBuf,
    /// Minimum negotiable TLS version. Default (`Tls12`) = rustls default
    /// (TLS 1.2 + 1.3, unchanged behavior).
    pub min_version: TlsMinVersion,
}

/// Install the process-wide rustls crypto provider exactly once. rustls 0.23
/// requires a `CryptoProvider` to be selectable; with `tokio-rustls` 0.26
/// default features the `aws-lc-rs` provider is compiled in. We install it
/// explicitly (idempotently) so a host that has not already installed one can't
/// panic at first handshake with "no process-level CryptoProvider available".
fn ensure_crypto_provider() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // Err means a provider is already installed — either ours on re-entry, or
        // one the host (Bun) / another lib installed. We don't override it; rustls
        // uses whatever is active. If a different provider is active (e.g. ring/FIPS),
        // TLS still works, just not aws-lc-rs specifically.
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    });
    // A genuine "no provider" state must never silently proceed: a handshake
    // would later panic with "no process-level CryptoProvider available".
    debug_assert!(
        rustls::crypto::CryptoProvider::get_default().is_some(),
        "no rustls CryptoProvider active after install attempt"
    );
}

/// Build a [`TlsAcceptor`] from the configured cert + key (both PEM). Loads the
/// full certificate chain and the first private key found, sets ALPN to
/// `h2` + `http/1.1`, and returns the ready acceptor. A configured-but-broken
/// cert/key surfaces here as an `io::Error` — the caller treats it as a fatal
/// boot failure (mirrors bind failure).
pub fn build_acceptor(cfg: &TlsConfig) -> io::Result<TlsAcceptor> {
    ensure_crypto_provider();

    // ----- certs -----
    let cert_bytes = std::fs::read(&cfg.cert_path).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("tls: cannot read cert {:?}: {e}", cfg.cert_path),
        )
    })?;
    let certs: Vec<CertificateDer<'static>> =
        rustls_pemfile::certs(&mut io::BufReader::new(&cert_bytes[..]))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("tls: invalid cert PEM {:?}: {e}", cfg.cert_path),
                )
            })?;
    if certs.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("tls: no certificates found in {:?}", cfg.cert_path),
        ));
    }

    // ----- private key (first one) -----
    let key_bytes = std::fs::read(&cfg.key_path).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("tls: cannot read key {:?}: {e}", cfg.key_path),
        )
    })?;
    let key: PrivateKeyDer<'static> =
        rustls_pemfile::private_key(&mut io::BufReader::new(&key_bytes[..]))
            .map_err(|e| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("tls: invalid key PEM {:?}: {e}", cfg.key_path),
                )
            })?
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("tls: no private key found in {:?}", cfg.key_path),
                )
            })?;

    // ----- server config -----
    // Default (`Tls12`) keeps rustls' safe default versions (TLS 1.2 + 1.3);
    // `Tls13` restricts to TLS 1.3 only. Both builders yield the same
    // `WantsVerifier` shape, so client-auth + cert wiring is identical.
    let builder = match cfg.min_version {
        TlsMinVersion::Tls12 => rustls::ServerConfig::builder(),
        TlsMinVersion::Tls13 => {
            rustls::ServerConfig::builder_with_protocol_versions(&[&rustls::version::TLS13])
        }
    };
    let mut config = builder
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("tls: cert/key rejected by rustls: {e}"),
            )
        })?;
    // h2 preferred, then http/1.1.
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

    Ok(TlsAcceptor::from(Arc::new(config)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A throwaway self-signed cert+key (ECDSA P-256, PEM) good enough to drive
    /// `build_acceptor` end-to-end without an `openssl` dependency. Generated
    /// with `rcgen`-style output is heavy; instead we embed a fixed pair so the
    /// test is hermetic. NOTE: if regenerating, keep cert+key matched.
    const TEST_CERT_PEM: &str = include_str!("test_data/cert.pem");
    const TEST_KEY_PEM: &str = include_str!("test_data/key.pem");

    fn write_tmp(name: &str, contents: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("brust_tls_test_{}_{}", std::process::id(), name));
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(contents.as_bytes()).unwrap();
        p
    }

    #[test]
    fn build_acceptor_loads_selfsigned_cert() {
        let cert = write_tmp("cert.pem", TEST_CERT_PEM);
        let key = write_tmp("key.pem", TEST_KEY_PEM);
        let cfg = TlsConfig {
            cert_path: cert.clone(),
            key_path: key.clone(),
            min_version: TlsMinVersion::default(),
        };
        let acceptor = build_acceptor(&cfg);
        let _ = std::fs::remove_file(&cert);
        let _ = std::fs::remove_file(&key);
        assert!(
            acceptor.is_ok(),
            "build_acceptor failed: {:?}",
            acceptor.err()
        );
    }

    #[test]
    fn build_acceptor_tls13_only_builds() {
        // `Tls13` restricts the negotiable versions to TLS 1.3 only. rustls
        // doesn't expose the resolved version set on the built `ServerConfig`,
        // so we assert the acceptor builds without error against the fixture —
        // the build path differs from the default only by the version slice.
        let cert = write_tmp("cert13.pem", TEST_CERT_PEM);
        let key = write_tmp("key13.pem", TEST_KEY_PEM);
        let cfg = TlsConfig {
            cert_path: cert.clone(),
            key_path: key.clone(),
            min_version: TlsMinVersion::Tls13,
        };
        let acceptor = build_acceptor(&cfg);
        let _ = std::fs::remove_file(&cert);
        let _ = std::fs::remove_file(&key);
        assert!(
            acceptor.is_ok(),
            "build_acceptor (TLS1.3-only) failed: {:?}",
            acceptor.err()
        );
    }

    #[test]
    fn build_acceptor_errors_on_missing_cert() {
        let cfg = TlsConfig {
            cert_path: PathBuf::from("/nonexistent/brust/cert.pem"),
            key_path: PathBuf::from("/nonexistent/brust/key.pem"),
            min_version: TlsMinVersion::default(),
        };
        assert!(build_acceptor(&cfg).is_err());
    }

    #[test]
    fn build_acceptor_errors_on_empty_cert() {
        let cert = write_tmp("empty_cert.pem", "not a pem\n");
        let key = write_tmp("empty_key.pem", TEST_KEY_PEM);
        let cfg = TlsConfig {
            cert_path: cert.clone(),
            key_path: key.clone(),
            min_version: TlsMinVersion::default(),
        };
        let r = build_acceptor(&cfg);
        let _ = std::fs::remove_file(&cert);
        let _ = std::fs::remove_file(&key);
        assert!(r.is_err());
    }
}
