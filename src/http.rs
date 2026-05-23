use httparse::{Request as HttpRequest, Status, EMPTY_HEADER};

pub struct ParsedRequest<'a> {
    pub method: &'a str,
    pub path: &'a str,
}

pub fn parse_request<'a>(buf: &'a [u8]) -> Result<ParsedRequest<'a>, ParseError> {
    let mut headers = [EMPTY_HEADER; 32];
    let mut req = HttpRequest::new(&mut headers);
    match req.parse(buf) {
        Ok(Status::Complete(_)) => Ok(ParsedRequest {
            method: req.method.ok_or(ParseError::Incomplete)?,
            path: req.path.ok_or(ParseError::Incomplete)?,
        }),
        Ok(Status::Partial) => Err(ParseError::Incomplete),
        Err(_) => Err(ParseError::Invalid),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("incomplete request")]
    Incomplete,
    #[error("invalid request")]
    Invalid,
}

pub fn build_response(status: u16, content_type: &str, body: Vec<u8>) -> Vec<u8> {
    let status_text = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        414 => "URI Too Long",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Unknown",
    };
    let header = format!(
        "HTTP/1.1 {status} {status_text}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n",
        body.len(),
    );
    let mut out = header.into_bytes();
    out.extend_from_slice(&body);
    out
}

pub fn error_400() -> Vec<u8> {
    build_response(400, "text/plain", b"bad request".to_vec())
}
pub fn error_404() -> Vec<u8> {
    build_response(404, "text/plain", b"not found".to_vec())
}
pub fn error_405() -> Vec<u8> {
    build_response(405, "text/plain", b"method not allowed".to_vec())
}
pub fn error_414() -> Vec<u8> {
    build_response(414, "text/plain", b"uri too long".to_vec())
}
pub fn error_503(msg: &str) -> Vec<u8> {
    build_response(503, "text/plain", msg.as_bytes().to_vec())
}
