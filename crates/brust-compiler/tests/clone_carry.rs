//! F305 + F306: content that moves into a clone (F298's rest-carried children here, the shadcn Switch wrapper's shape:
//! `<Kit.Root …><Kit.Thumb className={cn(…)} /></Kit.Root>`).
//! F305: a value of the content that calls an import of the call site (`cn(…)`) is computed at the call site and
//! crosses as one hidden input; an import read as data (an object, a list's source) stays refused (F325).
//! F306: a content component imported through a package scope other than the clone's is rebased when it resolves to a
//! declaration of the clone's own module (`Kit.Thumb` beside `Kit.Root`); any other foreign component stays refused.
use brust_compiler::analyze::component::{AnalyzeOptions, PackageSources};
use brust_compiler::ir::{ComponentIR, Tier};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::collections::HashMap;
use std::path::PathBuf;

const KIT_DIR: &str = ".brust/pkg-src/kit@1.0.0-0000000a";
const OTHER_DIR: &str = ".brust/pkg-src/other@1.0.0-0000000b";

/// Radix Switch's shape: Root spreads its rest (children included) into a trigger under its own Provider; the Thumb the
/// caller passes reads that Provider.
const KIT: &str = r#"import * as React from 'react'
import { createContext, useContext, useState } from 'react'
const K = createContext<{ on: boolean; flip: () => void }>({ on: false, flip: () => {} })
function getState(on: boolean) {
  return on ? 'checked' : 'unchecked'
}
function KProvider({ children }: { children?: React.ReactNode }) {
  const [on, setOn] = useState(false)
  return <K.Provider value={{ on, flip: () => setOn((o) => !o) }}>{children}</K.Provider>
}
function KLabel({ children, ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  return (
    <button type="button" {...rest}>
      {children}
    </button>
  )
}
function KThumb({ className }: { className?: string }) {
  const c = useContext(K)
  return <span className={className} data-state={getState(c.on)} />
}
function KRoot({ ...rest }: React.ComponentPropsWithoutRef<'button'>) {
  return (
    <KProvider>
      <KLabel {...rest} />
    </KProvider>
  )
}
export { KRoot as Root, KThumb as Thumb }
"#;

const CN: &str = "export function cn(...xs: (string | false | undefined)[]) { return xs.filter(Boolean).join(' ') }\nexport function tone(name: string) { return 'tone-' + name }\nexport const DATA = { label: 'S3CR3T', items: ['S3CR3T'] }\nexport const ROWS = ['S3CR3T']\nexport function getRows() { return ['S3CR3T'] }\n";

struct App {
    root: PathBuf,
    packages: PackageSources,
}

impl App {
    fn new() -> App {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let root =
            std::env::temp_dir().join(format!("brust-clone-carry-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let mut app = App {
            root,
            packages: PackageSources::default(),
        };
        app.file("cn.ts", CN)
            .file("kit.tsx", KIT)
            .file(&format!("{KIT_DIR}/src/kit.tsx"), KIT)
            .file(&format!("{OTHER_DIR}/src/other.tsx"), "import { useSyncExternalStore } from 'react'\nexport function Thumb() { const v = useSyncExternalStore(() => () => {}, () => 1); return <i>{v}</i> }\n")
            .map("", "kit", &format!("{KIT_DIR}/src/kit.tsx"))
            .map("", "other", &format!("{OTHER_DIR}/src/other.tsx"));
        app
    }

    fn file(&mut self, rel: &str, text: &str) -> &mut Self {
        let p = self.root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
        self
    }

    fn map(&mut self, scope: &str, spec: &str, entry: &str) -> &mut Self {
        self.packages
            .scopes
            .entry(scope.into())
            .or_insert_with(HashMap::new)
            .insert(spec.into(), entry.into());
        self
    }

    /// (IR, jinja, client chunk) of every component under `App.tsx`.
    fn compile(&mut self, app: &str) -> Vec<(ComponentIR, String, String)> {
        self.file("App.tsx", app);
        let opts = AnalyzeOptions {
            root: self.root.clone(),
            packages: self.packages.clone(),
            ..Default::default()
        };
        run_on_compiler_thread(move || {
            compile_tree("App.tsx", None, &opts, DEFAULT_RUNTIME_IMPORT)
                .unwrap()
                .into_iter()
                .map(|l| {
                    let mut client = l.artifacts.client_js.clone().unwrap_or_default();
                    for (_, code) in &l.artifacts.client_modules {
                        client.push_str(code);
                    }
                    ((*l.ir).clone(), l.artifacts.jinja.clone(), client)
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

fn rest_clone(tree: &[(ComponentIR, String, String)]) -> Option<&(ComponentIR, String, String)> {
    tree.iter().find(|(ir, ..)| ir.rest_clone_of.is_some())
}

fn info(ir: &ComponentIR) -> Vec<String> {
    ir.diagnostics
        .iter()
        .map(|d| format!("{}: {}", d.rule, d.message))
        .collect()
}

fn page(thumb: &str, import: &str) -> String {
    format!(
        "import {{ useState }} from 'react'\n{import}\nimport {{ cn, tone, DATA, ROWS, getRows }} from './cn'\nexport default function App() {{ const [on, setOn] = useState(false); return <main><button onClick={{() => setOn(!on)}}>f</button>{thumb}</main> }}"
    )
}

/// F305: the Thumb's `cn(…)` is computed by the page and handed to the clone. Over the page's state, the rest clone does
/// not follow its inputs until F345 widens S3 again (alpha.17 narrowed it to host clones): that page falls back by name
/// (`frozen-prop`), never stale.
#[test]
fn a_value_that_calls_an_import_crosses_into_the_clone_as_one_input() {
    let mut live = App::new();
    let tree = live.compile(&page(
        "<Root data-x=\"1\"><Thumb className={cn('t', on && 'on')} /></Root>",
        "import { Root, Thumb } from './kit'",
    ));
    assert!(
        info(&tree[0].0)
            .iter()
            .any(|d| d.starts_with("frozen-prop")),
        "{:?}",
        info(&tree[0].0)
    );
    let mut app = App::new();
    let tree = app.compile(&page(
        "<Root data-x=\"1\"><Thumb className={cn('t', 'round')} /></Root>",
        "import { Root, Thumb } from './kit'",
    ));
    let (root, root_jinja, _) = &tree[0];
    assert!(!matches!(root.tier, Tier::React { .. }), "{:?}", info(root));
    let (clone, ..) = rest_clone(&tree).unwrap_or_else(|| panic!("{:?}", info(root)));
    assert!(
        clone.props.iter().any(|p| p.name.starts_with("__inx")),
        "{:?}",
        clone.props
    );
    // the page computes it (in its own scope, where `cn` is imported) and passes it
    assert!(root_jinja.contains("__inx"), "{root_jinja}");
}

/// F305: a member of a namespace import is a call of the import too (`fmt.cn(…)`, `import * as fmt`).
#[test]
fn a_namespace_imports_call_crosses_too() {
    let mut app = App::new();
    let tree = app.compile(&page(
        "<Root data-x=\"1\"><Thumb className={fmt.cn('t', 'round')} /></Root>",
        "import { Root, Thumb } from './kit'\nimport * as fmt from './cn'",
    ));
    let (root, ..) = &tree[0];
    assert!(!matches!(root.tier, Tier::React { .. }), "{:?}", info(root));
    let (clone, ..) = rest_clone(&tree).unwrap_or_else(|| panic!("{:?}", info(root)));
    assert!(
        clone.props.iter().any(|p| p.name.starts_with("__inx")),
        "{:?}",
        clone.props
    );
}

/// F346 (Afrojack, clone-carry): an imported call that is not `cn` crosses the same way (any function the call site
/// imports, called with values it can compute), and two such values in the content are TWO hidden inputs, each computed
/// by the page, so neither overwrites the other.
#[test]
fn a_call_of_any_import_and_two_of_them_cross_as_separate_inputs() {
    let mut app = App::new();
    let tree = app.compile(&page(
        "<Root data-x=\"1\"><Thumb className={tone('round')} /><Thumb className={cn('t', 'big')} /></Root>",
        "import { Root, Thumb } from './kit'",
    ));
    let (root, root_jinja, _) = &tree[0];
    assert!(!matches!(root.tier, Tier::React { .. }), "{:?}", info(root));
    let (clone, ..) = rest_clone(&tree).unwrap_or_else(|| panic!("{:?}", info(root)));
    let inputs: Vec<&str> = clone
        .props
        .iter()
        .map(|p| p.name.as_str())
        .filter(|n| n.starts_with("__inx"))
        .collect();
    assert_eq!(inputs.len(), 2, "{:?}", clone.props);
    assert_ne!(inputs[0], inputs[1]);
    for i in &inputs {
        assert!(root_jinja.contains(i), "{i}: {root_jinja}");
    }
    // each input is its own value of the page (a build-time job here: `_s1`, `_s2`), not one shared slot
    assert!(
        root_jinja.contains("(_s1)") && root_jinja.contains("(_s2)"),
        "{root_jinja}"
    );
}

/// F306 + F305: the same shape from a package the build wrote: `Kit.Thumb` is declared in the clone's own module.
#[test]
fn a_package_component_declared_in_the_clones_own_module_is_rebased() {
    let mut app = App::new();
    let tree = app.compile(&page(
        "<Kit.Root data-x=\"1\"><Kit.Thumb className={cn('t', 'round')} /></Kit.Root>",
        "import * as Kit from 'kit'",
    ));
    let (root, ..) = &tree[0];
    assert!(!matches!(root.tier, Tier::React { .. }), "{:?}", info(root));
    assert!(
        !info(root).iter().any(|d| d.contains("another scope")),
        "{:?}",
        info(root)
    );
    let (clone, ..) = rest_clone(&tree).unwrap_or_else(|| panic!("{:?}", info(root)));
    assert!(clone.source.starts_with(KIT_DIR), "{}", clone.source);
}

/// F306 / W1d: a content component of another package is rebased when it compiles without React (main's rule, which
/// covers F306's same-module case); one that needs React keeps the refusal.
#[test]
fn a_foreign_package_component_stays_refused() {
    let mut app = App::new();
    let tree = app.compile(&page(
        "<Kit.Root data-x=\"1\"><Kit.Thumb /><Other /></Kit.Root>",
        "import * as Kit from 'kit'\nimport { Thumb as Other } from 'other'",
    ));
    let (root, ..) = &tree[0];
    assert!(rest_clone(&tree).is_none());
    assert!(
        info(root).iter().any(|d| d.contains("another scope")),
        "{:?}",
        info(root)
    );
}

/// F305 / F325: an import read as data (an object member, a list's source) is not computed at the call site and
/// shipped as an input: the content stays outside the clone, and the data is never in a client chunk.
#[test]
fn an_import_read_as_data_stays_refused() {
    for thumb in [
        "<Root data-x=\"1\"><Thumb className={DATA.label} /></Root>",
        "<Root data-x=\"1\"><Thumb />{ROWS.map((r) => <b key={r}>{on ? r : '-'}</b>)}</Root>",
        // a list whose source calls an import: computing it at the call site would ship the rows as an input
        "<Root data-x=\"1\"><Thumb />{getRows().map((r) => <b key={r}>{on ? r : '-'}</b>)}</Root>",
        // Mellow N1: an import read as data through a method call is not a call of the import
        "<Root data-x=\"1\"><Thumb className={DATA.items.join(on ? ',' : ';')} /></Root>",
        "<Root data-x=\"1\"><Thumb className={on ? DATA.label.toLowerCase() : 'x'} /></Root>",
    ] {
        let mut app = App::new();
        let tree = app.compile(&page(thumb, "import { Root, Thumb } from './kit'"));
        let (root, ..) = &tree[0];
        assert!(rest_clone(&tree).is_none(), "{thumb}");
        assert!(
            info(root).iter().any(|d| d.contains("(an import)")),
            "{thumb}: {:?}",
            info(root)
        );
        for (ir, _, client) in &tree {
            assert!(!client.contains("S3CR3T"), "{thumb} {}: {client}", ir.id);
        }
    }
}
