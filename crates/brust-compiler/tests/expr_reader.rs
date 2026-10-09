//! RawExpr reader: identifier kinds come from symbols, shapes map 1:1 onto the
//! §6.2 grammar, everything else is Opaque with printed source.
use brust_compiler::analyze::component::debug_first_slot;
use brust_compiler::ir::expr::*;
use brust_compiler::parse::{parse_tsx, run_on_compiler_thread};

fn slot(body: &str) -> RawExpr {
    let src = format!(
        "import {{ fmt }} from './money'\nimport {{ useState }} from 'react'\nexport default function C({{ a, b }}: any) {{ const [n, setN] = useState(1); const x = a + 1; return <p>{{{body}}}</p> }}\n"
    );
    run_on_compiler_thread(move || {
        let parsed = parse_tsx("C.tsx", src.into_bytes()).unwrap();
        debug_first_slot(&parsed).expect("slot")
    })
}

fn ident(e: &RawExpr) -> (&str, &IdentKind) {
    match &e.kind {
        RawKind::Ident { name, kind } => (name, kind),
        k => panic!("{k:?}"),
    }
}

#[test]
fn prop_local_state_import_global_kinds() {
    assert_eq!(ident(&slot("a")), ("a", &IdentKind::Prop));
    assert_eq!(ident(&slot("x")), ("x", &IdentKind::Local));
    assert_eq!(ident(&slot("n")), ("n", &IdentKind::State));
    assert_eq!(ident(&slot("setN")), ("setN", &IdentKind::Setter));
    assert_eq!(
        ident(&slot("fmt")),
        (
            "fmt",
            &IdentKind::Import {
                source: "./money".into(),
                imported: "fmt".into()
            }
        )
    );
    assert_eq!(ident(&slot("window")), ("window", &IdentKind::Global));
}

#[test]
fn member_binary_cond_template() {
    match slot("a.b.c").kind {
        RawKind::Member { name, .. } => assert_eq!(name, "c"),
        k => panic!("{k:?}"),
    }
    match slot("a === 1 ? 'x' : b").kind {
        RawKind::Cond { test, .. } => assert!(matches!(
            test.kind,
            RawKind::Binary {
                op: BinOp::StrictEq,
                ..
            }
        )),
        k => panic!("{k:?}"),
    }
    match slot("`hi ${a}!`").kind {
        RawKind::Template { head, parts } => {
            assert_eq!(head, "hi ");
            assert_eq!(parts[0].1, "!")
        }
        k => panic!("{k:?}"),
    }
}

#[test]
fn calls_and_opaque() {
    match slot("fmt(a.price)").kind {
        RawKind::Call { callee, args } => {
            assert!(matches!(callee.kind, RawKind::Ident { .. }));
            assert_eq!(args.len(), 1)
        }
        k => panic!("{k:?}"),
    }
    match slot("a.map(i => i.n)").kind {
        RawKind::Call { callee, args } => {
            assert!(matches!(callee.kind, RawKind::Member { .. }));
            assert!(matches!(args[0].kind, RawKind::Arrow { .. }))
        }
        k => panic!("{k:?}"),
    }
    match slot("new Date(a)").kind {
        RawKind::Opaque { source, why, .. } => {
            assert!(source.contains("Date"), "{source}");
            assert!(!why.is_empty())
        }
        k => panic!("{k:?}"),
    }
}

#[test]
fn shadowed_hook_name_is_local_not_import() {
    let src = "export default function C() { const useState = (v: number) => [v, () => {}]; const [n] = useState(1); return <p>{n}</p> }\n";
    let e = run_on_compiler_thread(move || {
        let p = parse_tsx("S.tsx", src.as_bytes().to_vec()).unwrap();
        debug_first_slot(&p).unwrap()
    });
    // Not State: `useState` here is a local, not the react import.
    assert_eq!(ident(&e), ("n", &IdentKind::Local));
}

#[test]
fn shadowed_global_param_is_a_prop() {
    let src = "export default function W({ window }: any) { return <p>{window}</p> }\n";
    let e = run_on_compiler_thread(move || {
        let p = parse_tsx("W.tsx", src.as_bytes().to_vec()).unwrap();
        debug_first_slot(&p).unwrap()
    });
    assert_eq!(ident(&e), ("window", &IdentKind::Prop));
}

#[test]
fn props_member_on_plain_param_is_a_prop() {
    let src = "export default function P(props: any) { return <p>{props.title}</p> }\n";
    let e = run_on_compiler_thread(move || {
        let p = parse_tsx("P.tsx", src.as_bytes().to_vec()).unwrap();
        debug_first_slot(&p).unwrap()
    });
    assert_eq!(ident(&e), ("title", &IdentKind::Prop));
}

#[test]
fn arrow_captures() {
    match slot("() => setN(n + a)").kind {
        RawKind::Arrow {
            params, captures, ..
        } => {
            assert!(params.is_empty());
            let names: Vec<_> = captures.iter().map(|c| c.0.as_str()).collect();
            assert!(
                names.contains(&"setN") && names.contains(&"n") && names.contains(&"a"),
                "{names:?}"
            )
        }
        k => panic!("{k:?}"),
    }
}

#[test]
fn arrow_params_are_not_captures() {
    match slot("(i: any) => i.n + b").kind {
        RawKind::Arrow {
            params,
            captures,
            body,
        } => {
            assert_eq!(params, ["i"]);
            let names: Vec<_> = captures.iter().map(|c| c.0.as_str()).collect();
            assert_eq!(names, ["b"]);
            assert!(matches!(body, ArrowBody::Expr(_)));
        }
        k => panic!("{k:?}"),
    }
}

#[test]
fn operators_outside_the_grammar_are_opaque() {
    for src in ["a ** 2", "a in b", "a | 1", "(a, b)", "-a", "!a"] {
        let e = slot(src);
        match (src, &e.kind) {
            ("-a", RawKind::Unary { op: UnOp::Neg, .. }) => {}
            ("!a", RawKind::Unary { op: UnOp::Not, .. }) => {}
            (_, RawKind::Opaque { why, source, .. }) if !src.starts_with(['-', '!']) => {
                assert!(
                    !why.is_empty() && !source.is_empty(),
                    "{src}: {why} {source}"
                )
            }
            (_, k) => panic!("{src}: {k:?}"),
        }
    }
}

/// M1b-2 ruling R6: an Opaque carries what it reads, like an arrow.
#[test]
fn opaque_carries_captures() {
    let RawKind::Opaque { captures, .. } = slot("new Intl.NumberFormat(a, n)").kind else {
        panic!()
    };
    let names: Vec<_> = captures.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, ["Intl", "a", "n"]);
    assert!(captures.contains(&("a".into(), IdentKind::Prop)));
    assert!(captures.contains(&("n".into(), IdentKind::State)));
}

/// F14: the generated JSX runtime binding is not a capture; ruling 1: a block
/// body that builds JSX is an Opaque marked `contains-jsx`.
#[test]
fn jsx_runtime_is_not_captured_and_block_jsx_is_marked() {
    let RawKind::Arrow { captures, .. } = slot("() => <b>{a}</b>").kind else {
        panic!()
    };
    assert_eq!(captures, [("a".to_string(), IdentKind::Prop)]);
    let RawKind::Opaque { why, captures, .. } =
        slot("() => { const y = a; return <b>{y}</b> }").kind
    else {
        panic!()
    };
    assert_eq!(why, "contains-jsx");
    assert_eq!(captures, [("a".to_string(), IdentKind::Prop)]);
}

/// F20: the whole non-destructured props object is the prop root `*`.
#[test]
fn bare_props_object_is_prop_root() {
    let src = "export default function C(props: any) { return <p>{props}</p> }\n";
    let e = run_on_compiler_thread(move || {
        let parsed = parse_tsx("C.tsx", src.as_bytes().to_vec()).unwrap();
        debug_first_slot(&parsed).expect("slot")
    });
    assert_eq!(ident(&e), ("*", &IdentKind::Prop));
}
