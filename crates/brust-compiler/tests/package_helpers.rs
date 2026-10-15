//! F197: a helper imported from a PACKAGE, called as a child of a plain wrapper, is proven plain by the same rules as an
//! app helper (`plain_fn::imported_plain_fn`), read from the package source the build wrote (`.brust/pkg-src`, F153c) and
//! followed through barrels. A package that was not written, a helper that builds an element, reads a global or is
//! rebound, falls back by name (`jsx-const-child`), as before.
use brust_compiler::analyze::aliases::PathAlias;
use brust_compiler::analyze::component::{AnalyzeOptions, PackageSources};
use brust_compiler::ir::{ComponentIR, Tier};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::collections::HashMap;
use std::path::PathBuf;

const PKG: &str = ".brust/pkg-src/fmtz@1.0.0-00000001";

struct App {
    root: PathBuf,
    packages: PackageSources,
    aliases: Vec<PathAlias>,
}

impl App {
    fn new() -> App {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("brust-pkghelp-{}-{n}", std::process::id()));
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

    /// The package `fmtz`, written by the build with `files` (path under `src/`, text); its entry is `src/index.ts`.
    fn package(&mut self, files: &[(&str, &str)]) -> &mut Self {
        for (rel, text) in files {
            self.file(&format!("{PKG}/src/{rel}"), text);
        }
        self.packages
            .scopes
            .entry(String::new())
            .or_insert_with(HashMap::new)
            .insert("fmtz".into(), format!("{PKG}/src/index.ts"));
        self
    }

    /// The page component (the tree's root) for a child expression under a plain wrapper.
    fn page(&mut self, imports: &str, child: &str) -> ComponentIR {
        self.file(
            "App.tsx",
            &format!(
                "{imports}\nfunction Wrap({{ children }}: {{ children?: React.ReactNode }}) {{ return <section>{{children}}</section> }}\nexport default function App() {{ return <Wrap>{{{child}}}</Wrap> }}\n"
            ),
        );
        let opts = AnalyzeOptions {
            root: self.root.clone(),
            packages: self.packages.clone(),
            path_aliases: self.aliases.clone(),
            ..Default::default()
        };
        run_on_compiler_thread(move || {
            let tree = compile_tree("App.tsx", None, &opts, DEFAULT_RUNTIME_IMPORT).unwrap();
            (*tree[0].ir).clone()
        })
    }
}

impl Drop for App {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn falls_back(ir: &ComponentIR) -> bool {
    ir.diagnostics.iter().any(|d| d.rule == "jsx-const-child")
        && matches!(ir.tier, Tier::React { .. })
}

const TAG: &str = "export function tag(n: number): string {\n  return `#${n.toFixed(0)}`\n}\n";

#[test]
fn a_package_helper_proven_plain_lowers_under_a_wrapper() {
    // Directly, through a named re-export, and through a chain of them (renamed on the way), within 4 hops.
    let chains: &[&[(&str, &str)]] = &[
        &[("index.ts", TAG)],
        &[
            ("index.ts", "export { tag } from './tag'\n"),
            ("tag.ts", TAG),
        ],
        &[
            ("index.ts", "export { tag } from './a'\n"),
            ("a.ts", "export { label as tag } from './b'\n"),
            ("b.ts", "export { label } from './c'\n"),
            ("c.ts", "export { label } from './d'\n"),
            (
                "d.ts",
                "export function label(n: number): string {\n  return `#${n.toFixed(0)}`\n}\n",
            ),
        ],
    ];
    for files in chains {
        let mut app = App::new();
        app.package(files);
        let ir = app.page("import { tag } from 'fmtz'", "tag(3)");
        assert!(
            !falls_back(&ir),
            "{files:?}: {:?} {:?}",
            ir.tier,
            ir.diagnostics
        );
    }
}

#[test]
fn a_package_helper_that_is_not_provable_falls_back() {
    let cases: &[(&str, &[(&str, &str)])] = &[
        // Returns an element.
        (
            "JSX",
            &[
                ("index.ts", "export { icon } from './icon'\n"),
                (
                    "icon.tsx",
                    "export function icon() {\n  return <b>hi</b>\n}\n",
                ),
            ],
        ),
        // A rebindable export, or one the module reassigns.
        (
            "let",
            &[("index.ts", "export let tag = (n: number) => String(n)\n")],
        ),
        (
            "reassigned",
            &[(
                "index.ts",
                "export function tag(n: number) {\n  return String(n)\n}\n// @ts-ignore\ntag = () => 'x'\n",
            )],
        ),
        // A global the proof does not allow (time, the console).
        (
            "global",
            &[(
                "index.ts",
                "export function tag(n: number) {\n  return String(Date.now() + n)\n}\n",
            )],
        ),
        (
            "member",
            &[(
                "index.ts",
                "export function tag(n: number) {\n  return String(console.log(n))\n}\n",
            )],
        ),
        // Lead ruling: a hop re-exporting a helper that is not plain, a reassigned export at the end of a chain, a star
        // export, a re-exported `default`, a chain longer than 4 hops.
        (
            "barrel-reassigned",
            &[
                ("index.ts", "export { tag } from './a'\n"),
                (
                    "a.ts",
                    "export function tag(n: number) {\n  return String(n)\n}\n// @ts-ignore\ntag = () => 'x'\n",
                ),
            ],
        ),
        (
            "star",
            &[("index.ts", "export * from './tag'\n"), ("tag.ts", TAG)],
        ),
        // A hop that leaves the written package (an app module the integrity check never saw).
        (
            "leaves-package",
            &[("index.ts", "export { tag } from '../../../../lib/tag'\n")],
        ),
        (
            "default",
            &[
                ("index.ts", "export { default as tag } from './tag'\n"),
                (
                    "tag.ts",
                    "export default function tag(n: number): string {\n  return String(n)\n}\n",
                ),
            ],
        ),
        (
            "too-deep",
            &[
                ("index.ts", "export { tag } from './a'\n"),
                ("a.ts", "export { tag } from './b'\n"),
                ("b.ts", "export { tag } from './c'\n"),
                ("c.ts", "export { tag } from './d'\n"),
                ("d.ts", "export { tag } from './e'\n"),
                ("e.ts", TAG),
            ],
        ),
        (
            "barrel-jsx",
            &[
                ("index.ts", "export { tag } from './a'\n"),
                ("a.ts", "export { tag } from './b'\n"),
                (
                    "b.tsx",
                    "export function tag(n: number) {\n  return <i>{n}</i>\n}\n",
                ),
            ],
        ),
        // A chain that cannot be followed (the re-exported file does not exist).
        (
            "missing",
            &[("index.ts", "export { tag } from './nowhere'\n")],
        ),
    ];
    for (why, files) in cases {
        let mut app = App::new();
        app.file("lib/tag.ts", TAG);
        app.package(files);
        let ir = app.page(
            "import { tag, icon } from 'fmtz'",
            if *why == "JSX" { "icon()" } else { "tag(3)" },
        );
        assert!(falls_back(&ir), "{why}: {:?} {:?}", ir.tier, ir.diagnostics);
    }
}

#[test]
fn a_mixed_package_module_proves_each_export_on_its_own() {
    // `index.ts` cannot hold JSX: the mixed module is `index.tsx`, the entry points at it.
    let mut app = App::new();
    app.file(
        &format!("{PKG}/src/index.tsx"),
        &format!("{TAG}export function icon() {{\n  return <b>hi</b>\n}}\n"),
    );
    app.packages
        .scopes
        .entry(String::new())
        .or_insert_with(HashMap::new)
        .insert("fmtz".into(), format!("{PKG}/src/index.tsx"));
    let ir = app.page("import { tag } from 'fmtz'", "tag(3)");
    assert!(
        !falls_back(&ir),
        "plain export of a mixed module: {:?}",
        ir.diagnostics
    );
    let ir = app.page("import { icon } from 'fmtz'", "icon()");
    assert!(
        falls_back(&ir),
        "JSX export of a mixed module: {:?}",
        ir.diagnostics
    );
}

#[test]
fn a_package_the_build_did_not_write_falls_back() {
    // Not mapped at all, and refused by the build (no source map, integrity).
    let mut app = App::new();
    let ir = app.page("import { tag } from 'fmtz'", "tag(3)");
    assert!(falls_back(&ir), "unmapped: {:?}", ir.diagnostics);
    let mut app = App::new();
    app.file(&format!("{PKG}/src/index.ts"), TAG);
    app.packages
        .refused
        .entry(String::new())
        .or_insert_with(HashMap::new)
        .insert("fmtz".into(), "no source map".into());
    let ir = app.page("import { tag } from 'fmtz'", "tag(3)");
    assert!(falls_back(&ir), "refused: {:?}", ir.diagnostics);
    // A mapped entry outside `.brust/pkg-src` is never read as package source.
    let mut app = App::new();
    app.file("evil/index.ts", TAG);
    app.packages
        .scopes
        .entry(String::new())
        .or_insert_with(HashMap::new)
        .insert("fmtz".into(), "evil/index.ts".into());
    let ir = app.page("import { tag } from 'fmtz'", "tag(3)");
    assert!(falls_back(&ir), "outside pkg-src: {:?}", ir.diagnostics);
}

#[test]
fn an_alias_specifier_is_the_app_module_it_names() {
    let mut app = App::new();
    app.aliases = vec![PathAlias {
        pattern: "@/*".into(),
        targets: vec!["*".into()],
    }];
    app.file("lib/fmt.ts", TAG);
    let ir = app.page("import { tag } from '@/lib/fmt'", "tag(3)");
    assert!(
        !falls_back(&ir),
        "plain app helper via alias: {:?}",
        ir.diagnostics
    );
    app.file(
        "lib/el.tsx",
        "export function tag(n: number) {\n  return <b>{n}</b>\n}\n",
    );
    let ir = app.page("import { tag } from '@/lib/el'", "tag(3)");
    assert!(
        falls_back(&ir),
        "JSX app helper via alias: {:?}",
        ir.diagnostics
    );
}
