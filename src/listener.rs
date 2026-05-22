use std::sync::Arc;

use async_trait::async_trait;
use http::Response;
use pingora_core::apps::http_app::ServeHttp;
use pingora_core::protocols::http::ServerSession;

use crate::proxy::{handle_path, Brust};

pub struct BrustApp(pub Arc<Brust>);

#[async_trait]
impl ServeHttp for BrustApp {
    async fn response(&self, session: &mut ServerSession) -> Response<Vec<u8>> {
        let path = session
            .req_header()
            .uri
            .path()
            .to_owned();
        handle_path(self.0.as_ref(), &path).await
    }
}
