//! F288 §3: a module function called with an element value is evaluated as written over React 19's production element
//! shape. Run on the installed `@radix-ui/react-presence` source (`getElementRef`, from its source map) and on shapes
//! the fold must refuse. The differential check against React itself is `scripts/f288/get-element-ref.test.ts`.
use brust_compiler::analyze::element_value::{ElementShape, eval_element_fn};
use brust_compiler::ir::{IdentKind, RawExpr, RawKind};
use brust_compiler::parse::{parse_tsx, run_on_compiler_thread};

/// The TypeScript source of `@radix-ui/react-presence` as published (its source map's `presence.tsx`).
fn presence_source() -> String {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../node_modules/.bun");
    let dir = std::fs::read_dir(&root)
        .unwrap()
        .filter_map(Result::ok)
        .find(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("@radix-ui+react-presence@")
        })
        .expect("@radix-ui/react-presence is installed");
    let map = dir
        .path()
        .join("node_modules/@radix-ui/react-presence/dist/index.mjs.map");
    let map: serde_json::Value = serde_json::from_slice(&std::fs::read(map).unwrap()).unwrap();
    let i = map["sources"]
        .as_array()
        .unwrap()
        .iter()
        .position(|s| s.as_str().unwrap().ends_with("presence.tsx"))
        .unwrap();
    map["sourcesContent"][i].as_str().unwrap().to_string()
}

fn fold(src: String, name: &'static str, shape: ElementShape) -> Result<String, String> {
    run_on_compiler_thread(move || {
        let parsed = parse_tsx("F.tsx", src.into_bytes()).map_err(|e| e.message)?;
        parsed
            .with_ast(|ast| eval_element_fn(ast, name, &shape, 0))
            .map(|e| e.to_js())
    })
}

fn ident(name: &str) -> RawExpr {
    RawExpr {
        loc: 0,
        kind: RawKind::Ident {
            name: name.into(),
            kind: IdentKind::Prop,
        },
    }
}

#[test]
fn get_element_ref_of_the_installed_package_folds_to_the_elements_ref() {
    let src = presence_source();
    // an element with a ref: `props.ref || ref`, where React 19 sets `ref = props.ref ?? null`
    let with = fold(
        src.clone(),
        "getElementRef",
        ElementShape {
            props_ref: Some(ident("r")),
            open_props: true,
        },
    )
    .unwrap();
    assert_eq!(with, "r || (r ?? null)");
    // an element with no ref and props brust knows: `undefined || null`
    let without = fold(
        src.clone(),
        "getElementRef",
        ElementShape {
            props_ref: None,
            open_props: false,
        },
    )
    .unwrap();
    assert_eq!(without, "null");
    // an element with no written ref but a spread among its props: the spread may carry one
    assert!(
        fold(
            src,
            "getElementRef",
            ElementShape {
                props_ref: None,
                open_props: true,
            },
        )
        .is_err()
    );
}

#[test]
fn anything_outside_the_subset_is_refused() {
    let shape = || ElementShape {
        props_ref: Some(ident("r")),
        open_props: false,
    };
    for (src, why) in [
        (
            "function f(e) { return g(e) }\nfunction g(x) { return x }",
            "a call",
        ),
        (
            "function f(e) { if (e.ref) { return 1 } return 2 }",
            "a test of the call site's value",
        ),
        (
            "function f(e) { return e.type.name }",
            "a member of an unknown field",
        ),
        ("function f(e) { for (;;) {} }", "a loop"),
        (
            "function f({ ref }) { return ref }",
            "a destructured parameter",
        ),
        (
            "function f(e) { e.props.ref = null; return e }",
            "a write to the element",
        ),
        (
            "const Object = { getOwnPropertyDescriptor: () => ({ get: 1 }) }\nfunction f(e) { return Object.getOwnPropertyDescriptor(e, 'ref').get }",
            "a local Object",
        ),
    ] {
        assert!(fold(src.into(), "f", shape()).is_err(), "{why}");
    }
}
