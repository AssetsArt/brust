//! L23: lucide icons rendered at build time and inlined as SVG.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use std::collections::HashMap;

fn analyze(src: &str, svgs: HashMap<String, String>, fin: bool) -> ComponentIR {
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
    svgs.insert(key, HEART.to_string());
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
    assert!(
        matches!(&class.unwrap().kind, RawKind::Template { head, .. } if head == "lucide lucide-heart ")
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
    svgs.insert(r.key.clone(), HEART.to_string());
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
