use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Head,
}

impl Method {
    pub fn from_http(s: &str) -> Option<Self> {
        match s {
            "GET" => Some(Self::Get),
            "POST" => Some(Self::Post),
            "PUT" => Some(Self::Put),
            "PATCH" => Some(Self::Patch),
            "DELETE" => Some(Self::Delete),
            "HEAD" => Some(Self::Head),
            _ => None,
        }
    }

    fn index(self) -> usize {
        match self {
            Self::Get => 0,
            Self::Post => 1,
            Self::Put => 2,
            Self::Patch => 3,
            Self::Delete => 4,
            Self::Head => 5,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum MatchOutcome {
    Found {
        endpoint_id: u32,
        params: Vec<(String, String)>,
    },
    MethodNotAllowed,
    NotFound,
}

#[derive(Debug)]
pub enum InsertError {
    Duplicate { method: &'static str, path: String },
    Matchit { path: String, reason: String },
}

impl fmt::Display for InsertError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Duplicate { method, path } => {
                write!(f, "duplicate route: {method} {path}")
            }
            Self::Matchit { path, reason } => {
                write!(f, "matchit insert error for path {path}: {reason}")
            }
        }
    }
}

impl std::error::Error for InsertError {}

#[derive(Default)]
pub struct ActionRouter {
    inner: matchit::Router<usize>,
    tables: Vec<[Option<u32>; 6]>,
    patterns: Vec<String>,
}

impl ActionRouter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(
        &mut self,
        method: Method,
        path: &str,
        endpoint_id: u32,
    ) -> Result<(), InsertError> {
        // Find or create the table index for this path pattern.
        let idx = if let Some(pos) = self.patterns.iter().position(|p| p == path) {
            pos
        } else {
            let idx = self.tables.len();
            self.tables.push([None; 6]);
            self.patterns.push(path.to_string());
            if let Err(e) = self.inner.insert(path, idx) {
                // Roll back the pushes.
                self.tables.pop();
                self.patterns.pop();
                return Err(InsertError::Matchit {
                    path: path.to_string(),
                    reason: e.to_string(),
                });
            }
            idx
        };

        let slot = &mut self.tables[idx][method.index()];
        if slot.is_some() {
            let method_str: &'static str = match method {
                Method::Get => "GET",
                Method::Post => "POST",
                Method::Put => "PUT",
                Method::Patch => "PATCH",
                Method::Delete => "DELETE",
                Method::Head => "HEAD",
            };
            return Err(InsertError::Duplicate {
                method: method_str,
                path: path.to_string(),
            });
        }
        *slot = Some(endpoint_id);
        Ok(())
    }

    pub fn at(&self, method: Method, path: &str) -> MatchOutcome {
        match self.inner.at(path) {
            Err(_) => MatchOutcome::NotFound,
            Ok(m) => {
                let table = &self.tables[*m.value];
                match table[method.index()] {
                    Some(endpoint_id) => MatchOutcome::Found {
                        endpoint_id,
                        params: m
                            .params
                            .iter()
                            .map(|(k, v)| (k.to_string(), v.to_string()))
                            .collect(),
                    },
                    None => MatchOutcome::MethodNotAllowed,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn router() -> ActionRouter {
        let mut r = ActionRouter::new();
        r.insert(Method::Get, "/notes/{id}", 0).unwrap();
        r.insert(Method::Delete, "/notes/{id}", 1).unwrap();
        r.insert(Method::Post, "/notes", 2).unwrap();
        r
    }
    #[test]
    fn matches_method_and_extracts_params() {
        let r = router();
        match r.at(Method::Get, "/notes/abc") {
            MatchOutcome::Found {
                endpoint_id,
                params,
            } => {
                assert_eq!(endpoint_id, 0);
                assert_eq!(params, vec![("id".to_string(), "abc".to_string())]);
            }
            other => panic!("expected Found, got {other:?}"),
        }
    }
    #[test]
    fn unknown_path_is_not_found() {
        assert!(matches!(
            router().at(Method::Get, "/nope"),
            MatchOutcome::NotFound
        ));
    }
    #[test]
    fn known_path_wrong_method_is_method_not_allowed() {
        assert!(matches!(
            router().at(Method::Put, "/notes/xyz"),
            MatchOutcome::MethodNotAllowed
        ));
    }
    #[test]
    fn duplicate_method_path_errors() {
        let mut r = router();
        assert!(r.insert(Method::Get, "/notes/{id}", 9).is_err());
    }
    #[test]
    fn method_from_str_roundtrip() {
        assert_eq!(Method::from_http("GET"), Some(Method::Get));
        assert_eq!(Method::from_http("delete"), None);
        assert_eq!(Method::from_http("PATCH"), Some(Method::Patch));
    }
}
