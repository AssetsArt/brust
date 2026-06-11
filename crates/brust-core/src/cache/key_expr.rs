//! L1 cache-key expression grammar (spec: docs/superpowers/specs/2026-06-11-page-cache-two-modes-design.md).
//! Bare expression -> String ("" = absent/false). Compiled once at route install,
//! evaluated per request. Deterministic-only: uuid()/timestamp() rejected so a
//! cache key is always reproducible.

/// Borrowed request data the evaluator reads. Slices, not maps — the caller
/// already holds these as small vecs at the cache-decision site.
///
/// NOTE: header/cookie/query values are passed through verbatim — NOT
/// percent-decoded. An `eq(cookie(x), "/")` will not match a `%2F`-encoded
/// value. The L1 sorted_query path is likewise undecoded, so key-building stays
/// internally consistent.
pub struct EvalCtx<'a> {
    pub headers: &'a [(&'a str, &'a str)],
    pub cookies: &'a [(&'a str, &'a str)],
    pub query: &'a [(&'a str, &'a str)],
    pub params: &'a [(&'a str, &'a str)],
    pub method: &'a str,
    pub host: &'a str,
    pub scheme: &'a str,
    /// Request path WITHOUT the query string (the L1 CacheKey.path value).
    pub path: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expr {
    Header(String),
    Cookie(String),
    Query(String),
    Param(String),
    Request(String),
    Env(String), // resolved at parse (frozen): stores the value, not the name
    Lit(String),
    Or(Vec<Expr>),
    And(Vec<Expr>),
    Concat(Vec<Expr>),
    Eq(Box<Expr>, Box<Expr>, Option<Box<Expr>>),
    Lower(Box<Expr>),
    Upper(Box<Expr>),
}

pub type ParseError = String;

impl Expr {
    pub fn parse(src: &str) -> Result<Expr, ParseError> {
        let mut p = Parser {
            s: src.as_bytes(),
            i: 0,
        };
        p.skip_ws();
        let e = p.expr()?;
        p.skip_ws();
        if p.i != p.s.len() {
            return Err(format!("cache expression: trailing input at byte {}", p.i));
        }
        Ok(e)
    }

    pub fn eval(&self, ctx: &EvalCtx) -> String {
        fn lookup(pairs: &[(&str, &str)], name: &str) -> String {
            pairs
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| (*v).to_string())
                .unwrap_or_default()
        }
        match self {
            Expr::Header(n) => lookup(ctx.headers, n),
            Expr::Cookie(n) => lookup(ctx.cookies, n),
            Expr::Query(n) => lookup(ctx.query, n),
            Expr::Param(n) => lookup(ctx.params, n),
            Expr::Request(f) => match f.as_str() {
                "host" => ctx.host.to_string(),
                "method" => ctx.method.to_string(),
                "scheme" => ctx.scheme.to_string(),
                "path" => ctx.path.to_string(),
                // unreachable: parse() rejects any other request() field.
                _ => String::new(),
            },
            Expr::Env(v) => v.clone(),
            Expr::Lit(v) => v.clone(),
            Expr::Or(args) => args
                .iter()
                .map(|a| a.eval(ctx))
                .find(|v| !v.is_empty())
                .unwrap_or_default(),
            Expr::And(args) => {
                let vals: Vec<String> = args.iter().map(|a| a.eval(ctx)).collect();
                if vals.iter().all(|v| !v.is_empty()) {
                    vals.join("\u{1f}")
                } else {
                    String::new()
                }
            }
            Expr::Concat(args) => args.iter().map(|a| a.eval(ctx)).collect(),
            Expr::Eq(a, b, v) => {
                let av = a.eval(ctx);
                if av == b.eval(ctx) {
                    v.as_ref().map(|x| x.eval(ctx)).unwrap_or(av)
                } else {
                    String::new()
                }
            }
            Expr::Lower(a) => a.eval(ctx).to_ascii_lowercase(),
            Expr::Upper(a) => a.eval(ctx).to_ascii_uppercase(),
        }
    }
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn skip_ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }

    fn expr(&mut self) -> Result<Expr, ParseError> {
        self.skip_ws();
        if self.i < self.s.len() && (self.s[self.i] == b'\'' || self.s[self.i] == b'"') {
            return self.string_lit().map(Expr::Lit);
        }
        let ident = self.ident()?;
        self.skip_ws();
        // Bare identifier (no following '(') is treated as a string literal.
        // This allows unquoted argument names like header(Authorization).
        if self.i >= self.s.len() || self.s[self.i] != b'(' {
            return Ok(Expr::Lit(ident));
        }
        self.i += 1;
        let args = self.args()?;
        self.expect(b')')?;
        self.build(&ident, args)
    }

    fn args(&mut self) -> Result<Vec<Expr>, ParseError> {
        let mut out = Vec::new();
        self.skip_ws();
        if self.i < self.s.len() && self.s[self.i] == b')' {
            return Ok(out);
        }
        loop {
            out.push(self.expr()?);
            self.skip_ws();
            match self.s.get(self.i) {
                Some(b',') => {
                    self.i += 1;
                    self.skip_ws();
                }
                Some(b')') => return Ok(out),
                _ => return Err("cache expression: expected ',' or ')'".into()),
            }
        }
    }

    fn build(&self, ident: &str, mut args: Vec<Expr>) -> Result<Expr, ParseError> {
        let one_str = |args: &[Expr]| -> Result<String, ParseError> {
            match args {
                [Expr::Lit(s)] => Ok(s.clone()),
                [_] => Err(format!(
                    "cache expression: {ident}() argument must be a string literal"
                )),
                _ => Err(format!(
                    "cache expression: {ident}() takes exactly one argument"
                )),
            }
        };
        match ident {
            "header" => Ok(Expr::Header(one_str(&args)?)),
            "cookie" => Ok(Expr::Cookie(one_str(&args)?)),
            "query" => Ok(Expr::Query(one_str(&args)?)),
            "param" => Ok(Expr::Param(one_str(&args)?)),
            "request" => {
                let f = one_str(&args)?;
                match f.as_str() {
                    "host" | "method" | "scheme" | "path" => Ok(Expr::Request(f)),
                    other => Err(format!(
                        "cache expression: request('{other}') — field must be host|method|scheme|path"
                    )),
                }
            }
            "env" => Ok(Expr::Env(
                std::env::var(one_str(&args)?).unwrap_or_default(),
            )),
            "or" => {
                if args.is_empty() {
                    return Err("cache expression: or() needs >= 1 argument".into());
                }
                Ok(Expr::Or(args))
            }
            "and" => {
                if args.is_empty() {
                    return Err("cache expression: and() needs >= 1 argument".into());
                }
                Ok(Expr::And(args))
            }
            "concat" => {
                if args.is_empty() {
                    return Err("cache expression: concat() needs >= 1 argument".into());
                }
                Ok(Expr::Concat(args))
            }
            "lower" | "upper" => {
                if args.len() != 1 {
                    return Err(format!("cache expression: {ident}() takes one argument"));
                }
                let a = Box::new(args.remove(0));
                Ok(if ident == "lower" {
                    Expr::Lower(a)
                } else {
                    Expr::Upper(a)
                })
            }
            "eq" => match args.len() {
                2 => {
                    let b = Box::new(args.remove(1));
                    let a = Box::new(args.remove(0));
                    Ok(Expr::Eq(a, b, None))
                }
                3 => {
                    let v = Box::new(args.remove(2));
                    let b = Box::new(args.remove(1));
                    let a = Box::new(args.remove(0));
                    Ok(Expr::Eq(a, b, Some(v)))
                }
                _ => Err("cache expression: eq() takes 2 or 3 arguments".into()),
            },
            "uuid" | "timestamp" => Err(format!(
                "cache expression: {ident}() is non-deterministic and not allowed in cache keys"
            )),
            other => Err(format!("cache expression: unknown function '{other}'")),
        }
    }

    fn ident(&mut self) -> Result<String, ParseError> {
        let start = self.i;
        while self.i < self.s.len()
            && (self.s[self.i].is_ascii_alphanumeric()
                || self.s[self.i] == b'_'
                || self.s[self.i] == b'-')
        {
            self.i += 1;
        }
        if self.i == start {
            return Err(format!(
                "cache expression: expected identifier at byte {start}"
            ));
        }
        Ok(String::from_utf8_lossy(&self.s[start..self.i]).into_owned())
    }

    fn string_lit(&mut self) -> Result<String, ParseError> {
        let quote = self.s[self.i];
        self.i += 1;
        let start = self.i;
        while self.i < self.s.len() && self.s[self.i] != quote {
            self.i += 1;
        }
        if self.i >= self.s.len() {
            return Err("cache expression: unterminated string literal".into());
        }
        let out = String::from_utf8_lossy(&self.s[start..self.i]).into_owned();
        self.i += 1;
        Ok(out)
    }

    fn expect(&mut self, c: u8) -> Result<(), ParseError> {
        self.skip_ws();
        if self.s.get(self.i) == Some(&c) {
            self.i += 1;
            Ok(())
        } else {
            Err(format!("cache expression: expected '{}'", c as char))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>() -> EvalCtx<'a> {
        EvalCtx {
            headers: &[("authorization", "Bearer x"), ("x-tenant", "acme")],
            cookies: &[("session", "s1"), ("currency", "thb")],
            query: &[("sort", "new")],
            params: &[("id", "42")],
            method: "GET",
            host: "shop.example.com",
            scheme: "https",
            path: "/p/42",
        }
    }

    fn ev(src: &str) -> String {
        Expr::parse(src).unwrap().eval(&ctx())
    }

    #[test]
    fn request_path_is_threaded() {
        assert_eq!(ev("request(path)"), "/p/42");
    }
    #[test]
    fn reject_unknown_request_field() {
        assert!(Expr::parse("request(referrer)").is_err());
    }

    #[test]
    fn accessor_header_case_insensitive() {
        assert_eq!(ev("header(Authorization)"), "Bearer x");
    }
    #[test]
    fn accessor_cookie() {
        assert_eq!(ev("cookie(currency)"), "thb");
    }
    #[test]
    fn accessor_absent_is_empty() {
        assert_eq!(ev("cookie(nope)"), "");
    }
    #[test]
    fn accessor_query_param_request() {
        assert_eq!(ev("query(sort)"), "new");
        assert_eq!(ev("param(id)"), "42");
        assert_eq!(ev("request(host)"), "shop.example.com");
        assert_eq!(ev("request(method)"), "GET");
        assert_eq!(ev("request(scheme)"), "https");
    }
    #[test]
    fn or_first_non_empty() {
        assert_eq!(ev("or(cookie(nope), header(x-tenant), \"d\")"), "acme");
    }
    #[test]
    fn or_all_empty() {
        assert_eq!(ev("or(cookie(nope), header(nope))"), "");
    }
    #[test]
    fn and_all_present_joins_unit_sep() {
        assert_eq!(
            ev("and(request(host), cookie(currency))"),
            "shop.example.com\u{1f}thb"
        );
    }
    #[test]
    fn and_any_empty_is_empty() {
        assert_eq!(ev("and(request(host), cookie(nope))"), "");
    }
    #[test]
    fn concat_no_separator() {
        assert_eq!(ev("concat(\"v2-\", cookie(currency))"), "v2-thb");
    }
    #[test]
    fn eq_returns_value_or_a() {
        assert_eq!(ev("eq(request(method), \"GET\", \"yes\")"), "yes");
        assert_eq!(ev("eq(request(method), \"POST\", \"yes\")"), "");
        assert_eq!(ev("eq(cookie(currency), \"thb\")"), "thb");
    }
    #[test]
    fn lower_upper() {
        assert_eq!(ev("upper(cookie(currency))"), "THB");
        assert_eq!(ev("lower(request(host))"), "shop.example.com");
    }
    #[test]
    fn nested() {
        assert_eq!(ev("or(and(cookie(nope), cookie(currency)), \"fb\")"), "fb");
    }

    #[test]
    fn reject_uuid() {
        assert!(Expr::parse("uuid(v4)").is_err());
    }
    #[test]
    fn reject_timestamp() {
        assert!(Expr::parse("timestamp()").is_err());
    }
    #[test]
    fn reject_unknown_ident() {
        assert!(Expr::parse("frobnicate(x)").is_err());
    }
    #[test]
    fn reject_empty_or() {
        assert!(Expr::parse("or()").is_err());
    }
    #[test]
    fn reject_empty_and() {
        assert!(Expr::parse("and()").is_err());
    }
    #[test]
    fn reject_unbalanced() {
        assert!(Expr::parse("or(cookie(x)").is_err());
    }
    #[test]
    fn reject_accessor_bad_arity() {
        assert!(Expr::parse("header(a, b)").is_err());
    }
    #[test]
    fn reject_eq_bad_arity() {
        assert!(Expr::parse("eq(a)").is_err());
    }
}
