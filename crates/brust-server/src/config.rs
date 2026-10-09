//! Server configuration. Task 1 carries only `CorsConfig` (verbatim from
//! brust-core `config.rs:27-78` @ d04718f); the full `Config` arrives later.

/// Global CORS policy, set once at boot (via `ServeOptions.cors` in the napi
/// binding). `None` (the default) = CORS disabled, byte-identical behavior.
///
/// Origin matching is an exact string match (scheme+host+port) against
/// `origins`; a list CONTAINING `"*"` is treated as wildcard (every origin
/// allowed, `Access-Control-Allow-Origin: *`), so `["*", "https://x.com"]`
/// cannot dodge the credentials+wildcard validation. No wildcard-subdomain
/// matching in v1.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CorsConfig {
    /// Allowed origins. `["*"]` (or any list containing `"*"`) = any origin.
    pub origins: Vec<String>,
    /// Preflight `Access-Control-Allow-Methods`. `None` → default
    /// `GET,POST,PUT,PATCH,DELETE,OPTIONS`.
    pub methods: Option<Vec<String>>,
    /// Preflight `Access-Control-Allow-Headers`. `None` → echo the request's
    /// `Access-Control-Request-Headers`.
    pub headers: Option<Vec<String>>,
    /// `Access-Control-Expose-Headers` on actual responses. `None` → none.
    pub expose_headers: Option<Vec<String>>,
    /// Emit `Access-Control-Allow-Credentials: true`. INVALID with a wildcard
    /// origin — [`CorsConfig::validate`] rejects the combination at boot.
    pub credentials: bool,
    /// Preflight `Access-Control-Max-Age` seconds. `None` → 600.
    pub max_age_seconds: Option<u32>,
}

impl CorsConfig {
    /// True when the configured origin list contains the literal `"*"`.
    pub fn is_wildcard(&self) -> bool {
        self.origins.iter().any(|o| o == "*")
    }

    /// Boot-time validation (the napi binding mirrors this on the TS side):
    /// `origins` must be non-empty, and `credentials` may not be combined with
    /// a wildcard origin (browsers silently reject that combination — make it
    /// loud at boot instead).
    pub fn validate(&self) -> Result<(), String> {
        if self.origins.is_empty() {
            return Err("cors.origins must be non-empty".to_string());
        }
        if self.credentials && self.is_wildcard() {
            return Err(
                "cors.credentials cannot be combined with a wildcard origin '*' \
                 (browsers reject Access-Control-Allow-Origin: * with credentials); \
                 list explicit origins instead"
                    .to_string(),
            );
        }
        Ok(())
    }
}
