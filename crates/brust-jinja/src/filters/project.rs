//! `rows | project("id", "tags.name")` (compiler ledger F71): of every object, only the listed paths.
//!
//! An array is mapped element-wise at every level; anything else (strings, numbers, none,
//! undefined) passes through unchanged, and a listed path that is absent is simply absent.
//! A path that is itself listed whole (`"tags"`) wins over a longer one under it (`"tags.name"`).
//! Keys come out sorted, as `json_attr` prints a loader object today.
use minijinja::value::{Rest, Value, ValueKind};
use std::collections::BTreeMap;

#[derive(Default)]
struct Node {
    /// The path ends here: keep the value as it is.
    whole: bool,
    children: BTreeMap<String, Node>,
}

pub fn project(v: Value, paths: Rest<String>) -> Value {
    let mut root = Node::default();
    for p in paths.iter() {
        let mut n = &mut root;
        for seg in p.split('.') {
            n = n.children.entry(seg.to_string()).or_default();
        }
        n.whole = true;
    }
    if root.children.is_empty() {
        return v;
    }
    project_value(&v, &root)
}

fn project_value(v: &Value, node: &Node) -> Value {
    if node.whole {
        return v.clone();
    }
    match v.kind() {
        ValueKind::Seq => match v.try_iter() {
            Ok(it) => it.map(|x| project_value(&x, node)).collect::<Value>(),
            Err(_) => v.clone(),
        },
        ValueKind::Map => Value::from_pairs(node.children.iter().filter_map(|(k, child)| {
            let x = v
                .get_item(&Value::from(k.as_str()))
                .unwrap_or(Value::UNDEFINED);
            (!x.is_undefined()).then(|| (k.clone(), project_value(&x, child)))
        })),
        _ => v.clone(),
    }
}

#[cfg(test)]
mod tests {
    use minijinja::Environment;
    use minijinja::value::Value;

    fn render(src: &str, ctx: Value) -> String {
        let mut env = Environment::new();
        crate::register(&mut env);
        env.render_str(src, ctx).unwrap()
    }
    fn ctx() -> Value {
        crate::value_of(&serde_json::json!({ "rows": [
            { "id": 1, "name": "x", "secret": "s", "badges": [{ "type": "a", "color": "c", "hidden": 1 }] },
            { "id": 2, "name": "y", "badges": [] }, 7, null ] }))
    }

    #[test]
    fn keeps_listed_paths_elementwise() {
        assert_eq!(
            render(
                r#"{{ rows | project("id", "badges.type") | json_attr }}"#,
                ctx()
            ),
            r#"[{&quot;badges&quot;:[{&quot;type&quot;:&quot;a&quot;}],&quot;id&quot;:1},{&quot;badges&quot;:[],&quot;id&quot;:2},7,null]"#
        );
    }

    #[test]
    fn a_whole_entry_wins_over_a_longer_path_under_it() {
        assert_eq!(
            render(
                r#"{{ rows | project("badges", "badges.type") | json_attr }}"#,
                ctx()
            ),
            r#"[{&quot;badges&quot;:[{&quot;color&quot;:&quot;c&quot;,&quot;hidden&quot;:1,&quot;type&quot;:&quot;a&quot;}]},{&quot;badges&quot;:[]},7,null]"#
        );
    }

    #[test]
    fn non_objects_and_missing_values_pass_through() {
        assert_eq!(render(r#"{{ "str" | project("id") }}"#, ctx()), "str");
        assert_eq!(
            render(r#"{{ missing | project("id") | json_attr }}"#, ctx()),
            render(r#"{{ missing | json_attr }}"#, ctx())
        );
        // No paths: nothing to project, the value is untouched.
        assert_eq!(
            render(r#"{{ rows | project() | json_attr }}"#, ctx()),
            render(r#"{{ rows | json_attr }}"#, ctx())
        );
    }
}
