//! shadcn S1 icon-shapes (R34.76-R34.78): `tsconfig` `paths` aliases, a spread onto an inlined icon (the call site may not
//! hand it keys the icon reads itself), and `a ?? <X/>` / `a || <X/>` as conditions.
use brust_compiler::analyze::aliases::PathAlias;
use brust_compiler::analyze::component::{AnalyzeOptions, IconMarkup, analyze_source};
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::collections::HashMap;
use std::path::PathBuf;

fn analyze(src: &str) -> ComponentIR {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        analyze_source("C.tsx", s.into_bytes(), &AnalyzeOptions::default()).unwrap()
    })
}

fn rule<'a>(ir: &'a ComponentIR, r: &str) -> Option<&'a Diagnostic> {
    ir.diagnostics.iter().find(|d| d.rule == r)
}

#[test]
fn nullish_and_or_with_an_element_are_conditions() {
    for op in ["??", "||"] {
        let ir = analyze(&format!(
            "export default function C({{ label }}: any) {{ return <p>{{label {op} <i>none</i>}}</p> }}"
        ));
        assert!(
            rule(&ir, "jsx-expression").is_none(),
            "{op}: {:?}",
            ir.diagnostics
        );
        assert!(
            !matches!(ir.tier, Tier::React { .. }),
            "{op}: {:?}",
            ir.tier
        );
        let Node::Element { children, .. } = &ir.template else {
            panic!("{:?}", ir.template)
        };
        assert!(
            matches!(&children[0], Node::If { .. }),
            "{op}: {children:?}"
        );
    }
}

#[test]
fn only_a_plain_read_qualifies() {
    // A call is read twice (test and slot): not a side-effect-free path.
    let ir = analyze("export default function C({ f }: any) { return <p>{f() ?? <i>x</i>}</p> }");
    assert!(
        rule(&ir, "jsx-expression").is_some(),
        "{:?}",
        ir.diagnostics
    );
    assert!(matches!(ir.tier, Tier::React { .. }));
}

fn tmp_app(name: &str) -> PathBuf {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let d = std::env::temp_dir().join(format!(
        "brust-icon-shapes-{name}-{}-{n}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join("components/ui")).unwrap();
    d
}

fn tree(root: &PathBuf, file: &str, aliases: Vec<PathAlias>) -> Vec<ComponentIR> {
    let (root, file) = (root.clone(), file.to_string());
    run_on_compiler_thread(move || {
        let opts = AnalyzeOptions {
            root,
            path_aliases: aliases,
            ..Default::default()
        };
        compile_tree(&file, None, &opts, "/_brust/client/runtime.js")
            .unwrap()
            .into_iter()
            .map(|l| (*l.ir).clone())
            .collect()
    })
}

fn at_alias() -> Vec<PathAlias> {
    vec![PathAlias {
        pattern: "@/*".into(),
        targets: vec!["*".into()],
    }]
}

#[test]
fn an_alias_import_resolves_to_the_file_it_names() {
    let root = tmp_app("alias");
    std::fs::write(
        root.join("components/ui/badge.tsx"),
        "export function Badge({ n }: { n: number }) { return <b>{n}</b> }\n",
    )
    .unwrap();
    std::fs::write(
        root.join("page.tsx"),
        "import { Badge } from '@/components/ui/badge'\nexport default function P() { return <main><Badge n={1} /></main> }\n",
    )
    .unwrap();
    let all = tree(&root, "page.tsx", at_alias());
    let page = all.iter().find(|i| i.source == "page.tsx").unwrap();
    assert!(
        !matches!(page.tier, Tier::React { .. }),
        "{:?}",
        page.diagnostics
    );
    assert!(
        all.iter().any(|i| i.source == "components/ui/badge.tsx"),
        "the Badge file is compiled"
    );
    assert_eq!(page.alias_imports.len(), 1);
    assert_eq!(page.alias_imports[0].spec, "@/components/ui/badge");
    assert_eq!(page.alias_imports[0].target, "components/ui/badge.tsx");
    // Without the alias the specifier is a package: an island.
    let none = tree(&root, "page.tsx", vec![]);
    let page = none.iter().find(|i| i.source == "page.tsx").unwrap();
    assert!(
        rule(page, "external-component").is_some(),
        "{:?}",
        page.diagnostics
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn an_alias_nested_two_levels_resolves_from_each_importer() {
    let root = tmp_app("nested");
    std::fs::write(
        root.join("components/ui/inner.tsx"),
        "export function Inner() { return <i>in</i> }\n",
    )
    .unwrap();
    std::fs::write(
        root.join("components/ui/outer.tsx"),
        "import { Inner } from '@/components/ui/inner'\nexport function Outer() { return <u><Inner /></u> }\n",
    )
    .unwrap();
    std::fs::write(
        root.join("page.tsx"),
        "import { Outer } from '@/components/ui/outer'\nexport default function P() { return <main><Outer /></main> }\n",
    )
    .unwrap();
    let all = tree(&root, "page.tsx", at_alias());
    assert!(
        all.iter().all(|i| !matches!(i.tier, Tier::React { .. })),
        "{:?}",
        all.iter().map(|i| (&i.source, &i.tier)).collect::<Vec<_>>()
    );
    assert!(all.iter().any(|i| i.source == "components/ui/inner.tsx"));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn aliases_that_name_no_file_or_leave_the_app_stay_packages() {
    let root = tmp_app("miss");
    std::fs::write(
        root.join("page.tsx"),
        "import { Nope } from '@/components/ui/nope'\nexport default function P() { return <main><Nope /></main> }\n",
    )
    .unwrap();
    let all = tree(&root, "page.tsx", at_alias());
    let page = all.iter().find(|i| i.source == "page.tsx").unwrap();
    assert!(
        rule(page, "external-component").is_some(),
        "{:?}",
        page.diagnostics
    );
    assert!(page.alias_imports.is_empty());
    // A pattern with two `*` is not matched.
    let two = tree(
        &root,
        "page.tsx",
        vec![PathAlias {
            pattern: "@/*/x/*".into(),
            targets: vec!["*".into()],
        }],
    );
    assert!(
        two.iter()
            .find(|i| i.source == "page.tsx")
            .unwrap()
            .alias_imports
            .is_empty()
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_target_outside_the_root_is_never_followed() {
    let root = tmp_app("out");
    std::fs::write(
        root.join("page.tsx"),
        "import { X } from '@/x'\nexport default function P() { return <main><X /></main> }\n",
    )
    .unwrap();
    let all = tree(
        &root,
        "page.tsx",
        vec![PathAlias {
            pattern: "@/*".into(),
            targets: vec!["../*".into(), "node_modules/pkg/*".into()],
        }],
    );
    assert!(
        all.iter()
            .find(|i| i.source == "page.tsx")
            .unwrap()
            .alias_imports
            .is_empty()
    );
    let _ = std::fs::remove_dir_all(&root);
}

const HEART_SVG: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" class=\"lucide lucide-heart\"><path d=\"M2 9\"></path></svg>";

fn icon_tree(files: &[(&str, &str)], page: &str) -> Vec<ComponentIR> {
    let root = tmp_app("icon");
    for (n, c) in files {
        std::fs::write(root.join(n), c).unwrap();
    }
    let r = root.clone();
    let p = page.to_string();
    // First compile records the icon request, second compiles with the rendered markup.
    let first = tree(&root, &p, vec![]);
    let mut svgs = HashMap::new();
    for ir in &first {
        for req in &ir.icon_requests {
            svgs.insert(
                req.key.clone(),
                IconMarkup {
                    svg: HEART_SVG.into(),
                    base: HEART_SVG.into(),
                },
            );
        }
    }
    let out = run_on_compiler_thread(move || {
        let opts = AnalyzeOptions {
            root: r,
            icon_svgs: svgs,
            icons_final: true,
            ..Default::default()
        };
        compile_tree(&p, None, &opts, "/_brust/client/runtime.js")
            .unwrap()
            .into_iter()
            .map(|l| (*l.ir).clone())
            .collect()
    });
    let _ = std::fs::remove_dir_all(&root);
    out
}

const SPIN: &str = "import { Heart } from 'lucide-react'\nexport function Spin({ ...props }: any) { return <Heart role=\"status\" {...props} /> }\n";

#[test]
fn a_call_site_may_not_hand_an_icon_spread_a_key_the_icon_reads() {
    for (call, refused) in [
        ("<Spin size={12} />", true),
        ("<Spin className=\"x\" />", true),
        ("<Spin color=\"red\" />", true),
        ("<Spin aria-label=\"next\" />", true),
        ("<Spin aria-hidden=\"false\" />", true),
        ("<Spin role=\"img\" />", true),
        ("<Spin title=\"t\" />", true),
        ("<Spin nonScalingStroke />", true),
        ("<Spin data-x=\"1\" />", false),
    ] {
        let page = format!(
            "import {{ Spin }} from './spin'\nexport default function P() {{ return <main>{call}</main> }}\n"
        );
        let all = icon_tree(&[("spin.tsx", SPIN), ("page.tsx", &page)], "page.tsx");
        let p = all.iter().find(|i| i.source == "page.tsx").unwrap();
        assert_eq!(
            rule(p, "spread-props").is_some(),
            refused,
            "{call}: {:?}",
            p.diagnostics
        );
        assert_eq!(matches!(p.tier, Tier::React { .. }), refused, "{call}");
        let spin = all.iter().find(|i| i.source == "spin.tsx").unwrap();
        assert!(spin.icon_spread, "{call}");
    }
}

#[test]
fn a_spread_of_unknown_keys_into_an_icon_component_is_refused() {
    let page = "import { Spin } from './spin'\nexport default function P(props: any) { return <main><Spin {...props} /></main> }\n";
    let all = icon_tree(&[("spin.tsx", SPIN), ("page.tsx", page)], "page.tsx");
    let p = all.iter().find(|i| i.source == "page.tsx").unwrap();
    assert!(rule(p, "spread-props").is_some(), "{:?}", p.diagnostics);
}

#[test]
fn the_longest_prefix_pattern_wins_as_in_typescript_and_bun() {
    let root = tmp_app("overlap");
    std::fs::create_dir_all(root.join("ui")).unwrap();
    std::fs::create_dir_all(root.join("src/ui")).unwrap();
    std::fs::write(
        root.join("ui/b.tsx"),
        "export function B() { return <i>root</i> }\n",
    )
    .unwrap();
    std::fs::write(
        root.join("src/ui/b.tsx"),
        "export function B() { return <u>src</u> }\n",
    )
    .unwrap();
    std::fs::write(
        root.join("page.tsx"),
        "import { B } from '@/ui/b'\nexport default function P() { return <main><B /></main> }\n",
    )
    .unwrap();
    let aliases = vec![
        PathAlias {
            pattern: "@/*".into(),
            targets: vec!["*".into()],
        },
        PathAlias {
            pattern: "@/ui/*".into(),
            targets: vec!["src/ui/*".into()],
        },
    ];
    let all = tree(&root, "page.tsx", aliases.clone());
    let page = all.iter().find(|i| i.source == "page.tsx").unwrap();
    assert_eq!(page.alias_imports[0].target, "src/ui/b.tsx");
    // Order in the config does not matter.
    let mut rev = aliases;
    rev.reverse();
    let all = tree(&root, "page.tsx", rev);
    assert_eq!(
        all.iter()
            .find(|i| i.source == "page.tsx")
            .unwrap()
            .alias_imports[0]
            .target,
        "src/ui/b.tsx"
    );
    // An exact pattern beats a star pattern.
    let exact = vec![
        PathAlias {
            pattern: "@/ui/*".into(),
            targets: vec!["src/ui/*".into()],
        },
        PathAlias {
            pattern: "@/ui/b".into(),
            targets: vec!["ui/b".into()],
        },
    ];
    let all = tree(&root, "page.tsx", exact);
    assert_eq!(
        all.iter()
            .find(|i| i.source == "page.tsx")
            .unwrap()
            .alias_imports[0]
            .target,
        "ui/b.tsx"
    );
    let _ = std::fs::remove_dir_all(&root);
}
