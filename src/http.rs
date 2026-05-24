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

pub fn build_response(
    status: u16,
    content_type: &str,
    extra_headers: &[(String, String)],
    body: Vec<u8>,
) -> Vec<u8> {
    let status_text = match status {
        200 => "OK",
        301 => "Moved Permanently",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        413 => "Payload Too Large",
        414 => "URI Too Long",
        415 => "Unsupported Media Type",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Unknown",
    };
    let mut header = format!(
        "HTTP/1.1 {status} {status_text}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Connection: keep-alive\r\n",
        body.len(),
    );
    for (name, value) in extra_headers {
        // Skip names that would collide with the fixed lines above.
        let lower = name.to_ascii_lowercase();
        if lower == "content-type" || lower == "content-length" || lower == "connection" {
            continue;
        }
        if name.bytes().any(|b| b == b'\r' || b == b'\n' || b == b'\0')
            || value.bytes().any(|b| b == b'\r' || b == b'\n' || b == b'\0')
        {
            continue;
        }
        header.push_str(&format!("{name}: {value}\r\n"));
    }
    header.push_str("\r\n");
    let mut out = header.into_bytes();
    out.extend_from_slice(&body);
    out
}

pub fn error_400() -> Vec<u8> {
    build_response(400, "text/plain", &[], b"bad request".to_vec())
}
pub fn error_404() -> Vec<u8> {
    build_response(404, "text/plain", &[], b"not found".to_vec())
}
pub fn error_405() -> Vec<u8> {
    build_response(405, "text/plain", &[], b"method not allowed".to_vec())
}
pub fn error_411() -> Vec<u8> {
    build_response(411, "text/plain", &[], b"length required".to_vec())
}
pub fn error_413() -> Vec<u8> {
    // Body might be partially read at this point — Connection: close so
    // the client doesn't try to pipeline another request on this socket.
    let body: &[u8] = b"payload too large";
    let header = format!(
        "HTTP/1.1 413 Payload Too Large\r\n\
         Content-Type: text/plain\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n",
        body.len(),
    );
    let mut out = header.into_bytes();
    out.extend_from_slice(body);
    out
}
pub fn error_414() -> Vec<u8> {
    let body: &[u8] = b"uri too long";
    let header = format!(
        "HTTP/1.1 414 URI Too Long\r\n\
         Content-Type: text/plain\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n",
        body.len(),
    );
    let mut out = header.into_bytes();
    out.extend_from_slice(body);
    out
}
pub fn error_415() -> Vec<u8> {
    // Body might be partially read at this point — Connection: close so
    // the client doesn't try to pipeline another request on this socket.
    let body: &[u8] = b"unsupported media type";
    let header = format!(
        "HTTP/1.1 415 Unsupported Media Type\r\n\
         Content-Type: text/plain\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len(),
    );
    let mut out = header.into_bytes();
    out.extend_from_slice(body);
    out
}
pub fn error_503(msg: &str) -> Vec<u8> {
    build_response(503, "text/plain", &[], msg.as_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn as_str(bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).into_owned()
    }

    #[test]
    fn empty_extra_headers_produces_baseline_response() {
        let bytes = build_response(200, "text/plain", &[], b"hi".to_vec());
        let s = as_str(&bytes);
        assert!(s.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(s.contains("Content-Type: text/plain\r\n"));
        assert!(s.contains("Content-Length: 2\r\n"));
        assert!(s.contains("Connection: keep-alive\r\n"));
        assert!(s.ends_with("\r\n\r\nhi"));
    }

    #[test]
    fn normal_extra_header_appears_in_output() {
        let extra = vec![("X-Foo".to_string(), "bar".to_string())];
        let bytes = build_response(200, "text/plain", &extra, b"".to_vec());
        assert!(as_str(&bytes).contains("X-Foo: bar\r\n"));
    }

    #[test]
    fn collision_skip_is_case_insensitive() {
        let extra = vec![
            ("Content-Type".to_string(), "evil".to_string()),
            ("CONTENT-LENGTH".to_string(), "0".to_string()),
            ("connection".to_string(), "close".to_string()),
        ];
        let bytes = build_response(200, "text/plain", &extra, b"".to_vec());
        let s = as_str(&bytes);
        // None of the colliding entries should have been written.
        assert!(!s.contains("Content-Type: evil"));
        assert!(!s.contains("CONTENT-LENGTH: 0"));
        assert!(!s.contains("connection: close"));
        // The fixed lines remain.
        assert_eq!(s.matches("Content-Type: text/plain").count(), 1);
    }

    #[test]
    fn crlf_in_header_value_drops_entry() {
        let extra = vec![("X-Evil".to_string(), "v\r\nSet-Cookie: x".to_string())];
        let bytes = build_response(200, "text/plain", &extra, b"".to_vec());
        let s = as_str(&bytes);
        assert!(!s.contains("Set-Cookie"));
        assert!(!s.contains("X-Evil"));
    }

    #[test]
    fn crlf_in_header_name_drops_entry() {
        let extra = vec![("X\r\nSet-Cookie: x".to_string(), "v".to_string())];
        let bytes = build_response(200, "text/plain", &extra, b"".to_vec());
        let s = as_str(&bytes);
        assert!(!s.contains("Set-Cookie"));
    }

    #[test]
    fn error_415_status_line() {
        let resp = error_415();
        let s = std::str::from_utf8(&resp).unwrap();
        assert!(s.starts_with("HTTP/1.1 415 Unsupported Media Type\r\n"));
        assert!(s.contains("Content-Type: text/plain"));
        assert!(s.contains("Content-Length: "));
        // 415 closes the connection because the body may not have been fully read.
        assert!(s.contains("Connection: close"));
        // Body is the short reason phrase.
        assert!(s.ends_with("unsupported media type"));
    }
}
