//! Wire shapes of the two worker calls (spec §1 S1 call table), camelCase on
//! the wire. Requests are serialised to an inline JSON string; responses are
//! read as JSON from the worker's SAB slot (see `crate::dispatch`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
/// Untagged: variants are tried in order, and `Ok` needs both `ok` and `data`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum LoaderResponse {
    Ok {
        ok: bool,
        data: Value,
        /// Response headers the loader set (e.g. `set-cookie`), copied onto the
        /// HTTP response; a `set-cookie` key makes the page uncacheable.
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
    Verdict(Verdict),
    Error {
        error: String,
    },
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
        data: Value,
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

/// `jobs` call request: `{ jobs: [{ id, componentId, kind, inputs }] }`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsRequest {
    pub jobs: Vec<JobCall>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCall {
    /// Chain job `"<componentId>/<jobId>"`; child instance job
    /// `"<parentId>/<childId>_<k>/<jobId>[/<row>]"`. Unique per request; the
    /// worker treats it as opaque and echoes it in its result.
    pub id: String,
    pub component_id: String,
    pub kind: JobKind,
    pub inputs: Value,
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
    pub value: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn loader(v: Value) -> LoaderResponse {
        serde_json::from_value(v).expect("LoaderResponse")
    }

    #[test]
    fn loader_ok_with_data_and_default_headers() {
        assert_eq!(
            loader(json!({"ok": true, "data": {"x": 1}})),
            LoaderResponse::Ok {
                ok: true,
                data: json!({"x": 1}),
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
                data: json!({"a": 1})
            })
        );
        assert_eq!(
            loader(json!({"verdict": "notFound"})),
            LoaderResponse::Verdict(Verdict::NotFound { data: Value::Null })
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
        let r = JobsRequest {
            jobs: vec![JobCall {
                id: "moveCard_d4/j0/1".into(),
                component_id: "moveCard_d4".into(),
                kind: JobKind::Precompute,
                inputs: json!({"move": {"name": "growl"}}),
            }],
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({"jobs": [{"id": "moveCard_d4/j0/1", "componentId": "moveCard_d4", "kind": "precompute", "inputs": {"move": {"name": "growl"}}}]})
        );
    }

    #[test]
    fn jobs_response_value_or_error() {
        let r: JobsResponse = serde_json::from_value(json!({"results": [
            {"id": "a/j0", "value": {"_s1": "x"}},
            {"id": "b/j0", "error": "bad"}
        ]}))
        .unwrap();
        assert_eq!(r.results[0].value, Some(json!({"_s1": "x"})));
        assert_eq!(r.results[0].error, None);
        assert_eq!(r.results[1].value, None);
        assert_eq!(r.results[1].error.as_deref(), Some("bad"));
    }
}
