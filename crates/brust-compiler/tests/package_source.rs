//! F153c (R34.61, R34.65): a bare import whose package source the build wrote (`.brust/pkg-src`, the
//! `AnalyzeOptions::packages` map) compiles like app code; `Primitive.<tag>` of the Radix factory is the host element;
//! anything that cannot be proven keeps the React island of the published export.
use brust_compiler::analyze::aliases::PathAlias;
use brust_compiler::analyze::component::{AnalyzeOptions, PackageSources};
use brust_compiler::ir::{ComponentIR, Tier};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const PRIMITIVE: &str = include_str!("../../../tests/fixtures/package-source/primitive.tsx");
const LABEL: &str = include_str!("../../../tests/fixtures/package-source/label.tsx");
const PRIM_DIR: &str = ".brust/pkg-src/@radix-ui+react-primitive@2.2.0-00000001";
const LABEL_DIR: &str = ".brust/pkg-src/@radix-ui+react-label@2.1.17-00000002";
const LEAF_DIR: &str = ".brust/pkg-src/leafy@1.0.0-00000003";
const BARREL_DIR: &str = ".brust/pkg-src/barrel@1.0.0-00000004";

struct App {
    root: PathBuf,
    packages: PackageSources,
    aliases: Vec<PathAlias>,
}

impl App {
    fn new() -> App {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("brust-pkgsrc-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        App {
            root,
            packages: PackageSources::default(),
            aliases: vec![],
        }
    }

    fn file(&mut self, rel: &str, text: &str) -> &mut Self {
        let p = self.root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
        self
    }

    /// `spec`, imported from `scope` (`""` = the app), resolves to `entry`.
    fn map(&mut self, scope: &str, spec: &str, entry: &str) -> &mut Self {
        self.packages
            .scopes
            .entry(scope.into())
            .or_insert_with(HashMap::new)
            .insert(spec.into(), entry.into());
        self
    }

    fn refuse(&mut self, scope: &str, spec: &str, why: &str) -> &mut Self {
        self.packages
            .refused
            .entry(scope.into())
            .or_insert_with(HashMap::new)
            .insert(spec.into(), why.into());
        self
    }

    /// The Radix label and primitive packages, as the build writes them.
    fn radix(&mut self) -> &mut Self {
        self.file(&format!("{PRIM_DIR}/src/primitive.tsx"), PRIMITIVE)
            .file(&format!("{LABEL_DIR}/src/label.tsx"), LABEL)
            .map(
                "",
                "@radix-ui/react-label",
                &format!("{LABEL_DIR}/src/label.tsx"),
            )
            .map(
                LABEL_DIR,
                "@radix-ui/react-primitive",
                &format!("{PRIM_DIR}/src/primitive.tsx"),
            )
            .map(
                "",
                "@radix-ui/react-primitive",
                &format!("{PRIM_DIR}/src/primitive.tsx"),
            )
    }

    /// Every component of the tree under `App.tsx`: (source, IR, jinja).
    fn compile(&mut self, app: &str) -> Vec<(String, ComponentIR, String)> {
        self.file("App.tsx", app);
        let opts = AnalyzeOptions {
            root: self.root.clone(),
            packages: self.packages.clone(),
            path_aliases: self.aliases.clone(),
            ..Default::default()
        };
        run_on_compiler_thread(move || {
            compile_tree("App.tsx", None, &opts, DEFAULT_RUNTIME_IMPORT)
                .unwrap()
                .into_iter()
                .map(|l| {
                    (
                        l.ir.source.clone(),
                        (*l.ir).clone(),
                        l.artifacts.jinja.clone(),
                    )
                })
                .collect()
        })
    }
}

impl Drop for App {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn root_of(tree: &[(String, ComponentIR, String)]) -> &(String, ComponentIR, String) {
    &tree[0]
}

fn rules(ir: &ComponentIR) -> Vec<String> {
    ir.diagnostics.iter().map(|d| d.rule.clone()).collect()
}

fn in_pkg_src(tree: &[(String, ComponentIR, String)]) -> bool {
    tree.iter()
        .any(|(s, ..)| Path::new(s).starts_with(".brust"))
}

const LEAF: &str = "export function Leaf({ tone = 'plain' }: { tone?: string }) { return <span data-tone={tone}>leaf</span> }\n";

#[test]
fn a_package_component_compiles_from_its_written_source() {
    let mut app = App::new();
    app.file(&format!("{LEAF_DIR}/src/leaf.tsx"), LEAF).map(
        "",
        "leafy",
        &format!("{LEAF_DIR}/src/leaf.tsx"),
    );
    let tree = app.compile("import { Leaf } from 'leafy'\nexport default function App() { return <div><Leaf tone=\"loud\" /></div> }");
    let (_, ir, jinja) = root_of(&tree);
    assert!(matches!(ir.tier, Tier::Static), "{:?}", ir.diagnostics);
    assert!(!rules(ir).contains(&"external-component".to_string()));
    assert!(jinja.contains("leaf</span>"), "{jinja}");
    assert!(tree.iter().all(|(_, ir, _)| ir.external.is_none()));
}

/// The app's `tsconfig` `paths` (R34.76) belong to the app: a package's own `@/lib/x` is not the app's `lib/x`.
#[test]
fn the_apps_path_aliases_do_not_rewrite_a_package_source() {
    let mut app = App::new();
    app.file(
        "lib/x.tsx",
        "export function X() { return <i>from-app</i> }\n",
    )
    .file(
        &format!("{LEAF_DIR}/src/leaf.tsx"),
        "import { X } from '@/lib/x'\nexport function Leaf() { return <b><X /></b> }\n",
    )
    .file(
        &format!("{LEAF_DIR}/src/lib/x.tsx"),
        "export function X() { return <i>from-package</i> }\n",
    )
    .map("", "leafy", &format!("{LEAF_DIR}/src/leaf.tsx"))
    .map(LEAF_DIR, "@/lib/x", &format!("{LEAF_DIR}/src/lib/x.tsx"));
    app.aliases = vec![PathAlias {
        pattern: "@/*".into(),
        targets: vec!["*".into()],
    }];
    let tree = app.compile("import { Leaf } from 'leafy'\nexport default function App() { return <div><Leaf /></div> }");
    let (_, _, jinja) = root_of(&tree);
    assert!(!jinja.contains("from-app"), "{jinja}");
    assert!(
        tree.iter().all(|(src, _, _)| src != "lib/x.tsx"),
        "the app's lib/x compiled into a package's tree: {:?}",
        tree.iter().map(|t| &t.0).collect::<Vec<_>>()
    );
}

#[test]
fn a_refused_or_unasked_package_keeps_the_island_and_says_why() {
    let mut app = App::new();
    app.refuse("", "leafy", "no source map for the ESM entry");
    let tree = app.compile("import { Leaf } from 'leafy'\nexport default function App() { return <div><Leaf /></div> }");
    let (_, ir, _) = root_of(&tree);
    let d = ir
        .diagnostics
        .iter()
        .find(|d| d.rule == "external-component")
        .expect("island");
    assert!(
        d.message
            .contains("(package source: no source map for the ESM entry)"),
        "{}",
        d.message
    );
    // Never asked: today's message, unchanged.
    let tree = App::new().compile("import { Leaf } from 'other'\nexport default function App() { return <div><Leaf /></div> }");
    let d = root_of(&tree)
        .1
        .diagnostics
        .iter()
        .find(|d| d.rule == "external-component")
        .unwrap();
    assert!(!d.message.contains("package source"), "{}", d.message);
}

#[test]
fn a_namespace_reexport_is_followed_to_the_member() {
    let mut app = App::new();
    app.file(
        &format!("{LEAF_DIR}/src/leaf.tsx"),
        &format!("{LEAF}export {{ Leaf as Root }}\n"),
    )
    .file(
        &format!("{BARREL_DIR}/src/index.ts"),
        "export * as Leafy from 'leafy'\n",
    )
    .map("", "barrel", &format!("{BARREL_DIR}/src/index.ts"))
    .map(BARREL_DIR, "leafy", &format!("{LEAF_DIR}/src/leaf.tsx"));
    let tree = app.compile("import { Leafy } from 'barrel'\nexport default function App() { return <div><Leafy.Root /></div> }");
    let (_, ir, jinja) = root_of(&tree);
    assert!(matches!(ir.tier, Tier::Static), "{:?}", ir.diagnostics);
    assert!(jinja.contains("data-tone"), "{jinja}");
}

#[test]
fn a_package_subtree_that_needs_react_falls_back_whole_and_is_not_emitted() {
    let mut app = App::new();
    app.file(
        &format!("{LEAF_DIR}/src/leaf.tsx"),
        "import { useLayoutEffect } from 'react'\nimport { Other } from 'other'\nexport function Leaf() { return <b><Other /></b> }\n",
    )
    .map("", "leafy", &format!("{LEAF_DIR}/src/leaf.tsx"));
    let tree = app.compile("import { Leaf } from 'leafy'\nexport default function App() { return <div><Leaf /></div> }");
    let (_, ir, _) = root_of(&tree);
    let d = ir
        .diagnostics
        .iter()
        .find(|d| d.rule == "external-component")
        .expect("island");
    assert!(d.message.contains("renders as React"), "{}", d.message);
    // The island is the published `leafy` export; nothing compiled from its source (nor `other`) is emitted.
    assert!(
        !in_pkg_src(&tree),
        "{:?}",
        tree.iter().map(|t| &t.0).collect::<Vec<_>>()
    );
    let externals: Vec<_> = tree
        .iter()
        .filter_map(|(_, ir, _)| ir.external.as_ref())
        .map(|e| e.source.clone())
        .collect();
    assert_eq!(externals, vec!["leafy".to_string()]);
}

#[test]
fn the_radix_label_compiles_native_with_primitive_label_as_the_host() {
    let mut app = App::new();
    app.radix();
    let tree = app.compile(
        "import { Root as Label } from '@radix-ui/react-label'\nexport default function App() { return <div><Label htmlFor=\"x\">Name</Label></div> }",
    );
    let (_, ir, jinja) = root_of(&tree);
    assert!(matches!(ir.tier, Tier::Static), "{:?}", ir.diagnostics);
    let label = tree
        .iter()
        .find(|(s, ..)| s.ends_with("label.tsx") && s.starts_with(LABEL_DIR))
        .expect("label compiled");
    assert!(
        matches!(label.1.tier, Tier::Native),
        "{:?}",
        label.1.diagnostics
    );
    assert_eq!(label.1.absent_props, vec!["asChild".to_string()]);
    assert!(jinja.contains("<label"), "{jinja}");
    assert!(jinja.contains("x-on-mousedown"), "{jinja}");
    assert!(
        !jinja.contains("radix-ui"),
        "the write-only window marker is dropped: {jinja}"
    );
}

#[test]
fn as_child_reaching_primitive_through_spread_props_fails_closed() {
    let mut app = App::new();
    app.radix();
    // Written true: the label would render the child element through Radix Slot.
    let tree = app.compile(
        "import { Root as Label } from '@radix-ui/react-label'\nexport default function App() { return <div><Label asChild><a href=\"/x\">x</a></Label></div> }",
    );
    let (_, ir, _) = root_of(&tree);
    assert!(
        rules(ir).contains(&"slot-dynamic".to_string()),
        "{:?}",
        ir.diagnostics
    );
    assert!(matches!(ir.tier, Tier::React { .. }));
    // A literal false is the host element.
    let tree = app.compile(
        "import { Root as Label } from '@radix-ui/react-label'\nexport default function App() { return <div><Label asChild={false}>x</Label></div> }",
    );
    assert!(
        matches!(root_of(&tree).1.tier, Tier::Static),
        "{:?}",
        root_of(&tree).1.diagnostics
    );
}

#[test]
fn a_wrapper_spreading_its_rest_into_the_label_passes_the_requirement_up() {
    let mut app = App::new();
    app.radix().file(
        "Wrap.tsx",
        "import { Root } from '@radix-ui/react-label'\nexport function Wrap({ className, ...props }: any) { return <Root data-slot=\"label\" className={className} {...props} /> }\n",
    );
    let tree = app.compile("import { Wrap } from './Wrap'\nexport default function App() { return <div><Wrap htmlFor=\"x\">Name</Wrap></div> }");
    let wrap = tree.iter().find(|(s, ..)| s == "Wrap.tsx").unwrap();
    assert_eq!(wrap.1.absent_props, vec!["asChild".to_string()]);
    assert!(
        matches!(root_of(&tree).1.tier, Tier::Static),
        "{:?}",
        root_of(&tree).1.diagnostics
    );
    // A wrapper that takes `asChild` by name keeps it out of its rest: no requirement.
    app.file(
        "Wrap.tsx",
        "import { Root } from '@radix-ui/react-label'\nexport function Wrap({ asChild, ...props }: any) { return <Root {...props} /> }\n",
    );
    let tree = app.compile("import { Wrap } from './Wrap'\nexport default function App() { return <div><Wrap asChild>Name</Wrap></div> }");
    let wrap = tree.iter().find(|(s, ..)| s == "Wrap.tsx").unwrap();
    assert!(wrap.1.absent_props.is_empty());
}

#[test]
fn primitive_with_a_changed_shape_is_not_recognised() {
    for change in [
        (
            "return <Comp {...primitiveProps} ref={forwardedRef} />;",
            "return <Comp {...primitiveProps} data-x=\"1\" ref={forwardedRef} />;",
        ),
        (
            "const Comp: any = asChild ? Slot : node;",
            "const Comp: any = asChild ? node : Slot;",
        ),
        (
            "import { createSlot } from '@radix-ui/react-slot';",
            "import { createSlot } from './my-slot';",
        ),
    ] {
        let mut app = App::new();
        app.radix();
        assert!(
            PRIMITIVE.contains(change.0),
            "fixture drifted: {}",
            change.0
        );
        app.file(
            &format!("{PRIM_DIR}/src/primitive.tsx"),
            &PRIMITIVE.replace(change.0, change.1),
        );
        let tree = app.compile(
            "import { Primitive } from '@radix-ui/react-primitive'\nexport default function App() { return <div><Primitive.span>x</Primitive.span></div> }",
        );
        let (_, ir, _) = root_of(&tree);
        assert!(
            rules(ir).contains(&"external-component".to_string()),
            "{}: {:?}",
            change.1,
            ir.diagnostics
        );
    }
}

#[test]
fn primitive_tags_render_as_hosts_and_as_child_merges_into_one_host_child() {
    let mut app = App::new();
    app.radix();
    let tree = app.compile(
        "import { Primitive } from '@radix-ui/react-primitive'\nexport default function App() { return <div><Primitive.span id=\"a\">x</Primitive.span><Primitive.button asChild className=\"b\"><a href=\"/y\">y</a></Primitive.button></div> }",
    );
    let (_, ir, jinja) = root_of(&tree);
    assert!(matches!(ir.tier, Tier::Static), "{:?}", ir.diagnostics);
    assert!(jinja.contains("<span"), "{jinja}");
    assert!(
        jinja.contains("<a") && !jinja.contains("<button"),
        "{jinja}"
    );
    // A tag the factory does not make is not a host.
    let tree = app.compile(
        "import { Primitive } from '@radix-ui/react-primitive'\nexport default function App() { return <div><Primitive.table /></div> }",
    );
    assert!(rules(&root_of(&tree).1).contains(&"external-component".to_string()));
}

#[test]
fn the_forwarded_ref_may_go_on_only_to_a_component_that_forwards_it() {
    let mut app = App::new();
    app.radix().file(
        &format!("{LEAF_DIR}/src/leaf.tsx"),
        "import * as React from 'react'\nfunction Plain(p: any) { return <i {...p} /> }\nexport const Leaf = React.forwardRef(function Leaf(props: any, ref: any) { return <Plain ref={ref} /> })\n",
    )
    .map("", "leafy", &format!("{LEAF_DIR}/src/leaf.tsx"));
    let tree = app.compile("import { Leaf } from 'leafy'\nexport default function App() { return <div><Leaf /></div> }");
    let d = root_of(&tree)
        .1
        .diagnostics
        .iter()
        .find(|d| d.rule == "external-component")
        .expect("island");
    assert!(d.message.contains("forward"), "{}", d.message);
}

/// Security (plan §6): package source is untrusted input to the SAME printer and sinks as app code. A hostile leaf
/// compiled from a package prints exactly what the same file prints as an app module: the URL guard, escaping,
/// `html_raw` as the only raw sink, and spread keys checked, all unchanged.
#[test]
fn hostile_package_source_goes_through_the_app_sinks() {
    let hostile = "export function Leaf(props: any) {\n  return <div {...props}><a href={props.u}>go</a><a href=\"javascript:alert(1)\">x</a><span>{'</script><b>'}</span><p dangerouslySetInnerHTML={{ __html: props.h }} /></div>\n}\n";
    let page = |from: &str| {
        format!(
            "import {{ Leaf }} from '{from}'\nexport default function App() {{ return <main><Leaf u=\"javascript:alert(2)\" h=\"<i>x</i>\" {{...{{ 'x-on-click': 'evil', onclick: 'evil()' }}}} /></main> }}"
        )
    };
    let mut pkg = App::new();
    pkg.file(&format!("{LEAF_DIR}/src/leaf.tsx"), hostile).map(
        "",
        "leafy",
        &format!("{LEAF_DIR}/src/leaf.tsx"),
    );
    let a = pkg.compile(&page("leafy"));
    let mut local = App::new();
    local.file("Leaf.tsx", hostile);
    let b = local.compile(&page("./Leaf"));
    let strip = |t: &[(String, ComponentIR, String)]| {
        let re = |s: &str| {
            let mut out = String::new();
            for w in s.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
                // component ids carry a path hash
                if w.len() > 9
                    && w.rsplit('_')
                        .next()
                        .is_some_and(|h| h.len() == 8 && h.chars().all(|c| c.is_ascii_hexdigit()))
                {
                    out.push_str("ID ");
                } else {
                    out.push_str(w);
                    out.push(' ');
                }
            }
            out
        };
        (
            re(&t[0].2),
            t[0].1
                .diagnostics
                .iter()
                .map(|d| d.rule.clone())
                .collect::<Vec<_>>(),
        )
    };
    let (ja, da) = strip(&a);
    let (jb, db) = strip(&b);
    assert_eq!(da, db, "{:?}", a[0].1.diagnostics);
    assert_eq!(ja, jb, "package vs app template");
    // And the sinks are the ones app code gets: one html_raw, no raw handler attribute, the literal script text escaped.
    let jinja = &a[0].2;
    // Compiled, not an island of either: the comparison is between two printed templates.
    assert!(
        jinja.contains("go</a>") && !jinja.contains("brust-island"),
        "{jinja}"
    );
    assert_eq!(jinja.matches("html_raw").count(), 1, "{jinja}");
    assert!(!jinja.contains("onclick=\"evil"), "{jinja}");
    assert!(!jinja.contains("</script><b>"), "{jinja}");
}

/// Review F1: a map entry that leaves `.brust/pkg-src` is refused (the island), never compiled as app code.
#[test]
fn a_package_entry_outside_the_build_directory_is_refused() {
    for entry in [
        "Leaf.tsx",
        "../Leaf.tsx",
        ".brust/pkg-src/../Leaf.tsx",
        ".brust/pkg-src/x/../../Leaf.tsx",
    ] {
        let mut app = App::new();
        app.file("Leaf.tsx", LEAF).map("", "leafy", entry);
        let tree = app.compile("import { Leaf } from 'leafy'\nexport default function App() { return <div><Leaf /></div> }");
        let d = root_of(&tree)
            .1
            .diagnostics
            .iter()
            .find(|d| d.rule == "external-component")
            .unwrap_or_else(|| panic!("{entry}: compiled"));
        assert!(
            d.message.contains("is not inside .brust/pkg-src"),
            "{entry}: {}",
            d.message
        );
    }
}

/// Review N1: the build never evaluates a slot of a component compiled from package source (L2).
#[test]
fn no_build_evaluation_for_package_source() {
    let mut app = App::new();
    app.file(
        &format!("{LEAF_DIR}/src/leaf.tsx"),
        "import { label } from './label'\nexport function Leaf() { return <b>{label('x')}</b> }\n",
    )
    .file(
        &format!("{LEAF_DIR}/src/label.ts"),
        "export function label(s: string) { return s.toUpperCase() }\n",
    )
    .map("", "leafy", &format!("{LEAF_DIR}/src/leaf.tsx"));
    let tree = app.compile("import { Leaf } from 'leafy'\nexport default function App() { return <div><Leaf /></div> }");
    let leaf = tree
        .iter()
        .find(|(s, ..)| s.ends_with("leaf.tsx"))
        .expect("compiled");
    assert!(leaf.1.build_eval.is_empty(), "{:?}", leaf.1.build_eval);
    // The same module as app code is a build-evaluation candidate.
    let mut local = App::new();
    local
        .file("Leaf.tsx", "import { label } from './label'\nexport function Leaf() { return <b>{label('x')}</b> }\n")
        .file("label.ts", "export function label(s: string) { return s.toUpperCase() }\n");
    let tree = local.compile("import { Leaf } from './Leaf'\nexport default function App() { return <div><Leaf /></div> }");
    let leaf = tree.iter().find(|(s, ..)| s == "Leaf.tsx").unwrap();
    assert!(!leaf.1.build_eval.is_empty());
}

const CTXPKG_DIR: &str = ".brust/pkg-src/ctxpkg@1.0.0-00000005";
const CTXPKG: &str = "import { createContext, useContext, useState } from 'react'
const Ctx = createContext<{ label: string }>({ label: 'default' })
export function Root({ children }: { children?: React.ReactNode }) {
  const [label] = useState('from-root')
  return <Ctx.Provider value={{ label }}><div>{children}</div></Ctx.Provider>
}
export function Item() {
  const c = useContext(Ctx)
  return <b>{c.label}</b>
}
";

/// S2 integration (lead ruling): a context consumer of a package source (no job, no useId) passed as the children of
/// the package's own Provider island would be revived from the map source while the Provider comes from the published
/// dist: two `createContext` instances, the consumer reads the default. The caller stays React instead, by name.
#[test]
fn a_package_source_consumer_under_the_packages_provider_island_keeps_the_caller_react() {
    let mut app = App::new();
    app.file(&format!("{CTXPKG_DIR}/src/index.tsx"), CTXPKG)
        .map("", "ctxpkg", &format!("{CTXPKG_DIR}/src/index.tsx"));
    let tree = app.compile(
        "import { Root, Item } from 'ctxpkg'\nfunction Shell(props: React.ComponentProps<typeof Root>) { return <Root {...props} /> }\nexport default function App() { return <Shell><Item /></Shell> }",
    );
    let (_, ir, _) = root_of(&tree);
    assert!(
        rules(ir).contains(&"context-island".to_string()),
        "{:?} {:?}",
        ir.tier,
        ir.diagnostics
    );
    assert!(matches!(ir.tier, Tier::React { .. }), "{:?}", ir.tier);
}

/// F188 (R34.62): a component compiled from a package source and written in app code as a package import also carries
/// the published export, which a React island or a revive hook imports instead of the map source.
#[test]
fn a_package_component_written_in_app_code_carries_its_published_export() {
    let mut app = App::new();
    app.file(&format!("{LEAF_DIR}/src/leaf.tsx"), LEAF).map(
        "",
        "leafy",
        &format!("{LEAF_DIR}/src/leaf.tsx"),
    );
    let tree = app.compile("import { Leaf } from 'leafy'\nexport default function App() { return <div><Leaf /></div> }");
    let dist_of = |end: &str| {
        let (_, ir, _) = tree.iter().find(|(s, ..)| s.ends_with(end)).unwrap();
        ir.dist.clone()
    };
    let leaf = dist_of("leaf.tsx").expect("leaf has a published spelling");
    assert_eq!(
        (
            leaf.source.as_str(),
            leaf.export.as_str(),
            leaf.member.len()
        ),
        ("leafy", "Leaf", 0)
    );
    assert!(
        dist_of("App.tsx").is_none(),
        "app code is not a package export"
    );
}

#[test]
fn a_member_of_a_namespace_export_keeps_the_member_path() {
    let mut app = App::new();
    app.file(
        &format!("{LEAF_DIR}/src/leaf.tsx"),
        &format!("{LEAF}export {{ Leaf as Root }}\n"),
    )
    .file(
        &format!("{BARREL_DIR}/src/index.ts"),
        "export * as Leafy from 'leafy'\n",
    )
    .map("", "barrel", &format!("{BARREL_DIR}/src/index.ts"))
    .map(BARREL_DIR, "leafy", &format!("{LEAF_DIR}/src/leaf.tsx"));
    let tree = app.compile("import { Leafy } from 'barrel'\nexport default function App() { return <div><Leafy.Root /></div> }");
    let leaf = tree
        .iter()
        .find(|(s, ..)| s.ends_with("leaf.tsx"))
        .and_then(|(_, ir, _)| ir.dist.clone())
        .expect("the member has a published spelling");
    assert_eq!(
        (
            leaf.source.as_str(),
            leaf.export.as_str(),
            leaf.member.clone()
        ),
        ("barrel", "Leafy", vec!["Root".to_string()])
    );
}

/// A component only another package source reaches has no spelling an app could import: the build keeps its source.
#[test]
fn a_component_only_a_package_reaches_has_no_published_export() {
    let mut app = App::new();
    app.file(
        &format!("{LEAF_DIR}/src/leaf.tsx"),
        "import { Inner } from './inner'\nexport function Leaf() { return <p><Inner /></p> }\n",
    )
    .file(
        &format!("{LEAF_DIR}/src/inner.tsx"),
        "export function Inner() { return <i>in</i> }\n",
    )
    .map("", "leafy", &format!("{LEAF_DIR}/src/leaf.tsx"));
    let tree = app.compile("import { Leaf } from 'leafy'\nexport default function App() { return <div><Leaf /></div> }");
    let has = |end: &str| {
        tree.iter()
            .find(|(s, ..)| s.ends_with(end))
            .map(|(_, ir, _)| ir.dist.is_some())
    };
    assert_eq!(has("leaf.tsx"), Some(true));
    assert_eq!(has("inner.tsx"), Some(false));
}
