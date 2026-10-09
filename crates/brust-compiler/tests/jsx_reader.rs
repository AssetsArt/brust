//! JSX reader: lowered `jsx`/`jsxs` calls back into template nodes.
use brust_compiler::analyze::component::debug_template;
use brust_compiler::ir::expr::*;
use brust_compiler::ir::template::*;
use brust_compiler::ir::{DiagClass, Diagnostic};
use brust_compiler::parse::{parse_tsx, run_on_compiler_thread};

fn tpl(src: &str) -> (Node, Vec<Diagnostic>) {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        let p = parse_tsx("T.tsx", s.into_bytes()).unwrap();
        debug_template(&p)
    })
}

#[test]
fn element_attrs_text_and_slot() {
    let (n, d) = tpl(
        "export default function T({ name }: any) { return <a href=\"/docs\" className={`x ${name}`} data-n={3} aria-label=\"d\">Hi, {name}!</a> }",
    );
    assert!(d.is_empty(), "{d:?}");
    let Node::Element {
        tag,
        attrs,
        children,
        host,
        ..
    } = n
    else {
        panic!("{n:?}")
    };
    assert_eq!(tag, "a");
    assert!(host);
    assert!(
        matches!(&attrs[0], Attr::Static { name, value } if name == "href" && value == "/docs")
    );
    assert!(matches!(&attrs[1], Attr::Dynamic { name, .. } if name == "className"));
    assert!(matches!(&attrs[2], Attr::Dynamic { name, .. } if name == "data-n"));
    assert!(
        matches!(&attrs[3], Attr::Static { name, value } if name == "aria-label" && value == "d")
    );
    assert_eq!(children.len(), 3);
    assert!(matches!(&children[0], Node::Text(t) if t == "Hi, "));
    assert!(matches!(&children[1], Node::Slot(_)));
    assert!(matches!(&children[2], Node::Text(t) if t == "!"));
}

#[test]
fn whitespace_rules_and_entities() {
    let (n, _) =
        tpl("export default function T() { return <p>\n    a&nbsp;b{' '}\n    <b>c</b>\n  </p> }");
    let Node::Element { children, .. } = n else {
        panic!()
    };
    assert!(matches!(&children[0], Node::Text(t) if t == "a\u{a0}b"));
    assert!(matches!(&children[1], Node::Text(t) if t == " "));
    assert!(matches!(&children[2], Node::Element { tag, .. } if tag == "b"));
    assert_eq!(children.len(), 3);
}

#[test]
fn multiline_text_collapses_like_react() {
    let (n, _) =
        tpl("export default function T() { return <p>\n  one\n    two   three\n\n  four\n</p> }");
    let Node::Element { children, .. } = n else {
        panic!()
    };
    assert_eq!(children, [Node::Text("one two   three four".into())]);
}

#[test]
fn null_false_undefined_children_are_dropped() {
    let (n, _) = tpl(
        "export default function T({ x }: any) { return <p>{x}{null}{false}{undefined}{true}</p> }",
    );
    let Node::Element { children, .. } = n else {
        panic!()
    };
    assert_eq!(children.len(), 1);
    assert!(matches!(&children[0], Node::Slot(_)));
}

#[test]
fn conditionals_lists_and_keys() {
    let (n, d) = tpl(
        "export default function T({ items, show }: any) { return <ul>{show && <li>s</li>}{show ? <li>a</li> : <li>b</li>}{items.map((it: any, i: number) => <li key={it.id}>{it.name}</li>)}</ul> }",
    );
    assert!(d.is_empty(), "{d:?}");
    let Node::Element { children, .. } = n else {
        panic!()
    };
    assert!(matches!(&children[0], Node::If { else_, .. } if else_.is_empty()));
    assert!(matches!(&children[1], Node::If { else_, .. } if !else_.is_empty()));
    let Node::For {
        item,
        index,
        key,
        body,
        ..
    } = &children[2]
    else {
        panic!("{:?}", children[2])
    };
    assert_eq!(item, "it");
    assert_eq!(index.as_deref(), Some("i"));
    assert!(
        matches!(key, Expr::Raw(RawExpr { kind: RawKind::Member { name, .. }, .. }) if name == "id")
    );
    assert!(matches!(&body[0], Node::Element { tag, .. } if tag == "li"));
    // The item binding reads as a loop binding inside the body only.
    let Node::Element { children: li, .. } = &body[0] else {
        panic!()
    };
    let Node::Slot(Expr::Raw(RawExpr {
        kind: RawKind::Member { target, .. },
        ..
    })) = &li[0]
    else {
        panic!("{li:?}")
    };
    assert!(matches!(
        &target.kind,
        RawKind::Ident {
            kind: IdentKind::LoopBinding,
            ..
        }
    ));
}

#[test]
fn ternary_with_one_text_arm_keeps_both_arms() {
    let (n, _) = tpl("export default function T({ x }: any) { return <p>{x ? <i/> : 'none'}</p> }");
    let Node::Element { children, .. } = n else {
        panic!()
    };
    assert!(
        matches!(&children[0], Node::If { then, else_, .. } if matches!(&then[0], Node::Element { .. }) && matches!(&else_[0], Node::Text(t) if t == "none"))
    );
}

#[test]
fn missing_key_is_an_error() {
    let (_, d) = tpl(
        "export default function T({ items }: any) { return <ul>{items.map((it: any) => <li>{it}</li>)}</ul> }",
    );
    assert!(
        d.iter()
            .any(|x| x.rule == "list-key" && matches!(x.class, DiagClass::Error))
    );
}

#[test]
fn components_fragments_events_refs_spread() {
    let (n, d) = tpl(
        "import Child from './Child'\nimport { useRef } from 'react'\nexport default function T({ rest }: any) { const r = useRef(null); return <><Child n={1} onPick={() => 0}>x</Child><input ref={r} onChange={(e: any) => 0} {...rest} /></> }",
    );
    let Node::Fragment(kids) = n else {
        panic!("{n:?}")
    };
    assert!(
        matches!(&kids[0], Node::Component { name, source, props, children, .. } if name == "Child" && source.as_deref() == Some("./Child") && props.len() == 2 && children.len() == 1)
    );
    let Node::Element {
        attrs, ref_name, ..
    } = &kids[1]
    else {
        panic!()
    };
    assert_eq!(ref_name.as_deref(), Some("r"));
    assert!(
        attrs
            .iter()
            .any(|a| matches!(a, Attr::Event { event, .. } if event == "change"))
    );
    assert!(attrs.iter().any(|a| matches!(
        a,
        Attr::Spread(Expr::Raw(RawExpr {
            kind: RawKind::Opaque { .. },
            ..
        }))
    )));
    assert!(d.iter().any(|x| x.rule == "spread-props"));
}

#[test]
fn explicit_children_prop_is_diagnosed_not_dropped() {
    let (n, d) = tpl("export default function T({ x }: any) { return <div children={x} /> }");
    assert!(d.iter().any(|x| x.rule == "children-prop"), "{d:?}");
    let Node::Element { attrs, .. } = n else {
        panic!()
    };
    assert!(matches!(&attrs[0], Attr::Dynamic { name, .. } if name == "children"));
}

#[test]
fn member_tags_and_inner_html_are_diagnosed() {
    let (_, d) = tpl(
        "import * as M from './m'\nexport default function T({ h }: any) { return <div dangerouslySetInnerHTML={h}><M.X/></div> }",
    );
    assert!(
        d.iter()
            .any(|x| x.rule == "no-innerhtml" && matches!(x.class, DiagClass::Error))
    );
    assert!(
        d.iter()
            .any(|x| x.rule == "member-tag" && matches!(x.class, DiagClass::Fallback))
    );
}

#[test]
fn imported_fragment_and_boolean_attr() {
    let (n, _) = tpl(
        "import { Fragment } from 'react'\nexport default function T() { return <Fragment><input disabled /></Fragment> }",
    );
    let Node::Fragment(kids) = n else {
        panic!("{n:?}")
    };
    assert!(
        matches!(&kids[0], Node::Element { attrs, .. } if matches!(&attrs[0], Attr::Static { name, value } if name == "disabled" && value.is_empty()))
    );
}

/// F15: a keyed `.map` body is a list body in any position, not only as a
/// direct child.
#[test]
fn keyed_map_body_outside_children_does_not_warn() {
    for src in [
        "export default function T({ xs }: any) { return <ul>{wrap(xs.map((x: any) => <li key={x}>{x}</li>))}</ul> }",
        "export default function T({ xs }: any) { return <C items={xs.map((x: any) => <li key={x}/>)} /> }",
    ] {
        let (_, d) = tpl(src);
        assert!(
            d.iter().all(|d| d.rule != "key-outside-list"),
            "{src}: {d:?}"
        );
    }
    let (_, d) = tpl("export default function T() { return <ul><li key=\"a\"/></ul> }");
    assert!(d.iter().any(|d| d.rule == "key-outside-list"), "{d:?}");
}

/// F16: React's synthetic events that differ from the DOM name.
#[test]
fn react_event_names_map_to_dom_events() {
    let (n, d) = tpl(
        "export default function T({ f }: any) { return <div onDoubleClick={f} onFocus={f} onBlur={f} onMouseEnter={f} onChange={f} /> }",
    );
    assert!(d.is_empty(), "{d:?}");
    let Node::Element { attrs, .. } = n else {
        panic!()
    };
    let events: Vec<_> = attrs
        .iter()
        .filter_map(|a| match a {
            Attr::Event { event, .. } => Some(event.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        events,
        ["dblclick", "focusin", "focusout", "mouseenter", "change"]
    );
    let (_, d) = tpl("export default function T({ f }: any) { return <div onClickCapture={f} /> }");
    assert!(
        d.iter()
            .any(|d| d.rule == "event-capture" && d.class == DiagClass::Fallback)
    );
}
