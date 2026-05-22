mod boot;
mod config;
mod ipc;
mod listener;
mod pool;
mod proxy;
mod router;
mod worker;

use std::sync::Arc;

use pingora_core::apps::http_app::HttpServer;
use pingora_core::server::Server;
use pingora_core::services::background::background_service;
use pingora_core::services::listening::Service;
use tracing_subscriber::EnvFilter;

use crate::boot::BrustBoot;
use crate::config::Config;
use crate::listener::BrustApp;
use crate::proxy::Brust;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("brust=info")),
        )
        .with_target(false)
        .init();

    let config = Arc::new(Config::load());
    let brust = Arc::new(Brust::new());

    let mut server = Server::new(None).expect("pingora server");
    server.bootstrap();

    // Boot service: spawns Bun workers and populates brust.pool / brust.router.
    let boot = BrustBoot {
        brust: brust.clone(),
        config: config.clone(),
    };
    server.add_service(background_service("brust-boot", boot));

    // Listening service: pingora HttpServer wrapping our ServeHttp impl.
    let app = HttpServer::new_app(BrustApp(brust.clone()));
    let mut listener = Service::new("brust-listener".to_owned(), app);

    let addr = format!("127.0.0.1:{}", config.port);
    listener.add_tcp(&addr);

    // The OS-assigned port is announced by the listener at bind time; pingora logs
    // it via tracing. Mirror it on stdout so the integration test can parse it.
    println!("brust: listening on {addr}");

    server.add_service(listener);
    server.run_forever();
}
