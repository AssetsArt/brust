//! M3-F D7 / C5: a store-derived slot's job key moves with the `__store` paths it reads.
use brust_jinja::ctx::Node;
use brust_server::inputs::{Projection, job_key};
use serde_json::{Value, json};

fn key(inputs: &[&str], ctx: Value) -> String {
    let inputs: Vec<String> = inputs.iter().map(|s| s.to_string()).collect();
    let p = Projection::new(&inputs).unwrap();
    job_key("c", "j0", &p.eval(&Node::from(ctx), None).unwrap())
}

const FINE: &[&str] = &["__store.cart.count", "unit"];

#[test]
fn key_moves_with_the_read_store_key() {
    let a = key(
        FINE,
        json!({"unit": "kg", "__store": {"cart": {"count": 1, "other": 0}}}),
    );
    let b = key(
        FINE,
        json!({"unit": "kg", "__store": {"cart": {"count": 2, "other": 0}}}),
    );
    assert_ne!(a, b);
}

#[test]
fn key_ignores_unread_store_keys() {
    let a = key(
        FINE,
        json!({"unit": "kg", "__store": {"cart": {"count": 1, "other": 0}}}),
    );
    let b = key(
        FINE,
        json!({"unit": "kg", "__store": {"cart": {"count": 1, "other": 9}}}),
    );
    assert_eq!(a, b);
}

#[test]
fn coarse_input_hashes_the_whole_snapshot() {
    // R3: a dotted store name falls back to the coarse `__store` input.
    let a = key(
        &["__store"],
        json!({"__store": {"cart": {"count": 1, "other": 0}}}),
    );
    let b = key(
        &["__store"],
        json!({"__store": {"cart": {"count": 1, "other": 9}}}),
    );
    assert_ne!(a, b);
}

#[test]
fn absent_snapshot_projects_null() {
    let p = Projection::new(&["__store.cart.count".to_string(), "unit".to_string()]).unwrap();
    let v = p.eval(&Node::from(json!({"unit": "kg"})), None).unwrap();
    assert_eq!(
        v,
        Node::from(json!({"unit": "kg", "__store": {"cart": {"count": null}}}))
    );
    let absent = key(FINE, json!({"unit": "kg"}));
    let zero = key(
        FINE,
        json!({"unit": "kg", "__store": {"cart": {"count": 0}}}),
    );
    assert_ne!(absent, zero);
}
