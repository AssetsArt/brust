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
