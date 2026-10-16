//! L23: lucide icons rendered at build time and inlined as SVG.
use brust_compiler::analyze::component::{AnalyzeOptions, IconMarkup, analyze_source};
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use std::collections::HashMap;

fn analyze(src: &str, svgs: HashMap<String, IconMarkup>, fin: bool) -> ComponentIR {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        analyze_source(
            "C.tsx",
            s.into_bytes(),
            &AnalyzeOptions {
                icon_svgs: svgs,
                icons_final: fin,
                ..Default::default()
            },
        )
        .unwrap()
    })
}

const HEART: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"__BRUST_ICON_size__\" height=\"__BRUST_ICON_size__\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" class=\"lucide lucide-heart __BRUST_ICON_className__\" aria-hidden=\"true\"><path d=\"M2 9&amp;5\"></path></svg>";

/// The markup with sentinels and the one React renders for `undefined` props.
fn markup() -> IconMarkup {
    IconMarkup {
        svg: HEART.to_string(),
        base: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" class=\"lucide lucide-heart\" aria-hidden=\"true\"><path d=\"M2 9&amp;5\"></path></svg>".to_string(),
    }
}

fn elements(n: &Node, out: &mut Vec<(String, Vec<Attr>)>) {
    match n {
        Node::Element {
            tag,
            attrs,
            children,
            ..
        } => {
            out.push((tag.clone(), attrs.clone()));
            children.iter().for_each(|c| elements(c, out));
        }
        Node::Fragment(cs) => cs.iter().for_each(|c| elements(c, out)),
        Node::If { then, else_, .. } => then.iter().chain(else_).for_each(|c| elements(c, out)),
        Node::For { body, .. } => body.iter().for_each(|c| elements(c, out)),
        _ => {}
    }
}

#[test]
fn the_first_compile_records_a_request_and_keeps_the_component() {
    let ir = analyze(
        "import { Heart } from 'lucide-react'\nexport default function C({ n }: any) { return <p><Heart size={n} color=\"red\" className=\"x\" /></p> }",
        HashMap::new(),
        false,
    );
    assert_eq!(ir.icon_requests.len(), 1, "{:?}", ir.diagnostics);
    let r = &ir.icon_requests[0];
    assert_eq!(
        (r.source.as_str(), r.export.as_str()),
        ("lucide-react", "Heart")
    );
    assert_eq!(r.props.get("color"), Some(&serde_json::json!("red")));
    assert_eq!(r.props.get("className"), Some(&serde_json::json!("x")));
    assert_eq!(r.dynamic, vec!["size".to_string()]);
    assert!(r.key.starts_with("C.tsx@"));
    assert!(
        ir.diagnostics.iter().all(|d| d.class != DiagClass::Error),
        "{:?}",
        ir.diagnostics
    );
}

#[test]
fn a_rendered_icon_becomes_elements_with_dynamic_attributes() {
    let src = "import { Heart } from 'lucide-react'\nexport default function C({ n, tone }: any) { return <p><Heart size={n} className={tone} /></p> }";
    let key = analyze(src, HashMap::new(), false).icon_requests[0]
        .key
        .clone();
    let mut svgs = HashMap::new();
    svgs.insert(key, markup());
    let ir = analyze(src, svgs, true);
    assert!(ir.icon_requests.is_empty());
    assert!(ir.jobs.is_empty() && !ir.needs_worker, "{:?}", ir.jobs);
    assert!(matches!(ir.tier, Tier::Static), "{:?}", ir.tier);
    let mut els = Vec::new();
    elements(&ir.template, &mut els);
    let svg = els.iter().find(|e| e.0 == "svg").expect("an <svg>");
    let dyn_names: Vec<&str> = svg
        .1
        .iter()
        .filter_map(|a| match a {
            Attr::Dynamic { name, .. } => Some(name.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        dyn_names,
        vec!["width", "height", "className"],
        "{:?}",
        svg.1
    );
    // the static attributes keep their values and order; entities are decoded
    assert!(svg.1.iter().any(
        |a| matches!(a, Attr::Static { name, value } if name == "viewBox" && value == "0 0 24 24")
    ));
    let path = els.iter().find(|e| e.0 == "path").unwrap();
    assert!(
        path.1
            .iter()
            .any(|a| matches!(a, Attr::Static { name, value } if name == "d" && value == "M2 9&5"))
    );
    // the class attribute is a template over the prop: "lucide lucide-heart " + className
    let class = svg.1.iter().find_map(|a| match a {
        Attr::Dynamic {
            name,
            value: Expr::Raw(r) | Expr::Server(ServerExpr(r)),
        } if name == "className" => Some(r),
        _ => None,
    });
    // an absent className renders React's default string, a present one the template
    let RawKind::Cond { yes, no, .. } = &class.unwrap().kind else {
        panic!("className is a conditional: {class:?}")
    };
    assert!(matches!(&yes.kind, RawKind::Template { head, .. } if head == "lucide lucide-heart "));
    assert!(matches!(&no.kind, RawKind::Lit(Literal::Str(s)) if s == "lucide lucide-heart"));
    // width / height / stroke fall back to React's defaults: `prop ?? "24"`
    let width = svg.1.iter().find_map(|a| match a {
        Attr::Dynamic {
            name,
            value: Expr::Raw(r) | Expr::Server(ServerExpr(r)),
        } if name == "width" => Some(r),
        _ => None,
    });
    assert!(
        matches!(&width.unwrap().kind, RawKind::Binary { op: BinOp::Nullish, right, .. } if matches!(&right.kind, RawKind::Lit(Literal::Str(s)) if s == "24"))
    );
}

#[test]
fn a_prop_that_cannot_be_an_attribute_keeps_the_island_with_a_diagnostic() {
    let ir = analyze(
        "import { Heart } from 'lucide-react'\nexport default function C({ t }: any) { return <p><Heart aria-label={t} /></p> }",
        HashMap::new(),
        false,
    );
    assert!(ir.icon_requests.is_empty());
    let d = ir
        .diagnostics
        .iter()
        .find(|d| d.rule == "icon-dynamic-prop")
        .unwrap();
    assert!(d.message.contains("aria-label"), "{}", d.message);
}

#[test]
fn a_literal_provider_is_applied_and_a_dynamic_one_is_not() {
    let lit = analyze(
        "import { Heart, LucideProvider } from 'lucide-react'\nexport default function C() { return <LucideProvider size={32} color=\"green\"><Heart /></LucideProvider> }",
        HashMap::new(),
        false,
    );
    let r = &lit.icon_requests[0];
    assert_eq!(r.provider.get("size"), Some(&serde_json::json!(32)));
    assert_eq!(r.provider.get("color"), Some(&serde_json::json!("green")));
    // with markup for the icon, the provider disappears from the template
    let mut svgs = HashMap::new();
    svgs.insert(r.key.clone(), markup());
    let done = analyze(
        "import { Heart, LucideProvider } from 'lucide-react'\nexport default function C() { return <LucideProvider size={32} color=\"green\"><Heart /></LucideProvider> }",
        svgs,
        true,
    );
    assert!(
        done.children.iter().all(|c| c.name != "LucideProvider"),
        "{:?}",
        done.children
    );
    let dynp = analyze(
        "import { Heart, LucideProvider } from 'lucide-react'\nexport default function C({ s }: any) { return <LucideProvider size={s}><Heart /></LucideProvider> }",
        HashMap::new(),
        false,
    );
    assert!(dynp.icon_requests.is_empty());
    assert!(
        dynp.diagnostics
            .iter()
            .any(|d| d.rule == "icon-provider-dynamic")
    );
}

#[test]
fn deep_imports_and_other_packages_are_recognised_by_source() {
    let deep = analyze(
        "import Star from 'lucide-react/dist/esm/icons/star.mjs'\nexport default function C() { return <p><Star /></p> }",
        HashMap::new(),
        false,
    );
    assert_eq!(deep.icon_requests.len(), 1);
    assert_eq!(deep.icon_requests[0].export, "default");
    let other = analyze(
        "import { Heart } from 'other-icons'\nexport default function C() { return <p><Heart /></p> }",
        HashMap::new(),
        false,
    );
    assert!(other.icon_requests.is_empty());
}

/// R34.77: `{...props}` on an icon lands on the inlined `<svg>`, after the icon's own attributes.
#[test]
fn a_rest_spread_on_an_icon_lands_on_the_svg_root() {
    let src = "import { Heart } from 'lucide-react'\nexport default function C({ n, ...rest }: any) { return <p><Heart role=\"status\" {...rest} /></p> }";
    let key = analyze(src, HashMap::new(), false).icon_requests[0]
        .key
        .clone();
    let ir = analyze(src, HashMap::from([(key, markup())]), true);
    assert!(ir.icon_requests.is_empty(), "{:?}", ir.diagnostics);
    assert!(ir.icon_spread);
    let mut els = Vec::new();
    elements(&ir.template, &mut els);
    let svg = els.iter().find(|(t, _)| t == "svg").expect("inlined svg");
    let last = svg.1.last().expect("attrs");
    assert!(
        matches!(last, Attr::Spread(_)),
        "spread must come last: {:?}",
        svg.1
    );
}

/// R34.77: a spread of anything but the component's own props keeps the island.
#[test]
fn a_spread_of_an_unknown_value_on_an_icon_keeps_the_island() {
    let src = "import { Heart } from 'lucide-react'\nfunction make() { return { id: 'a' } }\nconst x = make()\nexport default function C() { return <p><Heart {...x} /></p> }";
    let ir = analyze(src, HashMap::new(), true);
    assert!(!ir.icon_spread);
    assert!(
        ir.diagnostics.iter().any(|d| d.rule == "icon-dynamic-prop"),
        "{:?}",
        ir.diagnostics
    );
}
