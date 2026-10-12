//! Wire shapes of the two worker calls (spec §1 S1 call table), camelCase on
//! the wire. Requests are serialised to an inline JSON string; responses are
//! read as JSON from the worker's SAB slot (see `crate::dispatch`).

use std::borrow::Cow;
use std::collections::BTreeMap;

use brust_jinja::ctx::Node;
use serde::{Deserialize, Serialize};

use crate::manifest::JobKind;
use crate::routing::routes::RequestEnvelope;

/// `loader` call request: `{ routeId, params, path, req, plan? }`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderRequest<'a> {
    pub route_id: &'a str,
    pub params: BTreeMap<String, String>,
    pub path: &'a str,
    pub req: RequestEnvelope<'a>,
    /// M3-P P6: the chain has jobs — the worker may plan them inside this call
    /// (`planJobs`) and answer `{ planned, results }`; it may also ignore this.
    /// Serialised only when true.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub plan: bool,
}

/// `loader` call response: `{ planned: true, results? } | { ok: true, data, headers? } |
/// { verdict, … } | { error }`.
/// Parsed in ONE pass straight into the render tree (M3-P P2): a `#[serde(untagged)]`
/// enum buffers the whole response into serde's `Content` tree first — that was the
/// intermediate tree. Variant precedence: `Planned` needs `planned: true`; else `Ok`
/// needs `ok` AND `data`; else `Verdict` needs a valid `verdict` tag (+ its required fields); else
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
        /// M3-F C2: the request's store snapshot (C1: `{ name: { key: Json } }`). `None` when the
        /// worker sent no `store` or `null` (R1: absent ≡ null).
        store: Option<Node>,
    },
    /// The worker took the plan offer: the loader data went to `plan_in_call` (it is
    /// in the slot's plan cell), `results` answer the misses `planJobs` returned
    /// (empty when every job hit).
    Planned {
        results: Vec<JobResult>,
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
        let (mut planned, mut results) = (None::<bool>, None::<Vec<JobResult>>);
        let mut store = None::<Node>;
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
                "planned" => planned = Some(m.next_value()?),
                "results" => results = Some(m.next_value()?),
                "store" => store = m.next_value::<Option<Node>>()?,
                _ => {
                    m.next_value::<serde::de::IgnoredAny>()?;
                }
            }
        }
        if planned == Some(true) {
            return Ok(LoaderResponse::Planned {
                results: results.unwrap_or_default(),
            });
        }
        if let Some(ok) = ok
            && let Some(data) = data.take()
        {
            return Ok(LoaderResponse::Ok {
                ok,
                data,
                headers: headers.unwrap_or_default(),
                store,
            });
        }
        match verdict.as_deref() {
            Some("notFound") => {
                return Ok(LoaderResponse::Verdict(Verdict::NotFound {
                    data: data.unwrap_or_default(),
                    store,
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
        #[serde(default)]
        store: Option<Node>,
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

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct JobResult {
    pub id: String,
    #[serde(default)]
    pub value: Option<Node>,
    #[serde(default)]
    pub error: Option<String>,
}

/// A1 `fetch` request: `{ method, url, headers: [[k,v]…], body: {text}|{b64}|null, req }`. `headers`
/// are PAIRS (repeated names survive; `req.headers` is an object and collapses them — F5). `url` =
/// path + query as received.
#[derive(Serialize)]
pub struct FetchRequest<'a> {
    pub method: &'a str,
    pub url: &'a str,
    pub headers: Vec<(Cow<'a, str>, Cow<'a, str>)>,
    pub body: Option<FetchBody>,
    pub req: RequestEnvelope<'a>,
}

/// A1 body (R2), externally tagged: `{"text": …}` / `{"b64": …}`.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FetchBody {
    Text(String),
    B64(String),
    /// F82: more than the inline threshold; the bytes cross by heap transfer (`takeFetchBody`).
    Heap(usize),
}

/// A2 meta `{ status, headers: [[k,v]…] }`; unknown keys ignored.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct FetchMeta {
    pub status: u16,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// F82: the body is `heap` bytes long and was put by `putFetchReply`, not framed.
    #[serde(default)]
    pub heap: Option<u64>,
}

/// A decoded `fetch` answer; `body` was copied out of the slot while the claim was held.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: bytes::Bytes,
}

/// A `cache` worker call (the cache adapter's `store.get`/`store.set`), inline JSON like every
/// request. A `set` body always waits in the call's cell for `takeFetchBody` (`heap` = its length).
#[derive(Debug, Serialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum CacheRequest<'a> {
    Get {
        key: &'a str,
    },
    Set {
        key: &'a str,
        status: u16,
        headers: &'a [(String, String)],
        meta: CacheSetMeta<'a>,
        heap: usize,
    },
}

/// `store.set`'s `SetMeta` on the wire (camelCase, `stamp: null` = unguarded).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheSetMeta<'a> {
    pub ttl_ms: u64,
    pub tags: &'a [String],
    pub method: &'a str,
    pub path: &'a str,
    pub stamp: Option<u64>,
}

/// A `cache` call's A2 meta: `get` → `{hit, status?, headers?, stamp, entryStamp?, storedAt?, heap?}`;
/// `set` → `{ok}`; any failure → `{error}`. Unknown keys ignored.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheReplyMeta {
    #[serde(default)]
    pub hit: Option<bool>,
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub stamp: Option<u64>,
    #[serde(default)]
    pub entry_stamp: Option<u64>,
    #[serde(default)]
    pub stored_at: Option<u64>,
    #[serde(default)]
    pub heap: Option<u64>,
    #[serde(default)]
    pub ok: Option<bool>,
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
                headers: BTreeMap::new(),
                store: None
            }
        );
    }

    #[test]
    fn loader_ok_carries_store_and_absent_or_null_is_none() {
        assert_eq!(
            loader(json!({"ok": true, "data": {}, "store": {"cart": {"count": 1}}})),
            LoaderResponse::Ok {
                ok: true,
                data: Node::from(json!({})),
                headers: BTreeMap::new(),
                store: Some(Node::from(json!({"cart": {"count": 1}})))
            }
        );
        for v in [
            json!({"ok": true, "data": {}}),
            json!({"ok": true, "data": {}, "store": null}),
        ] {
            let r = loader(v);
            let LoaderResponse::Ok { store, .. } = r else {
                panic!("expected Ok, got {r:?}")
            };
            assert_eq!(store, None);
        }
    }

    #[test]
    fn not_found_carries_store() {
        assert_eq!(
            loader(json!({"verdict": "notFound", "data": {"a": 1}, "store": {"s": {"k": 2}}})),
            LoaderResponse::Verdict(Verdict::NotFound {
                data: Node::from(json!({"a": 1})),
                store: Some(Node::from(json!({"s": {"k": 2}})))
            })
        );
        assert_eq!(
            loader(json!({"verdict": "notFound", "data": {"a": 1}})),
            LoaderResponse::Verdict(Verdict::NotFound {
                data: Node::from(json!({"a": 1})),
                store: None
            })
        );
    }

    #[test]
    fn planned_ignores_store() {
        assert_eq!(
            loader(json!({"planned": true, "store": {"s": {}}})),
            LoaderResponse::Planned { results: vec![] }
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
                data: Node::from(json!({"a": 1})),
                store: None
            })
        );
        assert_eq!(
            loader(json!({"verdict": "notFound"})),
            LoaderResponse::Verdict(Verdict::NotFound {
                data: Node::Null,
                store: None
            })
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

    #[test]
    fn plan_offer_is_omitted_when_false() {
        let env = || RequestEnvelope {
            method: "GET",
            url: "/",
            headers: vec![],
            cookies: vec![],
            search: vec![],
        };
        let mut r = LoaderRequest {
            route_id: "r2",
            params: BTreeMap::new(),
            path: "/",
            req: env(),
            plan: false,
        };
        assert!(!serde_json::to_string(&r).unwrap().contains("plan"));
        r.plan = true;
        assert!(
            serde_json::to_string(&r)
                .unwrap()
                .contains(r#""plan":true"#)
        );
    }

    #[test]
    fn planned_response_parses_with_and_without_results() {
        assert_eq!(
            loader(json!({"planned": true})),
            LoaderResponse::Planned { results: vec![] }
        );
        let LoaderResponse::Planned { results } =
            loader(json!({"planned": true, "results": [{"id": "c/j0", "value": {"_s1": 1}}]}))
        else {
            panic!()
        };
        assert_eq!((results.len(), results[0].id.as_str()), (1, "c/j0"));
    }

    #[test]
    fn planned_wins_over_every_other_shape_and_false_is_ignored() {
        assert!(matches!(
            loader(json!({"planned": true, "ok": true, "data": {}})),
            LoaderResponse::Planned { .. }
        ));
        assert!(matches!(
            loader(json!({"planned": false, "ok": true, "data": {}})),
            LoaderResponse::Ok { .. }
        ));
    }

    fn fetch_req(body: Option<FetchBody>) -> FetchRequest<'static> {
        FetchRequest {
            method: "POST",
            url: "/_brust/action/team?x=1",
            headers: vec![
                ("content-type".into(), "application/json".into()),
                ("set-cookie".into(), "a=1".into()),
                ("set-cookie".into(), "b=2".into()),
            ],
            body,
            req: RequestEnvelope {
                method: "POST",
                url: "/_brust/action/team?x=1",
                headers: vec![("content-type".into(), "application/json".into())],
                cookies: vec![],
                search: vec![("x".into(), "1".into())],
            },
        }
    }

    #[test]
    fn fetch_request_json_is_pinned() {
        // A1, verbatim: headers are PAIRS (both set-cookie survive), body externally tagged.
        assert_eq!(
            serde_json::to_string(&fetch_req(Some(FetchBody::Text(r#"{"id":1}"#.into())))).unwrap(),
            r#"{"method":"POST","url":"/_brust/action/team?x=1","headers":[["content-type","application/json"],["set-cookie","a=1"],["set-cookie","b=2"]],"body":{"text":"{\"id\":1}"},"req":{"method":"POST","url":"/_brust/action/team?x=1","headers":{"content-type":"application/json"},"cookies":{},"search":{"x":"1"}}}"#
        );
        let b64 = serde_json::to_string(&fetch_req(Some(FetchBody::B64("AAE=".into())))).unwrap();
        assert!(b64.contains(r#""body":{"b64":"AAE="}"#), "{b64}");
        let heap = serde_json::to_string(&fetch_req(Some(FetchBody::Heap(262_145)))).unwrap();
        assert!(heap.contains(r#""body":{"heap":262145}"#), "{heap}");
        let none = serde_json::to_string(&fetch_req(None)).unwrap();
        assert!(none.contains(r#""body":null"#), "{none}");
    }

    #[test]
    fn fetch_meta_reads_pairs() {
        let m: FetchMeta = serde_json::from_str(
            r#"{"status":201,"headers":[["set-cookie","a=1"],["set-cookie","b=2"]],"extra":1}"#,
        )
        .unwrap();
        assert_eq!(
            m,
            FetchMeta {
                status: 201,
                headers: vec![
                    ("set-cookie".into(), "a=1".into()),
                    ("set-cookie".into(), "b=2".into())
                ],
                heap: None,
            }
        );
        let m: FetchMeta = serde_json::from_str(r#"{"status":204}"#).unwrap();
        assert!(m.headers.is_empty());
        assert_eq!(m.heap, None);
        let m: FetchMeta = serde_json::from_str(r#"{"status":200,"heap":5}"#).unwrap();
        assert_eq!(m.heap, Some(5));
    }
}
