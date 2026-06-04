//! HTTP wire helpers: request parsing / response building (`response`) and
//! gzip content negotiation (`compress`).

pub mod compress;
pub mod response;

pub use response::{
    ParseError, ParsedRequest, build_response, build_response_head, error_400, error_404,
    error_405, error_411, error_413, error_414, error_415, error_500, error_503, parse_request,
    status_reason,
};
