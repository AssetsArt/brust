use std::sync::Arc;

use async_trait::async_trait;
use pingora_core::server::ShutdownWatch;
use pingora_core::services::background::BackgroundService;
use pingora_core::services::ServiceReadyNotifier;
use tracing::info;

use crate::config::Config;
use crate::pool::WorkerPool;
use crate::proxy::Brust;
use crate::router::RouteTable;
use crate::worker::spawn_and_handshake;

pub struct BrustBoot {
    pub brust: Arc<Brust>,
    pub config: Arc<Config>,
}

#[async_trait]
impl BackgroundService for BrustBoot {
    async fn start_with_ready_notifier(
        &self,
        mut shutdown: ShutdownWatch,
        ready: ServiceReadyNotifier,
    ) {
        let routes = vec!["/".to_owned()];
        let routes_arc = Arc::new(routes.clone());

        let mut workers = Vec::with_capacity(self.config.num_workers);
        for id in 0..self.config.num_workers as u32 {
            match spawn_and_handshake(id, self.config.boot_timeout_ms, routes_arc.clone()).await {
                Ok(handle) => {
                    info!(worker_id = id, "worker ready");
                    workers.push(handle);
                }
                Err(e) => {
                    eprintln!("brust: failed to start worker {id}: {e}");
                    std::process::exit(1);
                }
            }
        }

        self.brust
            .router
            .set(RouteTable::from_paths(routes))
            .map_err(|_| "router already set")
            .expect("router set once");
        self.brust
            .pool
            .set(WorkerPool::new(workers))
            .map_err(|_| "pool already set")
            .expect("pool set once");

        info!("brust: all workers ready");
        ready.notify_ready();

        // Wait for shutdown.
        let _ = shutdown.changed().await;
        info!("brust: boot service shutting down");
    }
}
