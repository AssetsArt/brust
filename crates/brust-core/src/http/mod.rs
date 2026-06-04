//! HTTP wire helpers: gzip content negotiation (`compress`).
//!
//! The raw-byte response/error builders that once lived in `response` are gone:
//! the hyper service builds typed `http::Response` values directly (see
//! `server::body` + `render::stream::response_from_meta`), and the cache-store
//! framing path (`render::stream::build_single_response_bytes`) carries its own
//! reason-phrase lookup. Only the compression helpers remain here.

pub mod compress;
