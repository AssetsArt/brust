// Stand-in for the file Bun's `scripts/build/buildOptionsRs.ts` writes at configure
// time. `bun_core` does `include!(concat!(env!("BUN_CODEGEN_DIR"), "/build_options.rs"))`.
// Keep SHA equal to the pinned rev in Cargo.toml (40 hex chars — const-eval slices it).
#[allow(dead_code, unreachable_pub, unused)]
pub const SHA: &str = "620b50f6abea3413a30235c5885bfe8cbffd592d";
#[allow(dead_code, unreachable_pub, unused)]
pub const REPORTED_NODEJS_VERSION: &str = "v24.3.0";
#[allow(dead_code, unreachable_pub, unused)]
pub const RELEASE_SAFE: bool = false;
#[allow(dead_code, unreachable_pub, unused)]
pub const IS_CANARY: bool = false;
#[allow(dead_code, unreachable_pub, unused)]
pub const CANARY_REVISION: &str = "0";
#[allow(dead_code, unreachable_pub, unused)]
pub const ENABLE_FUZZILLI: bool = false;
#[allow(dead_code, unreachable_pub, unused)]
pub const FALLBACK_HTML_VERSION: &str = "0000000000000000";
#[allow(dead_code, unreachable_pub, unused)]
pub const VERSION: crate::Version = crate::Version { major: 1, minor: 4, patch: 2 };
#[allow(dead_code, unreachable_pub, unused)]
pub const BASE_PATH: &[u8] = "/brust-v2".as_bytes();
#[allow(dead_code, unreachable_pub, unused)]
pub const CODEGEN_PATH: &[u8] = "/brust-v2/bun-codegen".as_bytes();
#[allow(dead_code, unreachable_pub, unused)]
pub const ENABLE_LOGS: bool = cfg!(bun_debug);
#[allow(dead_code, unreachable_pub, unused)]
pub const ENABLE_ASAN: bool = cfg!(bun_asan);
#[allow(dead_code, unreachable_pub, unused)]
pub const ENABLE_TINYCC: bool = !cfg!(any(target_os = "android", target_os = "freebsd"));
