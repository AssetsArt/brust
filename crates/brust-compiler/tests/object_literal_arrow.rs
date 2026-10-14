//! F178: an object literal that ends up as the body of an arrow function in a printed chunk (`computed(() => { up: 1 })`)
//! parses as a block with a label, not as an object: `brust build` failed with `Expected ";" but found ":"` on valid React.
//! Every chunk the lowering prints for these shapes must parse, and must evaluate to the object.
mod lower_common;
use lower_common::{bun, lower};

const STATE: &str = "import { useState } from 'react'\n";

/// Whether `bun` parses `js` as a module (no bundling): a syntax error fails the build the way F178 did.
fn parses(js: &str, tag: &str) -> bool {
    let Some(bun) = bun() else { return true };
    let dir = std::env::temp_dir().join(format!("brust-f178-{}-{tag}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("chunk.js");
    std::fs::write(&file, js).unwrap();
    let ok = std::process::Command::new(bun)
        .args(["build", "--no-bundle"])
        .arg(&file)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(true);
    let _ = std::fs::remove_dir_all(&dir);
    ok
}

fn client(src: &str) -> String {
    lower(src).client_js.expect("a client chunk")
}

#[test]
fn a_local_object_constant_read_in_a_handler_prints_as_an_object() {
    // The repro from the roving-focus spike: `const step = { up: 1, down: -1 }` read in a handler.
    let c = client(&format!(
        "{STATE}export default function T() {{ const [n, setN] = useState(0); const step = {{ up: 1, down: -1 }}; return <button onClick={{() => setN(n + step.up)}}>{{n}}</button> }}"
    ));
    assert!(c.contains("computed(() => ({ up: 1, down: -1 }))"), "{c}");
    assert!(parses(&c, "handler"), "{c}");
}

#[test]
fn an_object_constant_read_in_a_template_expression_prints_as_an_object() {
    let c = client(&format!(
        "{STATE}export default function T() {{ const [n, setN] = useState(0); const o = {{ a: n }}; return <button data-x={{o.a}} onClick={{() => setN(n + 1)}}>{{o.a}}</button> }}"
    ));
    assert!(!c.contains("=> { a:"), "{c}");
    assert!(parses(&c, "template"), "{c}");
}

#[test]
fn an_object_literal_as_a_member_value_prints_as_an_object() {
    // An attribute whose value is an object literal over state is a computed member (`Paint::Raw`).
    let c = client(&format!(
        "{STATE}export default function T() {{ const [n, setN] = useState(0); return <button data-x={{{{ a: n }}}} onClick={{() => setN(n + 1)}}>{{n}}</button> }}"
    ));
    assert!(!c.contains("=> { a:"), "{c}");
    assert!(parses(&c, "member"), "{c}");
}

#[test]
fn the_helper_wraps_only_what_starts_with_a_brace() {
    use brust_compiler::lower::common::arrow_body;
    assert_eq!(arrow_body("{ up: 1 }"), "({ up: 1 })");
    assert_eq!(arrow_body("  { up: 1 }"), "(  { up: 1 })");
    assert_eq!(arrow_body("n() + 1"), "n() + 1");
    assert_eq!(arrow_body("({ up: 1 })"), "({ up: 1 })");
    assert_eq!(arrow_body("[{ a: 1 }]"), "[{ a: 1 }]");
}
