//! End-to-end TLS smoke test: build the acceptor via `brust_core`, serve a
//! fixed 200 over hyper on an ephemeral port, and drive a real `tokio-rustls`
//! client GET — asserting the TLS handshake completes, ALPN negotiates `h2`,
//! and the response is 200. Then a second client forcing only `http/1.1` in its
//! ALPN list confirms the fallback path also negotiates and serves 200.
//!
//! This exercises the actual `build_acceptor` config (cert load + ALPN list),
//! which is the production code path the napi binding wires into the accept
//! loop. The accept loop itself needs the napi worker pool, so we serve a
//! trivial hyper handler here instead — the TLS layer under test is identical.

use std::convert::Infallible;
use std::sync::Arc;

use brust_core::server::tls::{TlsConfig, build_acceptor};
use http_body_util::Empty;
use hyper::body::Bytes;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::{TokioExecutor, TokioIo};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsConnector;

fn fixture(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/server/test_data")
        .join(name)
}

/// Accept any server certificate (the fixture is self-signed). Test-only.
#[derive(Debug)]
struct NoVerify;

impl ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::ED25519,
        ]
    }
}

async fn ok_handler(
    _req: Request<hyper::body::Incoming>,
) -> Result<Response<Empty<Bytes>>, Infallible> {
    Ok(Response::builder()
        .status(200)
        .body(Empty::<Bytes>::new())
        .unwrap())
}

fn client_config(alpn: Vec<Vec<u8>>) -> ClientConfig {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let mut cfg = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(NoVerify))
        .with_no_client_auth();
    cfg.alpn_protocols = alpn;
    cfg
}

/// A client config restricted to TLS 1.2 only. Used to prove that a 1.3-only
/// server refuses to negotiate down: this client cannot offer TLS 1.3, so the
/// handshake must fail. Mirrors `client_config`'s verifier wiring (`NoVerify`).
fn client_config_tls12_only(alpn: Vec<Vec<u8>>) -> ClientConfig {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let mut cfg = ClientConfig::builder_with_protocol_versions(&[&rustls::version::TLS12])
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(NoVerify))
        .with_no_client_auth();
    cfg.alpn_protocols = alpn;
    cfg
}

/// Boot a one-shot TLS hyper server, return its bound addr. Serves a single
/// connection then exits. Uses the default min version (TLS 1.2 + 1.3).
async fn spawn_tls_server() -> std::net::SocketAddr {
    spawn_tls_server_with(brust_core::server::tls::TlsMinVersion::default()).await
}

/// Boot a one-shot TLS hyper server with an explicit minimum TLS version.
async fn spawn_tls_server_with(
    min_version: brust_core::server::tls::TlsMinVersion,
) -> std::net::SocketAddr {
    let cfg = TlsConfig {
        cert_path: fixture("cert.pem"),
        key_path: fixture("key.pem"),
        min_version,
    };
    let acceptor = build_acceptor(&cfg).expect("build_acceptor");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else {
                return;
            };
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(tls) = acceptor.accept(tcp).await else {
                    return;
                };
                let io = TokioIo::new(tls);
                let _ = hyper_util::server::conn::auto::Builder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(io, service_fn(ok_handler))
                    .await;
            });
        }
    });

    addr
}

/// Connect a tokio-rustls client with the given ALPN list; return the negotiated
/// ALPN protocol after handshake.
async fn handshake_alpn(addr: std::net::SocketAddr, alpn: Vec<Vec<u8>>) -> Option<Vec<u8>> {
    let connector = TlsConnector::from(Arc::new(client_config(alpn)));
    let tcp = TcpStream::connect(addr).await.unwrap();
    let server_name = ServerName::try_from("localhost").unwrap();
    let tls = connector
        .connect(server_name, tcp)
        .await
        .expect("handshake");
    let (_, conn) = tls.get_ref();
    conn.alpn_protocol().map(|p| p.to_vec())
}

#[tokio::test]
async fn tls_handshake_negotiates_h2_alpn() {
    let addr = spawn_tls_server().await;
    let negotiated = handshake_alpn(addr, vec![b"h2".to_vec(), b"http/1.1".to_vec()]).await;
    assert_eq!(
        negotiated.as_deref(),
        Some(&b"h2"[..]),
        "server should prefer h2 in ALPN"
    );
}

#[tokio::test]
async fn tls_handshake_falls_back_to_http11_alpn() {
    let addr = spawn_tls_server().await;
    let negotiated = handshake_alpn(addr, vec![b"http/1.1".to_vec()]).await;
    assert_eq!(
        negotiated.as_deref(),
        Some(&b"http/1.1"[..]),
        "client offering only http/1.1 should negotiate http/1.1"
    );
}

#[tokio::test]
async fn tls_h2_request_returns_200() {
    let addr = spawn_tls_server().await;
    let connector = TlsConnector::from(Arc::new(client_config(vec![b"h2".to_vec()])));
    let tcp = TcpStream::connect(addr).await.unwrap();
    let server_name = ServerName::try_from("localhost").unwrap();
    let tls = connector
        .connect(server_name, tcp)
        .await
        .expect("handshake");

    let io = TokioIo::new(tls);
    let (mut sender, conn) = hyper::client::conn::http2::handshake(TokioExecutor::new(), io)
        .await
        .expect("h2 client handshake");
    tokio::spawn(async move {
        let _ = conn.await;
    });

    let req = Request::builder()
        .uri("https://localhost/")
        .body(Empty::<Bytes>::new())
        .unwrap();
    let resp = sender.send_request(req).await.expect("send_request");
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
async fn tls13_only_server_rejects_tls12_client() {
    // Server restricted to TLS 1.3 only; client restricted to TLS 1.2 only.
    // There is no common protocol version, so the handshake must fail at version
    // negotiation (the server sends a protocol_version alert). This is the
    // end-to-end proof that `min_version: Tls13` actually rejects 1.2 clients —
    // not just that the acceptor builds.
    let addr = spawn_tls_server_with(brust_core::server::tls::TlsMinVersion::Tls13).await;

    let connector = TlsConnector::from(Arc::new(client_config_tls12_only(vec![
        b"h2".to_vec(),
        b"http/1.1".to_vec(),
    ])));
    let tcp = TcpStream::connect(addr).await.unwrap();
    let server_name = ServerName::try_from("localhost").unwrap();
    let result = connector.connect(server_name, tcp).await;

    assert!(
        result.is_err(),
        "TLS 1.3-only server must reject a TLS 1.2-only client, but the handshake succeeded"
    );
}
