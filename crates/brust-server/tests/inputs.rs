use brust_jinja::ctx::Node;
use brust_server::inputs::{Path, canonical, child_props, job_key, project};
use serde_json::{Value, json};

fn n(v: Value) -> Node {
    Node::from(v)
}

#[test]
fn path_reads_dotted_and_indexed() {
    let c = n(json!({"a":{"b":[{"n":1},{"n":2}]}}));
    assert_eq!(Path::parse("a.b[1].n").unwrap().get(&c, None), &n(json!(2)));
    assert_eq!(
        Path::parse("props.a.b[idx].n").unwrap().get(&c, Some(0)),
        &n(json!(1))
    );
    assert_eq!(Path::parse("a.zz").unwrap().get(&c, None), &Node::Null);
}

#[test]
fn project_materialises_only_read_paths() {
    let c = n(json!({"item":{"id":"p1","name":"Mug","price":3}}));
    assert_eq!(
        project(&c, &["item.price".into()], None).unwrap(),
        n(json!({"item":{"price":3}}))
    );
}

#[test]
fn null_and_empty_object_hash_differently() {
    let a = job_key("c", "j", &n(json!({"user":null})));
    let b = job_key("c", "j", &n(json!({"user":{}})));
    assert_ne!(a, b);
    assert_eq!(a.len(), 64);
}

#[test]
fn key_is_independent_of_object_key_order() {
    let a: Node = serde_json::from_str(r#"{"b":1,"a":{"y":2,"x":1}}"#).unwrap();
    let b: Node = serde_json::from_str(r#"{"a":{"x":1,"y":2},"b":1}"#).unwrap();
    assert_eq!(canonical(&a), canonical(&b));
    assert_eq!(job_key("c", "j", &a), job_key("c", "j", &b));
}

#[test]
fn per_row_key_depends_on_row_content_not_position() {
    let c = n(json!({"moves":[{"name":"tackle"},{"name":"growl"},{"name":"tackle"}]}));
    let props = [("move".to_string(), "moves[idx]".to_string())]
        .into_iter()
        .collect();
    let k = |i| {
        job_key(
            "moveCard_d4",
            "j0",
            &project(
                &child_props(&c, &props, Some(i)).unwrap(),
                &["move.name".into()],
                None,
            )
            .unwrap(),
        )
    };
    assert_eq!(k(0), k(2));
    assert_ne!(k(0), k(1));
}

#[test]
fn component_and_job_ids_are_length_prefixed() {
    assert_ne!(
        job_key("a", "bc", &n(json!(1))),
        job_key("ab", "c", &n(json!(1)))
    );
}

/// Guards against a future `preserve_order` feature unification on serde_json:
/// canonical bytes must have sorted keys and no whitespace.
#[test]
fn canonical_sorts_keys_without_whitespace() {
    assert_eq!(canonical(&n(json!({"b":1,"a":2}))), b"{\"a\":2,\"b\":1}");
}

/// The 20 `(cid, jid, inputs)` cases of `job_keys_are_pinned`.
fn job_key_cases() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        ("typeBadge_5f5390d7", "j0", json!({"type": "fire"})),
        ("a", "bc", json!(null)),
        ("ab", "c", json!(null)),
        ("", "", json!({})),
        ("c", "j0#3", json!({"row": 3})),
        ("c", "j0", json!([1, "é", {"z": 1, "a": [true]}])),
        (
            "detailPage_c3",
            "j0",
            json!({"pokemon": {"stats": {"hp": 35}}}),
        ),
        ("moveCard_d4", "j0", json!({"move": {"name": "tackle"}})),
        ("teamPage_g7", "j0", json!({"team": ["a"]})),
        (
            "teamBuilder_h8",
            "ssr",
            json!({"team": ["a", "b"], "who": "anon"}),
        ),
        ("n", "j0", json!({"active": true})),
        ("n", "j0", json!({"active": false})),
        ("x", "j1", json!({"big": 18446744073709551615u64})),
        (
            "x",
            "j1",
            json!({"neg": -7, "f": 1.5, "e": 1e21, "t": 1e-7}),
        ),
        ("x", "j1", json!({"u": "ピカチュウ", "esc": "a\"b\\c\n"})),
        ("x", "j1", json!({"b": {"a": 1}, "a": {"b": 2}})),
        ("x", "j1", json!({"[idx]": {"n": 7}})),
        ("x", "j1", json!({"a": {"[0]": {"n": 1}, "[1]": {"n": 2}}})),
        (
            "counter_4a7ef039",
            "j0",
            json!({"label": "clicks", "start": 0}),
        ),
        (
            "counter_4a7ef039",
            "j0",
            json!({"label": "clicks", "start": 1234567}),
        ),
    ]
}

/// 20 job keys pinned at 42db1d1: a change of `job_key`'s bytes (field layout, canonical JSON,
/// number text, key order, hash) fails here before it reaches a cache. Regenerate ONLY with a
/// spec amendment: `BRUST_WRITE_JOB_KEYS=1 cargo test -p brust-server --test inputs job_keys_are_pinned`.
#[test]
fn job_keys_are_pinned() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/job-keys-20.json"
    );
    let cases = job_key_cases();
    if std::env::var_os("BRUST_WRITE_JOB_KEYS").is_some() {
        let rows: Vec<Value> = cases
            .iter()
            .map(|(cid, jid, inputs)| {
                let key = job_key(cid, jid, &n(inputs.clone()));
                json!({"cid": cid, "jid": jid, "inputs": inputs, "key": key})
            })
            .collect();
        let text = serde_json::to_string_pretty(&rows).unwrap() + "\n";
        std::fs::write(path, text).unwrap();
    }
    let rows: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(path).expect("job-keys-20.json")).unwrap();
    assert_eq!(rows.len(), 20);
    for (row, (cid, jid, inputs)) in rows.iter().zip(&cases) {
        assert_eq!(
            (row["cid"].as_str(), row["jid"].as_str()),
            (Some(*cid), Some(*jid))
        );
        assert_eq!(
            &row["inputs"], inputs,
            "{cid}/{jid}: fixture inputs drifted from CASES"
        );
        let key = job_key(cid, jid, &n(row["inputs"].clone()));
        assert_eq!(
            Some(key.as_str()),
            row["key"].as_str(),
            "{cid}/{jid} {inputs}"
        );
    }
}
