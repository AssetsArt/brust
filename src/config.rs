use std::env;

pub struct Config {
    pub port: u16,
    pub num_workers: usize,
    pub boot_timeout_ms: u64,
}

impl Config {
    pub fn load() -> Self {
        let port = env::var("BRUST_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3000);
        let num_workers = env::var("BRUST_WORKERS")
            .ok()
            .and_then(|s| s.parse().ok())
            .filter(|n: &usize| *n > 0)
            .unwrap_or_else(num_cpus::get);
        Self {
            port,
            num_workers,
            boot_timeout_ms: 1000,
        }
    }
}

pub fn socket_path(worker_id: u32) -> String {
    format!("/tmp/brust-{worker_id}.sock")
}
