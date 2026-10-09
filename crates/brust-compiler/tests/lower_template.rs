//! M1c Tasks 3–4: the template backend — structure, directives, host
//! attributes, child inlining. Review Focus 1, 2, 4, 5 (3 with the escaper).
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Lowers `src` as a module next to the parent-counter fixture (so
/// `./Counter` resolves); returns (jinja, client chunk).
fn lower(src: &str) -> (String, String) {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            "tests/fixtures/parent-counter/T.tsx",
            Some(s.into_bytes()),
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        let a = &tree[0].artifacts;
        (a.jinja.clone(), a.client_js.clone().unwrap_or_default())
    })
}

fn render(jinja: &str, ctx: serde_json::Value) -> String {
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    env.render_str(jinja, minijinja::Value::from_serialize(ctx))
        .unwrap()
}

const STATE: &str = "import { useState } from 'react'\n";

/// Review Focus 1: a reactive slot with siblings is wrapped; a lone one puts
/// x-text on its parent.
#[test]
fn state_slots_with_and_without_siblings() {
    let (j, _) = lower(&format!(
        "{STATE}export default function T() {{ const [n, setN] = useState(1); return <div onClick={{() => setN(n + 1)}}><p>Total: {{n}}</p><b>{{n}}</b></div> }}"
    ));
    assert!(
        j.contains("<p>Total: <span x-text=\"_c1\">{{ n | e }}</span></p>"),
        "{j}"
    );
    assert!(j.contains("<b x-text=\"_c2\">{{ n | e }}</b>"), "{j}");
}

/// Review Focus 2: an x-if branch that is not one element gets a wrapper.
#[test]
fn if_branches_that_are_not_one_element_are_wrapped() {
    let (j, _) = lower(&format!(
        "{STATE}export default function T() {{ const [open, setOpen] = useState(false); return <div onClick={{() => setOpen(!open)}}>{{open && <>a<b/></>}}</div> }}"
    ));
    assert!(
        j.contains("{% if open %}<brust-if style=\"display:contents\" x-if=\"_c1\">a<b></b></brust-if>{% else %}<!--x-if--><brust-if style=\"display:contents\" x-if=\"_c1\" hidden>a<b></b></brust-if>{% endif %}"),
        "{j}"
    );
    // Renders as valid jinja either way.
    assert!(render(&j, serde_json::json!({})).contains("hidden"));
}

/// Review Focus 4: a boolean attribute renders present/absent.
#[test]
fn boolean_attribute_from_a_server_expression() {
    let (j, _) = lower(
        "export default function T({ ok }: any) { return <button disabled={!ok}>x</button> }",
    );
    assert!(j.contains("{% if (not ok) %} disabled{% endif %}"), "{j}");
    assert!(!j.contains("disabled=\""), "{j}");
    assert_eq!(
        render(&j, serde_json::json!({ "ok": false }))
            .lines()
            .last()
            .unwrap(),
        "<button disabled>x</button>"
    );
    assert_eq!(
        render(&j, serde_json::json!({ "ok": true }))
            .lines()
            .last()
            .unwrap(),
        "<button>x</button>"
    );
}

/// Review Focus 5: two instances of one native child: two hosts of the same
/// behavior, two links.
#[test]
fn a_native_child_inlined_twice() {
    let (j, c) = lower(&format!(
        "{STATE}import Counter from './Counter'\nexport default function T() {{ const [a, setA] = useState(1); const [b, setB] = useState(2); return <div><Counter n={{a}} onReset={{() => setA(0)}} /><Counter n={{b}} onReset={{() => setB(0)}} /></div> }}"
    ));
    assert_eq!(j.matches("x-data=\"counter_1f1ff519\"").count(), 2, "{j}");
    assert!(
        j.contains("x-props-bind=\"_p1\"") && j.contains("x-props-bind=\"_p2\""),
        "{j}"
    );
    assert!(
        c.contains("const _p1 = computed(() => ({ n: a(), onReset: () => a.set(0) }))"),
        "{c}"
    );
    assert!(
        c.contains("const _p2 = computed(() => ({ n: b(), onReset: () => b.set(0) }))"),
        "{c}"
    );
    // Each instance paints its own seed.
    let html = render(&j, serde_json::json!({}));
    assert!(
        html.contains(">1</button>") && html.contains(">2</button>"),
        "{html}"
    );
}

/// Review Focus 3 (template half): static text and attributes, and JSON in
/// x-props, survive quotes and `</script>`; `{` never reaches jinja.
#[test]
fn escaping_of_static_text_attributes_and_props_json() {
    let (j, _) = lower(&format!(
        "{STATE}export default function T({{ item }}: any) {{ const [n, setN] = useState(0); return <p title='a\"b</script>' onClick={{() => setN(1)}}>{{'{{{{ x }}}}'}} {{item.name}}{{n}}</p> }}"
    ));
    assert!(j.contains("title=\"a&quot;b&lt;/script&gt;\""), "{j}");
    assert!(j.contains("&#123;&#123; x }}"), "{j}");
    let html = render(
        &j,
        serde_json::json!({ "item": { "name": "a\"b</script>" } }),
    );
    let props = html
        .split("x-props='")
        .nth(1)
        .and_then(|s| s.split('\'').next())
        .unwrap();
    assert!(!props.contains('<') && !props.contains('\''), "{props}");
    let unq = props
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&");
    let v: serde_json::Value = serde_json::from_str(&unq).unwrap();
    assert_eq!(v["item"]["name"], "a\"b</script>");
    assert!(html.contains("a&quot;b&lt;/script&gt;"), "{html}");
}

/// The controlled-input pair is x-model; other onChange are DOM events by
/// field kind (F16).
#[test]
fn model_pair_and_change_events() {
    let (j, _) = lower(&format!(
        "{STATE}export default function T({{ f }}: any) {{ const [q, setQ] = useState(''); return <form><input value={{q}} onChange={{(e) => setQ(e.target.value)}} /><input onChange={{f}} /><input type=\"checkbox\" onChange={{f}} /></form> }}"
    ));
    assert!(j.contains("x-model=\"q\""), "{j}");
    assert_eq!(j.matches("x-on-input=").count(), 1, "{j}");
    assert_eq!(j.matches("x-on-change=").count(), 1, "{j}");
}

/// Spec §9 rule: `lower/` never names a Bun type.
#[test]
fn lower_sources_do_not_name_bun() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/lower");
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(!text.contains("bun_"), "{} names a Bun crate", p.display());
    }
}
