//! Routing: the page route table (`routes`) and the action/RPC router
//! (`action`).

pub mod action;
pub mod routes;

pub use action::{ActionRouter, InsertError, MatchOutcome, Method};
pub use routes::{
    ActionEnvelope, MatchResult, McpEnvelope, RequestEnvelope, RouteConfig, RouteEnvelope,
    RouteInstallError, RouteTable, SseEnvelope, WsEnvelope,
};
// The internal envelope-construction helpers (`build_*_envelope`,
// `serialize_as_map`, `rewrite_envelope_kind`) are intentionally NOT re-exported:
// the napi binding never calls them, and the core `server` module reaches them
// through their full `routes::` path.
