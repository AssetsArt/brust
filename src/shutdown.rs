use std::sync::Arc;

use tokio::sync::Notify;

#[derive(Default)]
pub struct Shutdown {
    notify: Notify,
}

impl Shutdown {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn wait(&self) {
        self.notify.notified().await;
    }

    pub fn signal(&self) {
        self.notify.notify_waiters();
    }
}

/// Install a SIGINT handler that calls shutdown.signal() once.
/// Safe to call multiple times — subsequent calls are no-ops.
pub fn install_sigint_handler(shutdown: Arc<Shutdown>) {
    // Spawn a small std::thread that uses tokio::signal::ctrl_c via a one-off runtime.
    // We don't use the main I/O runtime because it may live on a different thread.
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("signal runtime");
        rt.block_on(async {
            tokio::signal::ctrl_c().await.ok();
            shutdown.signal();
        });
    });
}
