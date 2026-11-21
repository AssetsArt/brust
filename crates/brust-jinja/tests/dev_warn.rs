//! F585 (AMENDMENT 1): a `brust dev` object-like job output decodes to the same value production parses, and only the
//! two printing sinks (text `e`, attribute `attr_str`) warn, once per (component, slot, kind).
use std::sync::Mutex;

use brust_jinja::ctx::{JS_TAG, Node, decode_slot, decode_slot_of};
use serde_json::json;

static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn logger(m: &str) {
    LOG.lock().unwrap().push(m.to_string());
}

fn dev(kind: &str, image: serde_json::Value, component: &str, slot: &str) -> Node {
    let mut n = Node::from(json!({ JS_TAG: { "k": kind, "v": image } }));
    decode_slot_of(&mut n, component, slot);
    n
}

fn render(env: &minijinja::Environment<'_>, src: &str, slots: &[(&str, Node)]) -> String {
    let mut m = brust_jinja::ctx::MapInner::new();
    for (k, v) in slots {
        m.insert((*k).into(), v.clone());
    }
    env.render_str(src, Node::map(m).to_value()).unwrap()
}

fn take() -> Vec<String> {
    std::mem::take(&mut *LOG.lock().unwrap())
}

// One test: the registry and the logger are process-wide.
#[test]
fn only_printing_sinks_warn_once_and_html_is_the_production_one() {
    brust_jinja::devwarn::set_logger(logger);
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);

    // Same value as production parses: the dev node IS the JSON image.
    let user = dev("object", json!({ "name": "Ann", "n": 2 }), "C1", "_s1");
    let mut prod = Node::from(json!({ "name": "Ann", "n": 2 }));
    decode_slot(&mut prod);
    assert_eq!(user, prod);
    let when = dev("Date", json!("1970-01-01T00:00:00.000Z"), "C1", "_s2");
    assert_eq!(when, Node::from(json!("1970-01-01T00:00:00.000Z")));

    // Member reads (a primitive member printed), tests, loops, other filters: no warning.
    let src = "{{ _s1.name | e }}{{ _s1.n | attr_str }}{% if _s1 | truthy %}y{% endif %}{% for k in _s1 | keys %}{{ k }}{% endfor %}{{ _s2 | length }}{{ _s2 | truthy }}";
    let quiet = render(&env, src, &[("_s1", user.clone()), ("_s2", when.clone())]);
    assert_eq!(
        quiet,
        render(
            &env,
            src,
            &[
                ("_s1", prod.clone()),
                ("_s2", Node::from(json!("1970-01-01T00:00:00.000Z")))
            ]
        )
    );
    assert_eq!(take(), Vec::<String>::new());

    // Printing the whole value: text and attribute sinks warn; the HTML is still production's.
    let loud = render(
        &env,
        "<p title=\"{{ _s2 | attr_str }}\">{{ _s1 | e }}</p>",
        &[("_s1", user.clone()), ("_s2", when.clone())],
    );
    let same = render(
        &env,
        "<p title=\"{{ _s2 | attr_str }}\">{{ _s1 | e }}</p>",
        &[
            ("_s1", prod.clone()),
            ("_s2", Node::from(json!("1970-01-01T00:00:00.000Z"))),
        ],
    );
    assert_eq!(loud, same);
    let log = take();
    assert_eq!(log.len(), 2, "{log:?}");
    assert!(
        log.iter().any(|l| l.contains("`C1`")
            && l.contains("`_s1`")
            && l.contains("object")
            && l.contains("as text")
            && l.contains("React throws")),
        "{log:?}"
    );
    assert!(
        log.iter().any(|l| l.contains("`_s2`")
            && l.contains("Date")
            && l.contains("attribute")
            && l.contains("String(value)")),
        "{log:?}"
    );

    // Once per (component, slot, kind): a later request's fresh value does not warn again.
    let again = dev("object", json!({ "name": "Bo" }), "C1", "_s1");
    render(&env, "{{ _s1 | e }}", &[("_s1", again)]);
    assert_eq!(take(), Vec::<String>::new());
    // Another slot does.
    let other = dev("Map", json!({}), "C1", "_s3");
    render(&env, "{{ _s3 | e }}", &[("_s3", other)]);
    assert_eq!(take().len(), 1);
}
