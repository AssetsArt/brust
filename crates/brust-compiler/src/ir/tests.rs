use super::expr::*;
use super::template::*;
use super::*;

#[test]
fn component_ir_round_trips_through_json() {
    let mut ir = ComponentIR::new(
        "themeToggle_1a2b3c4d".into(),
        "components/ThemeToggle.tsx".into(),
    );
    ir.state.push(decls::StateDecl {
        name: "mode".into(),
        setter: Some("setMode".into()),
        init: Expr::Raw(RawExpr {
            loc: 10,
            kind: RawKind::Lit(Literal::Str("dark".into())),
        }),
    });
    ir.template = Node::Element {
        loc: 0,
        tag: "button".into(),
        attrs: vec![Attr::Event {
            event: "click".into(),
            handler: "_h1".into(),
        }],
        children: vec![Node::Slot(Expr::Raw(RawExpr {
            loc: 5,
            kind: RawKind::Ident {
                name: "label".into(),
                kind: IdentKind::Local,
            },
        }))],
        host: true,
        ref_name: None,
    };
    ir.diagnostics.push(Diagnostic::warning(
        "fragment-root",
        "wrapped",
        0,
        "return one element",
    ));
    let json = serde_json::to_string_pretty(&ir).unwrap();
    let back: ComponentIR = serde_json::from_str(&json).unwrap();
    assert_eq!(back, ir);
    assert!(json.contains("\"tier\": \"Pending\""));
}

#[test]
fn every_raw_kind_round_trips() {
    let lit = |n: f64| RawExpr {
        loc: 1,
        kind: RawKind::Lit(Literal::Num(n)),
    };
    let kinds = vec![
        RawKind::Lit(Literal::Null),
        RawKind::Member {
            target: Box::new(lit(1.0)),
            name: "x".into(),
            optional: true,
        },
        RawKind::Index {
            target: Box::new(lit(1.0)),
            index: Box::new(lit(2.0)),
        },
        RawKind::Call {
            callee: Box::new(lit(1.0)),
            args: vec![lit(2.0)],
        },
        RawKind::Binary {
            op: BinOp::Nullish,
            left: Box::new(lit(1.0)),
            right: Box::new(lit(2.0)),
        },
        RawKind::Unary {
            op: UnOp::Typeof,
            value: Box::new(lit(1.0)),
        },
        RawKind::Cond {
            test: Box::new(lit(1.0)),
            yes: Box::new(lit(2.0)),
            no: Box::new(lit(3.0)),
        },
        RawKind::Template {
            head: "a".into(),
            parts: vec![(lit(1.0), "b".into())],
        },
        RawKind::Array(vec![lit(1.0)]),
        RawKind::Object(vec![("k".into(), lit(1.0))]),
        RawKind::Arrow {
            params: vec!["i".into()],
            body: ArrowBody::Block {
                source: "{}".into(),
                captures_only: false,
            },
            captures: vec![(
                "fmt".into(),
                IdentKind::Import {
                    source: "./m".into(),
                    imported: "fmt".into(),
                },
            )],
        },
        RawKind::Jsx(Box::new(Node::Fragment(vec![Node::Text("t".into())]))),
        RawKind::Opaque {
            source: "new Date()".into(),
            why: "ENew".into(),
            captures: vec![("Date".into(), IdentKind::Global)],
        },
    ];
    for kind in kinds {
        let e = RawExpr { loc: 7, kind };
        let back: RawExpr = serde_json::from_str(&serde_json::to_string(&e).unwrap()).unwrap();
        assert_eq!(back, e);
    }
}

#[test]
fn line_col_is_one_based() {
    assert_eq!(line_col(b"ab\ncd", 0), (1, 1));
    assert_eq!(line_col(b"ab\ncd", 3), (2, 1));
    assert_eq!(line_col(b"ab\ncd", 4), (2, 2));
}

#[test]
fn component_id_is_camel_stem_and_stable_hex() {
    let id = component_id("components/ThemeToggle.tsx");
    let (name, hex) = id.split_once('_').unwrap();
    assert_eq!(name, "themeToggle");
    assert_eq!(hex.len(), 8);
    assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(id, component_id("components/ThemeToggle.tsx"));
    assert_ne!(id, component_id("other/ThemeToggle.tsx"));
    assert!(component_id("tests/fixtures/product-card/input.tsx").starts_with("input_"));
    assert!(component_id("product-card.tsx").starts_with("productCard_"));
}
