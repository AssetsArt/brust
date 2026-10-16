//! 2b-handlers (R34.18 extended): a live value (a prop that reads state) that reaches an element through a static
//! child's spread is bound by the parent, in the parent's scope, like an attribute written on that element; the child
//! stays static and unlinked. Every shape the spread could disagree about stays fail-closed with its own code.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{DiagClass, Tier};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

struct Out {
    jinja: String,
    chunk: String,
    tier: Tier,
    diags: Vec<(DiagClass, String, String)>,
}

/// Compiles `src` as `tests/fixtures/live-forward/<file>` (siblings in that directory resolve).
fn lower(file: &str, src: &str) -> Out {
    lower_of(file, src, file)
}

/// [`lower`], reading the result for the component compiled from `which` (`file` itself, or a child it imports).
fn lower_of(file: &str, src: &str, which: &str) -> Out {
    let s = src.to_string();
    let which = which.to_string();
    let path = format!("crates/brust-compiler/tests/fixtures/live-forward/{file}");
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            &path,
            Some(s.into_bytes()),
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        let node = tree
            .iter()
            .find(|n| n.ir.source.ends_with(&which))
            .unwrap_or_else(|| panic!("no {which} in the tree"));
        let a = &node.artifacts;
        Out {
            jinja: a.jinja.clone(),
            chunk: a.client_js.clone().unwrap_or_default(),
            tier: node.ir.tier.clone(),
            diags: node
                .ir
                .diagnostics
                .iter()
                .chain(&a.diagnostics)
                .map(|d| (d.class, d.rule.clone(), d.message.clone()))
                .collect(),
        }
    })
}

/// Renders like the server: props are top-level variables and `_props` is the whole object.
fn render(jinja: &str, props: serde_json::Value) -> String {
    let mut ctx = props.clone();
    ctx["_props"] = props;
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    env.render_str(jinja, brust_jinja::value_of(ctx))
        .unwrap()
        .trim()
        .to_string()
}

const STATE: &str = "import { useState } from 'react'\n";

fn page(imports: &str, body: &str) -> Out {
    lower(
        "P.tsx",
        &format!("{STATE}{imports}\nexport default function P() {{ {body} }}"),
    )
}

fn fallback_rules(o: &Out) -> Vec<&str> {
    o.diags
        .iter()
        .filter(|(c, _, _)| *c == DiagClass::Fallback)
        .map(|(_, r, _)| r.as_str())
        .collect()
}

/// The parent falls back to React with `rule`.
fn refused(o: &Out, rule: &str) {
    assert!(matches!(o.tier, Tier::React { .. }), "{:?}", o.diags);
    assert!(fallback_rules(o).contains(&rule), "{rule}: {:?}", o.diags);
}

/// [`refused_any`] for a binding other than `aria-pressed`.
fn refused_any_of(o: &Out, bound: &str) {
    assert!(matches!(o.tier, Tier::React { .. }), "{:?}", o.diags);
    assert!(!fallback_rules(o).is_empty(), "{:?}", o.diags);
    assert!(!o.jinja.contains(bound), "{}", o.jinja);
}

/// The parent falls back to React (whatever code names it), and binds nothing.
fn refused_any(o: &Out) {
    assert!(matches!(o.tier, Tier::React { .. }), "{:?}", o.diags);
    assert!(!fallback_rules(o).is_empty(), "{:?}", o.diags);
    assert!(!o.jinja.contains("x-bind-aria-pressed"), "{}", o.jinja);
}

const FLIP: &str = "const [on, setOn] = useState(false);";

#[test]
fn a_live_value_through_a_static_childs_spread_prints_like_the_hand_written_element() {
    let o = page(
        "import Btn from './Btn'",
        &format!(
            "{FLIP} return <div><Btn aria-pressed={{on}} data-state={{on ? 'on' : 'off'}}>x</Btn><i onClick={{() => setOn(!on)}}>flip</i></div>"
        ),
    );
    assert_eq!(o.tier, Tier::Native, "{:?}", o.diags);
    let hand = page(
        "",
        &format!(
            "{FLIP} return <div><button data-slot=\"button\" data-variant=\"default\" aria-pressed={{on}} data-state={{on ? 'on' : 'off'}}>x</button><i onClick={{() => setOn(!on)}}>flip</i></div>"
        ),
    );
    // The member numbering, the server print and the chunk are the hand-written element's.
    assert_eq!(o.chunk, hand.chunk);
    assert_eq!(
        render(&o.jinja, serde_json::json!({})),
        render(&hand.jinja, serde_json::json!({}))
    );
    // First paint: React prints `aria-pressed="false"` for a false boolean (F196), not an omitted attribute.
    let html = render(&o.jinja, serde_json::json!({}));
    assert!(html.contains(" aria-pressed=\"false\""), "{html}");
    assert!(html.contains(" x-bind-aria-pressed="), "{html}");
    // Nothing links the instance: no host, no props bridge of its own.
    assert!(!html.contains("x-props-bind"), "{html}");
}

#[test]
fn a_live_value_and_a_handler_together_leave_the_child_unlinked() {
    let o = page(
        "import Btn from './Btn'",
        &format!("{FLIP} return <Btn aria-pressed={{on}} onClick={{() => setOn(!on)}}>x</Btn>"),
    );
    assert_eq!(o.tier, Tier::Native, "{:?}", o.diags);
    let hand = page(
        "",
        &format!(
            "{FLIP} return <button data-slot=\"button\" data-variant=\"default\" aria-pressed={{on}} onClick={{() => setOn(!on)}}>x</button>"
        ),
    );
    assert_eq!(o.chunk, hand.chunk);
    let html = render(&o.jinja, serde_json::json!({}));
    assert_eq!(html.matches("x-on-click").count(), 1, "{html}");
    assert_eq!(html.matches("x-bind-aria-pressed").count(), 1, "{html}");
    assert!(!html.contains("x-props-bind"), "{html}");
}

#[test]
fn a_live_value_in_a_list_is_bound_per_row() {
    let o = page(
        "import Btn from './Btn'",
        "const [sel, setSel] = useState(''); return <div>{['a', 'b'].map((it) => <Btn key={it} aria-pressed={sel === it} onClick={() => setSel(it)}>{it}</Btn>)}</div>",
    );
    assert_eq!(o.tier, Tier::Native, "{:?}", o.diags);
    let hand = page(
        "",
        "const [sel, setSel] = useState(''); return <div>{['a', 'b'].map((it) => <button key={it} data-slot=\"button\" data-variant=\"default\" aria-pressed={sel === it} onClick={() => setSel(it)}>{it}</button>)}</div>",
    );
    assert_eq!(o.chunk, hand.chunk);
    let html = render(&o.jinja, serde_json::json!({}));
    assert!(html.contains("x-bind-aria-pressed=\"_c1:it\""), "{html}");
}

#[test]
fn the_toggle_shape_binds_its_live_attributes_and_asks_its_call_sites_not_to_write_them() {
    // Radix `Toggle`: live attributes ahead of a spread of its own rest.
    let p = page(
        "import Toggle2 from './Toggle2'",
        "return <Toggle2 aria-label=\"t\">x</Toggle2>",
    );
    assert!(!matches!(p.tier, Tier::React { .. }), "{:?}", p.diags);
    let t = lower_of(
        "P.tsx",
        &format!(
            "{STATE}import Toggle2 from './Toggle2'\nexport default function P() {{ return <Toggle2 aria-label=\"t\">x</Toggle2> }}"
        ),
        "Toggle2.tsx",
    );
    assert_eq!(t.tier, Tier::Native, "{:?}", t.diags);
    let html = render(
        &t.jinja,
        serde_json::json!({ "defaultOn": false, "_props": {} }),
    );
    assert!(html.contains(" aria-pressed=\"false\""), "{html}");
    assert!(html.contains(" data-state=\"off\""), "{html}");
    assert!(
        html.contains(" x-bind-aria-pressed=") && html.contains(" x-bind-data-state="),
        "{html}"
    );
    assert!(html.contains(" x-on-click="), "{html}");
}

#[test]
fn a_call_site_that_could_replace_a_live_attribute_falls_back_named() {
    // Writing the key would, in React, replace the live value (the later spread wins), and the one shared chunk
    // cannot tell: the call site falls back, with the code of the requirement.
    let w = page(
        "import Toggle2 from './Toggle2'",
        "return <Toggle2 aria-pressed={true}>x</Toggle2>",
    );
    refused(&w, "spread-props");
    assert!(
        w.diags
            .iter()
            .any(|(_, _, m)| m.contains("aria-pressed") && m.contains("could replace it")),
        "{:?}",
        w.diags
    );
    // Written as `false`/`undefined` too: a present key wins in React.
    refused(
        &page(
            "import Toggle2 from './Toggle2'",
            "return <Toggle2 data-state={undefined}>x</Toggle2>",
        ),
        "spread-props",
    );
    // A spread of keys known only at render may carry it.
    let s = lower(
        "S.tsx",
        "import Toggle2 from './Toggle2'\nexport default function S({ extra }: any) { return <Toggle2 {...extra}>x</Toggle2> }",
    );
    refused(&s, "spread-props");
    // A spread of the call site's own props passes the requirement up; a route root has nobody above it to ask.
    let r = lower(
        "R.tsx",
        "import Toggle2 from './Toggle2'\nexport default function R({ ...rest }: any) { return <Toggle2 {...rest}>x</Toggle2> }",
    );
    refused(&r, "spread-props");
    // A wrapper that is not a root passes it up to ITS call sites: those may not write the key either.
    let ok = page("import Wrap from './Wrap'", "return <Wrap label=\"l\" />");
    assert!(!matches!(ok.tier, Tier::React { .. }), "{:?}", ok.diags);
    refused(
        &page(
            "import Wrap from './Wrap'",
            "return <Wrap label=\"l\" aria-pressed={true} />",
        ),
        "spread-props",
    );
}

#[test]
fn a_rest_spread_before_the_live_attribute_needs_no_requirement() {
    // `{...rest} aria-pressed={on}`: the attribute is written after, so it wins and nothing can replace it.
    let b = page(
        "import Before from './Before'",
        "return <Before aria-pressed={true} />",
    );
    assert!(!matches!(b.tier, Tier::React { .. }), "{:?}", b.diags);
}

#[test]
fn a_later_spread_that_is_not_the_components_own_rest_may_replace_a_live_attribute() {
    // Keys known only at render: nothing says the attribute survives, so the parent does not bind it.
    let o = lower_of(
        "P.tsx",
        &format!(
            "{STATE}import Later from './Later'\nexport default function P() {{ return <Later attrs={{{{ title: 't' }}}} /> }}"
        ),
        "Later.tsx",
    );
    refused_any(&o);
    // The handler beside it is refused for the link the unbound value leaves, the value for the spread.
    assert!(
        o.diags
            .iter()
            .any(|(_, r, _)| r == "spread-props" || r == "spread-handler"),
        "{:?}",
        o.diags
    );
}

#[test]
fn a_live_value_the_child_could_also_consume_elsewhere_stays_refused() {
    let live = |child: &str, name: &str| {
        page(
            &format!("import {name} from './{child}'"),
            &format!(
                "{FLIP} return <div><{name} aria-pressed={{on}} /><i onClick={{() => setOn(!on)}}>flip</i></div>"
            ),
        )
    };
    // C2: a second spread of the rest, the rest read as a value, the key read by name, the rest passed on.
    for (file, name) in [
        ("Twice", "Twice"),
        ("RestRead", "RestRead"),
        ("RestAlias", "RestAlias"),
        ("RestJson", "RestJson"),
        ("Reads", "Reads"),
        ("Onward", "Onward"),
    ] {
        refused_any(&live(file, name));
    }
    // Reading another key of the rest by name does not stop the parent binding this one.
    let m = live("RestMember", "RestMember");
    assert!(!matches!(m.tier, Tier::React { .. }), "{:?}", m.diags);
    assert!(m.jinja.contains("x-bind-aria-pressed"), "{}", m.jinja);
}

#[test]
fn keys_that_merge_set_a_property_or_are_not_attributes_stay_refused() {
    for attr in [
        "value={on ? 'a' : 'b'}",
        "checked={on}",
        "x-html={on ? 'a' : 'b'}",
        "href={on ? '/a' : ''}",
        "src={on ? '/a.png' : ''}",
        "dangerouslySetInnerHTML={{ __html: on ? 'a' : 'b' }}",
        "onMouseDown={on}",
    ] {
        let o = page(
            "import Btn from './Btn'",
            &format!(
                "{FLIP} return <div><Btn {attr} /><i onClick={{() => setOn(!on)}}>flip</i></div>"
            ),
        );
        assert!(
            matches!(o.tier, Tier::React { .. }) || !o.jinja.contains("x-bind-"),
            "{attr}: {:?} {}",
            o.diags,
            o.jinja
        );
        assert!(
            !o.jinja.contains("x-bind-x-html")
                && !o.jinja.contains("x-bind-value")
                && !o.jinja.contains("x-bind-checked"),
            "{attr}: {}",
            o.jinja
        );
    }
}

#[test]
fn a_function_that_is_not_an_event_stays_a_spread_function_refusal() {
    let o = page(
        "import Btn from './Btn'",
        &format!("{FLIP} return <Btn render={{() => on}} onClick={{() => setOn(!on)}} />"),
    );
    refused_any(&o);
}

// ---- bugs on main that the toggle page exposed, each pinned on its own ----

fn chunk_of(src: &str) -> String {
    lower("Own.tsx", src).chunk
}

#[test]
fn a_ref_cell_starts_at_its_initial_value() {
    // `useRef(n)` is a cell holding `n` (React: the first render's value); a DOM ref (`useRef(null)`) is unchanged.
    let c = chunk_of(
        "import { useRef, useState } from 'react'\nexport default function Own() { const [n, setN] = useState(0); const prev = useRef(n); const el = useRef(null); return <button ref={el} onClick={() => { prev.current = n; setN(n + 1) }}>{n}</button> }",
    );
    assert!(c.contains("const prev = __ref(\"prev\", n())"), "{c}");
    assert!(c.contains("const el = __ref(\"el\")"), "{c}");
}

#[test]
fn a_whole_props_parameter_read_in_a_handler_binds_its_own_name() {
    // `props.disabled` in a handler of a component that also destructures `...rest` from `props`: the capture is the
    // whole props object, bound under the parameter's name (it printed as `*`, which is not JavaScript).
    let c = chunk_of(
        "import { useState } from 'react'\nexport default function Own(props: any) { const { label, ...rest } = props; const [n, setN] = useState(0); return <button {...rest} onClick={() => { if (!props.disabled) setN(n + 1) }}>{label}{n}</button> }",
    );
    assert!(!c.contains("(*,") && !c.contains("(* "), "{c}");
    assert!(c.contains("(props,"), "{c}");
}

#[test]
fn what_a_hooks_state_and_ref_start_from_is_declared_before_them() {
    // The call's arguments (`defaultProp: defaultPressed ?? false`, `onChange` with a default) are declared ahead of
    // the hook's own state and refs, which read them when they start: a `const` read before its declaration throws.
    let c = lower(
        "Ord.tsx",
        &std::fs::read_to_string(
            repo().join("crates/brust-compiler/tests/fixtures/live-forward/Ord.tsx"),
        )
        .unwrap(),
    )
    .chunk;
    let at = |needle: &str| {
        c.find(needle)
            .unwrap_or_else(|| panic!("no `{needle}` in\n{c}"))
    };
    assert!(
        at("const defaultProp_useCtl1 =") < at("= signal(defaultProp_useCtl1()"),
        "{c}"
    );
    assert!(
        at("const onChange_useCtl1 =") < at("const onChangeRef_useCtl1 = __ref("),
        "{c}"
    );
    // A default applies only to `undefined`.
    assert!(
        c.contains("props().onPressedChange === undefined ? "),
        "{c}"
    );
}

/// No linked host carries a directive of the parent's: a host with `x-props-bind` is the child's scope, so an
/// `x-bind-*` / `x-on-*` printed on the same tag would resolve in the child, not in the parent (review F1, C7).
fn no_mixed_scope(jinja: &str) {
    let html = render(jinja, serde_json::json!({}));
    for tag in html.split('<').skip(1) {
        let tag = tag.split('>').next().unwrap_or("");
        assert!(
            !(tag.contains("x-props-bind") && (tag.contains(" x-bind-") || tag.contains(" x-on-"))),
            "a linked host carries the parent's directive: <{tag}>"
        );
    }
}

#[test]
fn an_instance_that_is_linked_anyway_binds_no_live_forward() {
    // `variant` is a prop the child binds by name and it reads state: the instance is linked, its element is the
    // child's host, and `aria-pressed` would resolve in the child's scope (`_c1` is the child's `variant`). Main falls
    // back; so do we.
    let linked = page(
        "import Btn from './Btn'",
        &format!(
            "{FLIP} return <div><Btn aria-pressed={{on}} variant={{on ? 'a' : 'b'}}>x</Btn><i onClick={{() => setOn(!on)}}>flip</i></div>"
        ),
    );
    refused_any(&linked);
    // Per row: a prop that reads only the row links the instance inside the list.
    let row = page(
        "import Btn from './Btn'",
        "const [sel, setSel] = useState(''); return <div>{['a', 'b'].map((it) => <Btn key={it} aria-pressed={sel === it} variant={it} onClick={() => setSel(it)}>{it}</Btn>)}</div>",
    );
    refused_any(&row);
    // The unlinked cases never mix scopes.
    for o in [
        page(
            "import Btn from './Btn'",
            &format!("{FLIP} return <Btn aria-pressed={{on}} onClick={{() => setOn(!on)}}>x</Btn>"),
        ),
        page(
            "import Btn from './Btn'",
            "const [sel, setSel] = useState(''); return <div>{['a', 'b'].map((it) => <Btn key={it} aria-pressed={sel === it} onClick={() => setSel(it)}>{it}</Btn>)}</div>",
        ),
    ] {
        assert_eq!(o.tier, Tier::Native, "{:?}", o.diags);
        no_mixed_scope(&o.jinja);
    }
}

#[test]
fn a_live_url_through_a_spread_is_never_bound_by_the_parent() {
    // React keeps `href=""` on an anchor and drops it elsewhere (`<img src="">`): the print decides by the element's
    // tag, and the parent only knows the component's name (review F2).
    let o = page(
        "import Anchor from './Anchor'",
        &format!(
            "{FLIP} return <div><Anchor href={{on ? '/a' : ''}} /><i onClick={{() => setOn(!on)}}>flip</i></div>"
        ),
    );
    refused_any_of(&o, "x-bind-href");
}

// ---- F296 (spread-live, option A): a live `style` through a static child's spread ----

const STYLE: &str = "style={{ width: on ? 5 : 0, '--gap': 7, opacity: on ? 1 : 0.5 }}";

#[test]
fn a_live_style_through_a_static_childs_spread_prints_like_the_hand_written_element() {
    let o = page(
        "import Btn from './Btn'",
        &format!(
            "{FLIP} return <div><Btn {STYLE}>x</Btn><i onClick={{() => setOn(!on)}}>flip</i></div>"
        ),
    );
    assert_eq!(o.tier, Tier::Native, "{:?}", o.diags);
    let hand = page(
        "",
        &format!(
            "{FLIP} return <div><button data-slot=\"button\" data-variant=\"default\" {STYLE}>x</button><i onClick={{() => setOn(!on)}}>flip</i></div>"
        ),
    );
    assert_eq!(o.chunk, hand.chunk);
    assert_eq!(
        render(&o.jinja, serde_json::json!({})),
        render(&hand.jinja, serde_json::json!({}))
    );
    let html = render(&o.jinja, serde_json::json!({}));
    assert!(html.contains(" x-bind-style="), "{html}");
    assert!(!html.contains("x-props-bind"), "{html}");
}

#[test]
fn the_forwarded_style_replaces_the_childs_own_before_the_spread_and_never_lands_after_it() {
    // own before the spread: the call site's `style` replaces it, printed once and bound
    let o = page(
        "import B from './StyleBefore'",
        &format!("{FLIP} return <div><B {STYLE} /><i onClick={{() => setOn(!on)}}>flip</i></div>"),
    );
    assert_eq!(o.tier, Tier::Native, "{:?}", o.diags);
    let html = render(&o.jinja, serde_json::json!({}));
    assert!(html.contains(" x-bind-style="), "{html}");
    assert_eq!(html.matches(" style=").count(), 1, "{html}");
    assert!(!html.contains("color:red"), "{html}");
    // own after the spread: the child's value wins, nothing is bound for the call site's
    let o = page(
        "import A from './StyleAfter'",
        &format!("{FLIP} return <div><A {STYLE} /><i onClick={{() => setOn(!on)}}>flip</i></div>"),
    );
    assert!(!o.jinja.contains("x-bind-style"), "{}", o.jinja);
    let html = render(&o.jinja, serde_json::json!({}));
    assert!(
        html.contains("color:red") && !html.contains("width"),
        "{html}"
    );
}

#[test]
fn a_style_that_could_merge_or_that_the_child_also_reads_stays_refused_or_unbound() {
    // C1: a Slot merges the call site's style with its child element's own: refused unless the host is certain
    for slot in ["asChild", "asChild={true}"] {
        let o = page(
            "import B from './BtnSlot'",
            &format!(
                "{FLIP} return <div><B {slot} {STYLE}><a href=\"/x\" style={{{{ color: 'red' }}}}>go</a></B><i onClick={{() => setOn(!on)}}>flip</i></div>"
            ),
        );
        refused_any_of(&o, "x-bind-style");
    }
    // a dynamic flag may select the Slot as well
    let o = page(
        "import B from './BtnSlot'",
        &format!(
            "{FLIP} return <div><B asChild={{on}} {STYLE}><a href=\"/x\">go</a></B><i onClick={{() => setOn(!on)}}>flip</i></div>"
        ),
    );
    refused_any_of(&o, "x-bind-style");
    // asChild absent or false: the host element, the style is bound
    for flag in ["", "asChild={false}"] {
        let o = page(
            "import B from './BtnSlot'",
            &format!(
                "{FLIP} return <div><B {flag} {STYLE}>x</B><i onClick={{() => setOn(!on)}}>flip</i></div>"
            ),
        );
        assert_eq!(o.tier, Tier::Native, "{flag}: {:?}", o.diags);
        assert!(o.jinja.contains("x-bind-style"), "{flag}: {}", o.jinja);
    }
    // the child spreads on two elements / reads `style` by name / is native with state of its own
    let o = page(
        "import T from './Twice'",
        &format!("{FLIP} return <div><T {STYLE} /><i onClick={{() => setOn(!on)}}>flip</i></div>"),
    );
    refused_any_of(&o, "x-bind-style");
    let o = page(
        "import N from './NativeFwd'",
        &format!("{FLIP} return <div><N {STYLE} /><i onClick={{() => setOn(!on)}}>flip</i></div>"),
    );
    refused_any_of(&o, "x-bind-style");
    // a later spread of unknown keys may replace it (a literal `{}` spread is inlined away, so it is not one)
    let o = lower(
        "P.tsx",
        &format!(
            "{STATE}import Btn from './Btn'\nexport default function P(props: any) {{ {FLIP} return <div><Btn {STYLE} {{...props}} /><i onClick={{() => setOn(!on)}}>flip</i></div> }}"
        ),
    );
    refused_any_of(&o, "x-bind-style");
}

#[test]
fn a_style_given_as_a_string_is_never_written_through_a_spread() {
    // React throws for a string `style`; brust must not bind it as if it were an object
    let o = page(
        "import Btn from './Btn'",
        &format!(
            "{FLIP} return <div><Btn style={{on ? 'color:red' : 'color:blue'}} /><i onClick={{() => setOn(!on)}}>flip</i></div>"
        ),
    );
    // brust prints no declaration for a non-object (the same as a hand-written `<button style={str}>`): the string is
    // never written into the attribute, on the server or by the binder.
    let html = render(&o.jinja, serde_json::json!({}));
    assert!(!html.contains("color:"), "{html}");
    assert!(!html.contains(" style=\""), "{html}");
}

// ---- F299 (spread-live): a live `className` through a static child's spread, the same rules as `style` ----

const CLASS: &str = "className={on ? 'on big' : 'off'}";

#[test]
fn a_live_class_name_through_a_static_childs_spread_prints_like_the_hand_written_element() {
    let o = page(
        "import Btn from './Btn'",
        &format!(
            "{FLIP} return <div><Btn {CLASS}>x</Btn><i onClick={{() => setOn(!on)}}>flip</i></div>"
        ),
    );
    assert_eq!(o.tier, Tier::Native, "{:?}", o.diags);
    let hand = page(
        "",
        &format!(
            "{FLIP} return <div><button data-slot=\"button\" data-variant=\"default\" {CLASS}>x</button><i onClick={{() => setOn(!on)}}>flip</i></div>"
        ),
    );
    assert_eq!(o.chunk, hand.chunk);
    assert_eq!(
        render(&o.jinja, serde_json::json!({})),
        render(&hand.jinja, serde_json::json!({}))
    );
    let html = render(&o.jinja, serde_json::json!({}));
    assert!(html.contains(" x-bind-class="), "{html}");
    assert!(html.contains(" class=\"off\""), "{html}");
    assert!(!html.contains("x-props-bind"), "{html}");
}

#[test]
fn a_forwarded_class_name_replaces_the_childs_own_and_a_slot_refuses_it() {
    // React replaces: a child's own className before the spread is replaced; after it, it wins and nothing is bound
    let own_before = page(
        "import B from './ClassBefore'",
        &format!("{FLIP} return <div><B {CLASS} /><i onClick={{() => setOn(!on)}}>flip</i></div>"),
    );
    assert_eq!(own_before.tier, Tier::Native, "{:?}", own_before.diags);
    let html = render(&own_before.jinja, serde_json::json!({}));
    assert!(html.contains(" x-bind-class="), "{html}");
    assert_eq!(html.matches(" class=").count(), 1, "{html}");
    assert!(!html.contains("own"), "{html}");
    let own_after = page(
        "import A from './ClassAfter'",
        &format!("{FLIP} return <div><A {CLASS} /><i onClick={{() => setOn(!on)}}>flip</i></div>"),
    );
    assert!(
        !own_after.jinja.contains("x-bind-class"),
        "{}",
        own_after.jinja
    );
    assert!(render(&own_after.jinja, serde_json::json!({})).contains("own"));
    // a Slot merges class lists
    let slot = page(
        "import B from './BtnSlot'",
        &format!(
            "{FLIP} return <div><B asChild {CLASS}><a href=\"/x\" className=\"link\">go</a></B><i onClick={{() => setOn(!on)}}>flip</i></div>"
        ),
    );
    refused_any_of(&slot, "x-bind-class");
}
