//! Wire shapes of the two worker calls (spec §1 S1 call table), camelCase on
//! the wire. Requests are serialised to an inline JSON string; responses are
//! read as JSON from the worker's SAB slot (see `crate::dispatch`).

use std::collections::BTreeMap;

use brust_jinja::ctx::Node;
use serde::{Deserialize, Serialize};

use crate::manifest::JobKind;
use crate::routing::routes::RequestEnvelope;

/// `loader` call request: `{ routeId, params, path, req }`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderRequest<'a> {
    pub route_id: &'a str,
    pub params: BTreeMap<String, String>,
    pub path: &'a str,
    pub req: RequestEnvelope<'a>,
}

/// `loader` call response: `{ ok: true, data, headers? } | { verdict, … } | { error }`.
/// Parsed in ONE pass straight into the render tree (M3-P P2): a `#[serde(untagged)]`
/// enum buffers the whole response into serde's `Content` tree first — that was the
/// intermediate tree. Variant precedence is the untagged one: `Ok` needs `ok` AND
/// `data`; else `Verdict` needs a valid `verdict` tag (+ its required fields); else
/// `Error` needs `error`; anything else is an error. Fields are typed as the variant
/// declares (a wrong-typed field is a parse error, where untagged would have tried the
/// next variant — the worker never emits such shapes; `packages/brust/src/worker.ts`).
#[derive(Debug, Clone, PartialEq)]
pub enum LoaderResponse {
    Ok {
        ok: bool,
        data: Node,
        /// Response headers the loader set (e.g. `set-cookie`), copied onto the
        /// HTTP response; a `set-cookie` key makes the page uncacheable.
        headers: BTreeMap<String, String>,
    },
    Verdict(Verdict),
    Error {
        error: String,
    },
}

impl<'de> Deserialize<'de> for LoaderResponse {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_map(LoaderVisitor)
    }
}

struct LoaderVisitor;

impl<'de> serde::de::Visitor<'de> for LoaderVisitor {
    type Value = LoaderResponse;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a loader response object")
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut m: A) -> Result<LoaderResponse, A::Error> {
        use serde::de::Error as _;
        let (mut ok, mut data, mut headers) =
            (None::<bool>, None::<Node>, None::<BTreeMap<String, String>>);
        let (mut verdict, mut location, mut status) = (None::<String>, None::<String>, None::<u16>);
        let (mut body, mut error) = (None::<String>, None::<String>);
        while let Some(k) = m.next_key::<std::borrow::Cow<'de, str>>()? {
            match &*k {
                "ok" => ok = Some(m.next_value()?),
                "data" => data = Some(m.next_value()?),
                "headers" => headers = Some(m.next_value()?),
                "verdict" => verdict = Some(m.next_value()?),
                "location" => location = Some(m.next_value()?),
                "status" => status = Some(m.next_value()?),
                "body" => body = Some(m.next_value()?),
                "error" => error = Some(m.next_value()?),
                _ => {
                    m.next_value::<serde::de::IgnoredAny>()?;
                }
            }
        }
        if let Some(ok) = ok
            && let Some(data) = data.take()
        {
            return Ok(LoaderResponse::Ok {
                ok,
                data,
                headers: headers.unwrap_or_default(),
            });
        }
        match verdict.as_deref() {
            Some("notFound") => {
                return Ok(LoaderResponse::Verdict(Verdict::NotFound {
                    data: data.unwrap_or_default(),
                }));
            }
            Some("redirect") => {
                let location = location.ok_or_else(|| A::Error::missing_field("location"))?;
                return Ok(LoaderResponse::Verdict(Verdict::Redirect {
                    location,
                    status: status.unwrap_or(302),
                }));
            }
            Some("httpError") => {
                let status = status.ok_or_else(|| A::Error::missing_field("status"))?;
                return Ok(LoaderResponse::Verdict(Verdict::HttpError {
                    status,
                    body: body.unwrap_or_default(),
                }));
            }
            Some(other) => {
                return Err(A::Error::unknown_variant(
                    other,
                    &["notFound", "redirect", "httpError"],
                ));
            }
            None => {}
        }
        match error {
            Some(error) => Ok(LoaderResponse::Error { error }),
            None => Err(A::Error::custom(
                "loader response is none of ok/data, verdict, error",
            )),
        }
    }
}

fn d302() -> u16 {
    302
}

/// A loader's non-`ok` outcome.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "verdict", rename_all = "camelCase")]
pub enum Verdict {
    NotFound {
        #[serde(default)]
        data: Node,
    },
    Redirect {
        location: String,
        #[serde(default = "d302")]
        status: u16,
    },
    HttpError {
        status: u16,
        #[serde(default)]
        body: String,
    },
}

/// `jobs` call request: `{ jobs: [{ id, componentId, kind, inputs }] }`. Borrows
/// the plans it is built from (M3-P P1): `inputs` is serialised in place, never
/// cloned per miss.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsRequest<'a> {
    pub jobs: Vec<JobCall<'a>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCall<'a> {
    /// Chain job `"<componentId>/<jobId>"`; child instance job
    /// `"<parentId>/<childId>_<k>/<jobId>[/<row>]"`. Unique per request; the
    /// worker treats it as opaque and echoes it in its result.
    pub id: String,
    pub component_id: &'a str,
    pub kind: JobKind,
    pub inputs: &'a Node,
    /// `ssr`: the react component to render (`jobs[target].ssr(inputs)`),
    /// copied from the manifest job record; absent when the record has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<&'a str>,
    /// `per_instance` jobs: the 0-based row of the list this call renders.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row: Option<usize>,
}

/// `jobs` call response: `{ results: [{ id, value | error }] }`.
#[derive(Debug, Clone, Deserialize)]
pub struct JobsResponse {
    pub results: Vec<JobResult>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JobResult {
    pub id: String,
    #[serde(default)]
    pub value: Option<Node>,
    #[serde(default)]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn loader(v: Value) -> LoaderResponse {
        serde_json::from_value(v).expect("LoaderResponse")
    }

    #[test]
    fn loader_ok_with_data_and_default_headers() {
        assert_eq!(
            loader(json!({"ok": true, "data": {"x": 1}})),
            LoaderResponse::Ok {
                ok: true,
                data: Node::from(json!({"x": 1})),
                headers: BTreeMap::new()
            }
        );
    }

    #[test]
    fn loader_ok_carries_headers() {
        let r = loader(json!({"ok": true, "data": {}, "headers": {"set-cookie": "a=1"}}));
        let LoaderResponse::Ok { headers, .. } = r else {
            panic!("expected Ok, got {r:?}")
        };
        assert_eq!(headers.get("set-cookie").map(String::as_str), Some("a=1"));
    }

    #[test]
    fn loader_not_found_verdict_with_and_without_data() {
        assert_eq!(
            loader(json!({"verdict": "notFound", "data": {"a": 1}})),
            LoaderResponse::Verdict(Verdict::NotFound {
                data: Node::from(json!({"a": 1}))
            })
        );
        assert_eq!(
            loader(json!({"verdict": "notFound"})),
            LoaderResponse::Verdict(Verdict::NotFound { data: Node::Null })
        );
    }

    #[test]
    fn loader_redirect_defaults_to_302() {
        assert_eq!(
            loader(json!({"verdict": "redirect", "location": "/x"})),
            LoaderResponse::Verdict(Verdict::Redirect {
                location: "/x".into(),
                status: 302
            })
        );
        assert_eq!(
            loader(json!({"verdict": "redirect", "location": "/x", "status": 301})),
            LoaderResponse::Verdict(Verdict::Redirect {
                location: "/x".into(),
                status: 301
            })
        );
    }

    #[test]
    fn loader_http_error_verdict() {
        assert_eq!(
            loader(json!({"verdict": "httpError", "status": 418, "body": "teapot"})),
            LoaderResponse::Verdict(Verdict::HttpError {
                status: 418,
                body: "teapot".into()
            })
        );
        assert_eq!(
            loader(json!({"verdict": "httpError", "status": 500})),
            LoaderResponse::Verdict(Verdict::HttpError {
                status: 500,
                body: String::new()
            })
        );
    }

    #[test]
    fn loader_error_variant() {
        assert_eq!(
            loader(json!({"error": "boom"})),
            LoaderResponse::Error {
                error: "boom".into()
            }
        );
    }

    #[test]
    fn loader_rejects_unknown_shapes() {
        for bad in [
            json!({"ok": true}),
            json!({"verdict": "teapot"}),
            json!({"verdict": "redirect"}),
            json!({}),
        ] {
            assert!(
                serde_json::from_value::<LoaderResponse>(bad.clone()).is_err(),
                "{bad} must not deserialize"
            );
        }
    }

    #[test]
    fn jobs_request_is_camel_case() {
        let inputs = Node::from(json!({"move": {"name": "growl"}}));
        let r = JobsRequest {
            jobs: vec![JobCall {
                id: "moveCard_d4/j0/1".into(),
                component_id: "moveCard_d4",
                kind: JobKind::Precompute,
                inputs: &inputs,
                target: None,
                row: None,
            }],
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({"jobs": [{"id": "moveCard_d4/j0/1", "componentId": "moveCard_d4", "kind": "precompute", "inputs": {"move": {"name": "growl"}}}]})
        );
        let inputs = Node::from(json!({"productId": "p2"}));
        let r = JobsRequest {
            jobs: vec![JobCall {
                id: "rowReact_6/j0/1".into(),
                component_id: "rowReact_6",
                kind: JobKind::Ssr,
                inputs: &inputs,
                target: Some("reviews_7"),
                row: Some(1),
            }],
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({"jobs": [{"id": "rowReact_6/j0/1", "componentId": "rowReact_6", "kind": "ssr", "inputs": {"productId": "p2"}, "target": "reviews_7", "row": 1}]})
        );
    }

    #[test]
    fn jobs_response_value_or_error() {
        let r: JobsResponse = serde_json::from_value(json!({"results": [
            {"id": "a/j0", "value": {"_s1": "x"}},
            {"id": "b/j0", "error": "bad"}
        ]}))
        .unwrap();
        assert_eq!(r.results[0].value, Some(Node::from(json!({"_s1": "x"}))));
        assert_eq!(r.results[0].error, None);
        assert_eq!(r.results[1].value, None);
        assert_eq!(r.results[1].error.as_deref(), Some("bad"));
    }
}
