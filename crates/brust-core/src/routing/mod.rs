//! Routing: the page route table (`routes`) and the action/RPC router
//! (`action`).

pub mod action;
pub mod routes;

pub use action::{ActionRouter, InsertError, MatchOutcome, Method};
pub use routes::{
    ActionEnvelope, MatchResult, McpEnvelope, RequestEnvelope, RouteConfig, RouteEnvelope,
    RouteInstallError, RouteTable, SseEnvelope, WsEnvelope, build_action_envelope,
    build_mcp_envelope, build_sse_envelope, build_ws_envelope, rewrite_envelope_kind,
    serialize_as_map,
};
