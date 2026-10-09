// The carried modules are byte-identical to brust-core @ d04718f; their
// `pub(crate)` items have no caller until the accept loop lands (Task 7), so
// dead_code is allowed at the `mod` line instead of inside the verbatim files.
// Task 7 removes these allows; any left at the end of the lane is a finding.
#[allow(dead_code)]
pub mod body;
#[allow(dead_code)]
pub(crate) mod cors;
#[allow(dead_code)]
pub mod static_assets;
pub mod tls;
