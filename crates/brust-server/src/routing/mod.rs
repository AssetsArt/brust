//! Routing: the page route table built from the manifest.

pub mod routes;

pub use routes::{
    MatchResult, RequestEnvelope, RouteConfig, RouteEnvelope, RouteInstallError, RouteTable,
};
