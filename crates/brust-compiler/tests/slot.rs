//! shadcn S1.4 (R34.28-R34.34): `const Comp = asChild ? Slot.Root : "host"` is resolved at the
//! call site. No `asChild` prints the host; a literal `asChild` with one host-element child prints
//! that child with the component's attributes merged in (Radix `mergeProps`); anything else keeps
//! the caller on React with its own code.
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
    tier: Tier,
    diags: Vec<(DiagClass, String)>,
}

/// Compiles `src` as `tests/fixtures/slot/<file>` (siblings in that directory resolve).
fn lower(file: &str, src: &str) -> Out {
    let s = src.to_string();
    let path = format!("crates/brust-compiler/tests/fixtures/slot/{file}");
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
        let a = &tree[0].artifacts;
        Out {
            jinja: a.jinja.clone(),
            tier: tree[0].ir.tier.clone(),
            diags: tree[0]
                .ir
                .diagnostics
                .iter()
                .chain(&a.diagnostics)
                .map(|d| (d.class, d.rule.clone()))
                .collect(),
        }
    })
}

/// Whether the component whose id starts with `prefix` came out polymorphic (`ir.poly`) when compiled as a child of `src`.
fn is_poly(file: &str, src: &str, prefix: &str) -> bool {
    let s = src.to_string();
    let path = format!("crates/brust-compiler/tests/fixtures/slot/{file}");
    let prefix = prefix.to_string();
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
        tree.iter()
            .find(|c| c.ir.id.starts_with(&prefix))
            .unwrap_or_else(|| panic!("{prefix}"))
            .ir
            .poly
            .is_some()
    })
}

fn render(jinja: &str) -> String {
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    env.render_str(
        jinja,
        brust_jinja::value_of(serde_json::json!({"_props": {}})),
    )
    .unwrap()
    .trim()
    .to_string()
}

fn page(body: &str) -> String {
    format!(
        "import Btn from './Btn'\nimport Chip from './Chip'\nimport Swapped from './Swapped'\nimport Own from './Own'\nimport Link from './Link'\nimport Plain from './Plain'\nimport Stateful from './Stateful'\nimport ItemLike from './ItemLike'\nimport Pressable from './Pressable'\nimport ItemMouse from './ItemMouse'\nimport ReadsKey from './ReadsKey'\nimport Fed from './Fed'\nimport Carry from './Carry'\nimport Dsi from './Dsi'\nimport Bag from './Bag'\nimport Carrier from './Carrier'\nimport Carrier2 from './Carrier2'\nimport CarrierIf from './CarrierIf'\nimport CarrierTwo from './CarrierTwo'\nimport CarrierPath from './CarrierPath'\nimport CarrierNamed from './CarrierNamed'\nimport CarrierOver from './CarrierOver'\nimport CarrierLoop from './CarrierLoop'\nimport CarrierBag from './CarrierBag'\nimport CarrierKids from './CarrierKids'\nimport CarrierEm from './CarrierEm'\nimport CarrierFlagRead from './CarrierFlagRead'\nexport default function P() {{ return <main>{body}</main> }}"
    )
}

fn codes(o: &Out) -> Vec<&str> {
    o.diags.iter().map(|(_, r)| r.as_str()).collect()
}

fn react_with(o: &Out, rule: &str) -> bool {
    matches!(o.tier, Tier::React { .. })
        && o.diags
            .iter()
            .any(|(c, r)| *c == DiagClass::Fallback && r == rule)
}

#[test]
fn without_as_child_the_host_element_prints_and_the_component_is_static() {
    let o = lower(
        "P.tsx",
        &page("<Btn variant=\"x\" id=\"i\">Go</Btn><Btn asChild={false}>No</Btn><Chip>c</Chip>"),
    );
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    assert!(!codes(&o).contains(&"local-component"), "{:?}", o.diags);
    assert_eq!(
        render(&o.jinja),
        "<main><button data-slot=\"btn\" data-variant=\"x\" class=\"base \" id=\"i\">Go</button>\
<button data-slot=\"btn\" data-variant=\"default\" class=\"base \">No</button><span data-slot=\"chip\">c</span></main>"
    );
}

#[test]
fn a_literal_as_child_prints_the_child_with_the_component_attributes_merged() {
    let o = lower(
        "P.tsx",
        &page(
            "<Btn asChild className=\"extra\" id=\"slot\"><a href=\"/login\" id=\"mine\" className=\"link\">Login</a></Btn>",
        ),
    );
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    // Slot props first, the child's override them (`id`), `className` joins slot-first.
    assert_eq!(
        render(&o.jinja),
        "<main><a data-slot=\"btn\" data-variant=\"default\" class=\"base extra link\" id=\"mine\" href=\"/login\">Login</a></main>"
    );
}

#[test]
fn style_objects_merge_and_the_child_wins() {
    let o = lower(
        "P.tsx",
        &page(
            "<Chip asChild style={{ color: 'red', margin: 1 }}><b style={{ color: 'blue' }}>x</b></Chip>",
        ),
    );
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    let html = render(&o.jinja);
    assert!(html.starts_with("<main><b data-slot=\"chip\""), "{html}");
    assert!(html.contains("color:blue"), "{html}");
    assert!(html.contains("margin:1px"), "{html}");
    assert!(!html.contains("color:red"), "{html}");
}

#[test]
fn the_swapped_ternary_selects_the_slot_with_the_flag_false() {
    let o = lower(
        "P.tsx",
        &page("<Swapped plain>p</Swapped><Swapped><i>s</i></Swapped>"),
    );
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    assert_eq!(
        render(&o.jinja),
        "<main><p data-slot=\"swapped\">p</p><i data-slot=\"swapped\">s</i></main>"
    );
}

#[test]
fn a_dynamic_flag_or_a_spread_keeps_the_caller_on_react() {
    for (src, why) in [
        ("<Btn asChild={props.x}><a/></Btn>", "prop"),
        ("<Btn {...props}>x</Btn>", "spread"),
    ] {
        let s = format!(
            "import Btn from './Btn'\nexport default function P(props: any) {{ return <main>{src}</main> }}"
        );
        let o = lower("P.tsx", &s);
        assert!(react_with(&o, "slot-dynamic"), "{why}: {:?}", o.diags);
    }
}

#[test]
fn child_shapes_that_cannot_merge_stay_on_react() {
    for (body, rule) in [
        ("<Btn asChild>text</Btn>", "slot-child-shape"),
        ("<Btn asChild><a/><a/></Btn>", "slot-child-shape"),
        ("<Btn asChild></Btn>", "slot-child-shape"),
        ("<Btn asChild><Chip/></Btn>", "slot-child-component"),
        (
            "<Btn asChild><Plain>x</Plain></Btn>",
            "slot-child-component",
        ),
        ("<Btn asChild><Stateful /></Btn>", "slot-child-component"),
        (
            "<Btn asChild><Link onClick={() => {}}>x</Link></Btn>",
            "slot-handler",
        ),
        (
            "<Btn asChild><Link style={{ color: 'red' }}>x</Link></Btn>",
            "slot-merge",
        ),
        (
            "<Btn asChild><Link {...props}>x</Link></Btn>",
            "slot-child-shape",
        ),
        (
            "<Btn asChild><a onClick={() => {}}>x</a></Btn>",
            "slot-handler",
        ),
        (
            "<Btn asChild onClick={() => {}}><a>x</a></Btn>",
            "slot-handler",
        ),
        (
            "<Btn asChild><a dangerouslySetInnerHTML={{ __html: 'x' }}/></Btn>",
            "slot-child-shape",
        ),
    ] {
        let o = lower("P.tsx", &page(body));
        assert!(react_with(&o, rule), "{body}: {:?}", o.diags);
    }
}

#[test]
fn a_slot_that_is_not_radixs_keeps_local_component() {
    // The tag is `Comp`, a const of a Slot that is not Radix's: an ordinary local component.
    let own = lower(
        "Own.tsx",
        &std::fs::read_to_string(repo().join("crates/brust-compiler/tests/fixtures/slot/Own.tsx"))
            .unwrap(),
    );
    assert!(react_with(&own, "local-component"), "{:?}", own.diags);
    let o = lower("P.tsx", &page("<Own>x</Own>"));
    // Own is a React island; its constant children travel with it (island-children), so the page stays static.
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
}

#[test]
fn a_stateful_component_with_as_child_stays_on_react() {
    let o = lower(
        "P.tsx",
        "import { useState } from 'react'\nimport { Slot } from 'radix-ui'\nfunction Tog({ asChild }: any) { const [n, setN] = useState(0); const Comp = asChild ? Slot.Root : 'button'; return <Comp onClick={() => setN(n + 1)}>{n}</Comp> }\nexport default function P() { return <main><Tog asChild><a>x</a></Tog></main> }",
    );
    assert!(react_with(&o, "slot-native"), "{:?}", o.diags);
}

#[test]
fn a_prop_the_call_site_omits_is_undefined_for_the_childs_job() {
    // Cn has a per-instance job over `className` and `size`; the call passes neither. The manifest
    // binds every job input root, so each is bound to `undefined` (the child's default applies).
    let src = "import Cn from './Cn'\nexport default function P() { return <main><Cn id=\"a\" /></main> }";
    let s = src.to_string();
    let path = "crates/brust-compiler/tests/fixtures/slot/P.tsx".to_string();
    let (instances, child_job) = run_on_compiler_thread(move || {
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
        let child = tree
            .iter()
            .find(|c| c.ir.id.starts_with("cn"))
            .expect("Cn compiled");
        (
            tree[0].ir.instances.clone(),
            child.artifacts.server_ts.clone().unwrap_or_default(),
        )
    });
    let exprs = &instances[0].exprs;
    assert_eq!(
        exprs.get("className").map(String::as_str),
        Some("__undefined"),
        "{instances:?}"
    );
    assert_eq!(
        exprs.get("size").map(String::as_str),
        Some("__undefined"),
        "{instances:?}"
    );
    // F151: the omitted prop reaches the job absent (brust-core), so the JS destructuring default applies.
    assert!(
        child_job.contains("const { size = (\"m\") } = props"),
        "{child_job}"
    );
}

#[test]
fn a_runtime_spread_with_a_class_or_style_under_as_child_is_a_fallback_not_a_build_error() {
    // Bag spreads `attrs` (keys known only at render); the child brings class/style that would merge with it.
    let page = |kid: &str, attrs: &str| {
        format!(
            "import Bag from './Bag'\nexport default function P({{ data }}: any) {{ return <main><Bag asChild{attrs}>{kid}</Bag></main> }}"
        )
    };
    for kid in [
        "<a className=\"kid\" style={{ color: 'red' }}>x</a>",
        "<a className=\"kid\">x</a>",
        "<a style={{ color: 'red' }}>x</a>",
    ] {
        let o = lower("P.tsx", &page(kid, " attrs={data}"));
        assert!(react_with(&o, "slot-merge"), "{kid}: {:?}", o.diags);
        assert!(
            !o.diags.iter().any(|(c, _)| *c == DiagClass::Error),
            "{kid}: {:?}",
            o.diags
        );
    }
    // No class or style on the child: nothing to merge, the page stays static.
    let o = lower("P.tsx", &page("<a href=\"/x\">x</a>", " attrs={data}"));
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
}

#[test]
fn a_raw_text_child_under_as_child_stays_on_react() {
    for kid in [
        "<style>{'a > b { color: red }'}</style>",
        "<script>{'if (a > b) {}'}</script>",
    ] {
        let o = lower("P.tsx", &page(&format!("<Btn asChild>{kid}</Btn>")));
        assert!(react_with(&o, "slot-child-shape"), "{kid}: {:?}", o.diags);
    }
}

/// F363a: React's Slot hands the component's element attributes to a COMPONENT child as props (`className` joined, the
/// element's first); the child prints them where it spreads its props, so the output is what it prints when given them.
#[test]
fn as_child_over_a_static_component_gives_it_the_element_attributes_as_props() {
    let o = lower(
        "P.tsx",
        &page(
            "<Btn asChild className=\"extra\" id=\"slot\"><Link href=\"/login\" id=\"mine\" className=\"own\">Login</Link></Btn>",
        ),
    );
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    // Slot props first, the child's override them (`id`), `className` joins slot-first and then goes through Link's own.
    assert_eq!(
        render(&o.jinja),
        "<main><a class=\"link base extra own\" data-slot=\"btn\" data-variant=\"default\" id=\"mine\" href=\"/login\">Login</a></main>"
    );
}

/// F363a (Afrojack r1): every fail-closed group of `check_poly_component` keeps the caller on React with its own code.
#[test]
fn a_component_child_that_cannot_take_the_props_keeps_the_caller_on_react() {
    for (body, rule) in [
        // a job or `useId` of its own
        ("<Btn asChild><Fed>x</Fed></Btn>", "slot-child-component"),
        // a requirement on the props it is given (`asChild` handed on to a polymorphic component)
        (
            "<Btn asChild><Carry>x</Carry></Btn>",
            "slot-child-component",
        ),
        // the element replaced carries `dangerouslySetInnerHTML`
        ("<Dsi asChild><Link>x</Link></Dsi>", "slot-child-component"),
        // the child is given a ref
        ("<Btn asChild><Link ref={r}>x</Link></Btn>", "slot-ref"),
        // a class (or style) that would merge with keys known only at render
        (
            "<Bag asChild><Link className=\"c\">x</Link></Bag>",
            "slot-merge",
        ),
    ] {
        let o = lower("P.tsx", &page(body));
        assert!(react_with(&o, rule), "{body}: {:?}", o.diags);
    }
    // the page's own forwarded ref handed to the child
    let src = std::fs::read_to_string(
        repo().join("crates/brust-compiler/tests/fixtures/slot/FwdPage.tsx"),
    )
    .unwrap();
    let o = lower("FwdPage.tsx", &src);
    assert!(react_with(&o, "slot-child-component"), "{:?}", o.diags);
    // a prop that changes on the client
    let o = lower(
        "P.tsx",
        "import { useState } from 'react'\nimport Btn from './Btn'\nimport Link from './Link'\nexport default function P() { const [n, setN] = useState(0); return <main><button onClick={() => setN(n + 1)}>+</button><Btn asChild><Link data-n={n}>x</Link></Btn></main> }",
    );
    assert!(react_with(&o, "slot-child-attr"), "{:?}", o.diags);
}

/// F363a (Afrojack r1): a child prop that is `undefined` overrides the Slot's value (`mergeProps` / `cloneElement` keep an
/// explicit `undefined`), so the attribute is not printed.
#[test]
fn an_undefined_child_prop_overrides_the_slots() {
    let o = lower(
        "P.tsx",
        &page("<Btn asChild id=\"slot\"><Link id={undefined} href=\"/x\">x</Link></Btn>"),
    );
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    let html = render(&o.jinja);
    assert!(!html.contains("id="), "{html}");
    assert!(html.contains("href=\"/x\""), "{html}");
}

/// F369a (Mellow F2, F3): a component that hands its whole rest to its one polymorphic child is polymorphic itself; the
/// Slot replaces that child's element at the carrier's call site.
#[test]
fn a_carrier_of_the_flag_resolves_it_at_its_call_site() {
    for body in [
        "<Carrier asChild><b id=\"i\">x</b></Carrier>",
        "<Carrier2 asChild><b id=\"i\">x</b></Carrier2>",
    ] {
        let o = lower("P.tsx", &page(body));
        assert_eq!(o.tier, Tier::Static, "{body}: {:?}", o.diags);
        let html = render(&o.jinja);
        // React: Slot clones the <b> with the Chip element's attributes (data-slot, the carriers' data-*)
        assert!(html.starts_with("<main><b "), "{body}: {html}");
        assert!(!html.contains("<span"), "{body}: {html}");
        for a in [
            "data-slot=\"chip\"",
            "data-tone=\"a\"",
            "id=\"i\"",
            ">x</b>",
        ] {
            assert!(html.contains(a), "{body}: {a} in {html}");
        }
    }
    // without the flag the host element prints, through the carrier
    let o = lower("P.tsx", &page("<Carrier2>t</Carrier2>"));
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    let html = render(&o.jinja);
    assert!(html.starts_with("<main><span "), "{html}");
    assert!(
        html.contains("data-size=\"m\"") && html.contains(">t</span>"),
        "{html}"
    );
    // a component child goes through the carrier too (the Slot element's attributes are seen after inlining)
    let o = lower(
        "P.tsx",
        &page("<Carrier asChild className=\"x\"><Link href=\"/g\">Go</Link></Carrier>"),
    );
    assert_eq!(o.tier, Tier::Static, "{:?}", o.diags);
    let html = render(&o.jinja);
    assert!(
        html.contains("<a ") && html.contains("data-slot=\"chip\"") && html.contains("href=\"/g\""),
        "{html}"
    );
}

/// F369a: every way the flag could fail to reach the element unchanged keeps the old requirement (`slot-dynamic`).
#[test]
fn a_component_that_may_not_carry_the_flag_is_not_polymorphic() {
    for (src, id, why) in [
        (
            "<CarrierIf asChild on><b>x</b></CarrierIf>",
            "carrierIf_",
            "(a) conditional",
        ),
        (
            "<CarrierTwo asChild><b>x</b></CarrierTwo>",
            "carrierTwo_",
            "(a) two children",
        ),
        (
            "<CarrierPath asChild><b>x</b></CarrierPath>",
            "carrierPath_",
            "(b) a path, not the rest",
        ),
        (
            "<CarrierNamed asChild><b>x</b></CarrierNamed>",
            "carrierNamed_",
            "(b) the flag is a named prop",
        ),
        (
            "<CarrierOver asChild><b>x</b></CarrierOver>",
            "carrierOver_",
            "(c) the flag written after",
        ),
        (
            "<CarrierLoop asChild items={['a']}><b>x</b></CarrierLoop>",
            "carrierLoop_",
            "(a) in a list",
        ),
        (
            "<CarrierBag asChild><b>x</b></CarrierBag>",
            "carrierBag_",
            "the element spreads keys known only at render",
        ),
        (
            "<CarrierKids asChild><b>x</b></CarrierKids>",
            "carrierKids_",
            "the polymorphic child has children of its own",
        ),
        (
            "<CarrierEm asChild><b>x</b></CarrierEm>",
            "carrierEm_",
            "a second consumer of the rest",
        ),
    ] {
        assert!(!is_poly("P.tsx", &page(src), id), "{why}");
        // and the call keeps today's answer: a literal flag the component cannot hand on is refused or harmless, never
        // resolved as a Slot
        let o = lower("P.tsx", &page(src));
        assert!(!codes(&o).contains(&"lower-shape"), "{why}: {:?}", o.diags);
        if id == "carrierKids_" || id == "carrierEm_" {
            // React clones a different element than the caller's <b> here: the page must stay React
            assert!(react_with(&o, "slot-dynamic"), "{why}: {:?}", o.diags);
        }
    }
    // the ones that DO carry it (a read of the flag itself inside a carrier is allowed on purpose)
    assert!(is_poly(
        "P.tsx",
        &page("<CarrierFlagRead asChild><b>x</b></CarrierFlagRead>"),
        "carrierFlagRead_"
    ));
    for id in ["carrier_", "carrier2_"] {
        assert!(
            is_poly("P.tsx", &page("<Carrier2 asChild><b>x</b></Carrier2>"), id),
            "{id}"
        );
    }
    // callers that spread keys known only at render keep F153c
    let o = lower(
        "P.tsx",
        "import Carrier from './Carrier'\nexport default function P(props: any) { return <main><Carrier {...props.attrs}>x</Carrier></main> }",
    );
    assert!(react_with(&o, "slot-dynamic"), "{:?}", o.diags);
}

#[test]
fn a_native_parent_with_as_child_over_a_host_element_is_cloned_with_the_child() {
    // F369b step A: the parent has state and a handler on its polymorphic element; the call's one child becomes the
    // content of a host clone, whose own polymorphic element is the child.
    let o = lower(
        "P.tsx",
        &page("<ItemLike asChild><a href=\"/x\">go</a></ItemLike>"),
    );
    assert!(!react_with(&o, "slot-native"), "{:?}", o.diags);
    assert!(!matches!(o.tier, Tier::React { .. }), "{:?}", o.diags);
}

#[test]
fn a_native_parent_clone_refuses_what_the_merge_cannot_join() {
    // F369b: a class or style on the child would be joined with the element's, a handler or text/expression child is
    // not a plain host element: each keeps the caller on React with the original refusal.
    for body in [
        "<ItemLike asChild><a className=\"c\">x</a></ItemLike>",
        "<ItemLike asChild><a style={{ color: 'red' }}>x</a></ItemLike>",
        "<ItemLike asChild><a onClick={() => {}}>x</a></ItemLike>",
        "<ItemLike asChild>text</ItemLike>",
        "<ItemLike asChild><a>x</a><b>y</b></ItemLike>",
    ] {
        let o = lower("P.tsx", &page(body));
        assert!(
            matches!(o.tier, Tier::React { .. }),
            "{body}: {:?}",
            o.diags
        );
    }
}

fn native_page(body: &str) -> String {
    format!(
        "import {{ useState }} from 'react'\nimport Pressable from './Pressable'\nimport ReadsKey from './ReadsKey'\nimport ItemMouse from './ItemMouse'\nexport default function P() {{ const [c, setC] = useState(0); return <main>{body}<b>{{c}}</b></main> }}"
    )
}

#[test]
fn a_handler_landing_in_a_native_childs_rest_is_bound_by_its_element() {
    // F369c: `onMouseDown` reaches Pressable's <button> through `{...props}`; the element binds the prop itself and the
    // function travels in the linked props.
    let o = lower(
        "P.tsx",
        &native_page("<Pressable id=\"p\" onMouseDown={() => setC(c + 1)}>go</Pressable>"),
    );
    assert!(!matches!(o.tier, Tier::React { .. }), "{:?}", o.diags);
    assert!(
        o.jinja.contains("x-prop-on-mousedown=\"onMouseDown\""),
        "{}",
        o.jinja
    );
    assert!(o.jinja.contains("x-props-bind"), "{}", o.jinja);
}

#[test]
fn a_handler_the_native_child_binds_on_the_same_event_keeps_react() {
    // The child's own onClick and the caller's would both run: the order is not proven, so the caller stays on React.
    let o = lower(
        "P.tsx",
        &native_page("<Pressable onClick={() => setC(c + 1)}>go</Pressable>"),
    );
    assert!(react_with(&o, "spread-handler"), "{:?}", o.diags);
}

#[test]
fn a_handler_the_native_child_also_reads_by_name_keeps_react() {
    let o = lower(
        "P.tsx",
        &native_page("<ReadsKey onMouseDown={() => setC(c + 1)} />"),
    );
    assert!(react_with(&o, "spread-handler"), "{:?}", o.diags);
}

#[test]
fn a_handler_that_is_not_an_allowed_event_keeps_react() {
    // `onScroll` is a plain [a-z0-9]+ event, `onCompositionStart`-style names are too, but a capture handler is never bound.
    let o = lower(
        "P.tsx",
        &native_page("<Pressable onMouseDownCapture={() => setC(c + 1)}>go</Pressable>"),
    );
    assert!(matches!(o.tier, Tier::React { .. }), "{:?}", o.diags);
}

#[test]
fn a_native_parent_with_as_child_over_a_native_component_is_cloned_with_the_child() {
    // F369b step B on F369c: the element's handler reaches the child component as a prop and its element binds it.
    let o = lower(
        "P.tsx",
        &page("<ItemMouse asChild><Pressable id=\"p\">go</Pressable></ItemMouse>"),
    );
    assert!(!matches!(o.tier, Tier::React { .. }), "{:?}", o.diags);
    assert!(o.jinja.contains("x-prop-on-mousedown"), "{}", o.jinja);
}

#[test]
fn a_native_parent_handler_on_the_childs_own_event_keeps_react() {
    // ItemLike binds click and Pressable binds click: not proven, so React.
    let o = lower(
        "P.tsx",
        &page("<ItemLike asChild><Pressable id=\"p\">go</Pressable></ItemLike>"),
    );
    assert!(matches!(o.tier, Tier::React { .. }), "{:?}", o.diags);
}

#[test]
fn an_event_react_has_no_prop_for_keeps_react() {
    // `onPick` passes handler_key_ok (a plain event name) but React never listens to a `pick` event.
    let o = lower(
        "P.tsx",
        &native_page("<Pressable onPick={() => setC(c + 1)}>go</Pressable>"),
    );
    assert!(react_with(&o, "spread-handler"), "{:?}", o.diags);
}

#[test]
fn an_on_change_through_a_native_childs_rest_listens_to_input_on_a_text_field() {
    // Mellow F1: every handler path maps React's `onChange` on a text field to the DOM `input` event.
    let src = "import { useState } from 'react'\nimport Field from './Field'\nexport default function P() { const [v, setV] = useState(''); return <main><Field onChange={(e: any) => setV(e.target.value)} /><b>{v}</b></main> }";
    let o = lower("P.tsx", src);
    assert!(!matches!(o.tier, Tier::React { .. }), "{:?}", o.diags);
    assert!(
        o.jinja.contains("x-prop-on-input=\"onChange\""),
        "{}",
        o.jinja
    );
    assert!(!o.jinja.contains("x-prop-on-change"), "{}", o.jinja);
}
