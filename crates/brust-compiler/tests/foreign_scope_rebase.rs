//! F402: a component written in ANOTHER package's module inside the content a Presence clone is given (the S1 child of a
//! checkbox indicator, the S2 body of a tabs content: `<Primitive.span>`, `<Primitive.div>` of `@radix-ui/react-primitive`)
//! resolves in the scope of the module that wrote it, not in the clone's (`@radix-ui/react-presence`'s, which cannot see
//! the primitive package under bun's isolated store). What the writer's scope cannot resolve keeps the named refusal.
use brust_compiler::analyze::component::{AnalyzeOptions, PackageSources};
use brust_compiler::ir::Tier;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::collections::HashMap;
use std::path::PathBuf;

const PRIMITIVE: &str = include_str!("../../../tests/fixtures/package-source/primitive.tsx");
const PRIM_DIR: &str = ".brust/pkg-src/@radix-ui+react-primitive@2.2.0-00000001";
const PRES_DIR: &str = ".brust/pkg-src/@radix-ui+react-presence@1.1.5-00000011";
const TABS_DIR: &str = ".brust/pkg-src/tabsish@1.0.0-00000012";

fn store(prefix: &str) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../node_modules/.bun");
    std::fs::read_dir(&root)
        .unwrap()
        .filter_map(Result::ok)
        .find(|e| e.file_name().to_string_lossy().starts_with(prefix))
        .unwrap_or_else(|| panic!("{prefix} is installed"))
        .path()
}

/// The module that writes the content: a package of its own, importing `Primitive` and `Presence` by bare specifier.
const WRITER: &str = "import * as React from 'react'
import { Primitive } from '@radix-ui/react-primitive'
import { Presence } from '@radix-ui/react-presence'
export const Content = React.forwardRef<HTMLDivElement, { open: boolean }>(function Content({ open }, ref) {
  return (
    <Presence present={open}>
      {({ present }) => (
        <Primitive.div ref={ref} hidden={!present} data-state={open ? 'active' : 'inactive'}>body</Primitive.div>
      )}
    </Presence>
  )
})
export const Indicator = React.forwardRef<HTMLSpanElement, { checked: boolean }>(function Indicator({ checked }, ref) {
  return (
    <Presence present={checked}>
      <Primitive.span ref={ref} data-state={checked ? 'checked' : 'unchecked'}>x</Primitive.span>
    </Presence>
  )
})
";

const PAGE: &str = "import * as React from 'react'
import { Content, Indicator } from 'tabsish'
export default function App() {
  const [n, setN] = React.useState(0)
  return <main><button type=\"button\" onClick={() => setN(n + 1)}>{n}</button><Content open={true} /><Indicator checked={true} /></main>
}
";

struct Built {
    root: PathBuf,
    packages: PackageSources,
}

impl Built {
    fn new(writer: &str) -> Built {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("brust-fsr-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mut b = Built {
            root,
            packages: PackageSources::default(),
        };
        std::fs::create_dir_all(b.root.join("node_modules/react")).unwrap();
        std::fs::write(
            b.root.join("node_modules/react/package.json"),
            "{\"name\":\"react\",\"version\":\"19.0.0\"}",
        )
        .unwrap();
        b.file(&format!("{PRIM_DIR}/src/primitive.tsx"), PRIMITIVE);
        // Presence as published (its source map), the layout-effect package read as React's hook
        let map = store("@radix-ui+react-presence@")
            .join("node_modules/@radix-ui/react-presence/dist/index.mjs.map");
        let map: serde_json::Value = serde_json::from_slice(&std::fs::read(map).unwrap()).unwrap();
        for (s, c) in map["sources"]
            .as_array()
            .unwrap()
            .iter()
            .zip(map["sourcesContent"].as_array().unwrap())
        {
            let file = s.as_str().unwrap().rsplit('/').next().unwrap();
            let text = c.as_str().unwrap().replace(
                "import { useLayoutEffect } from '@radix-ui/react-use-layout-effect';",
                "const useLayoutEffect = React.useLayoutEffect;",
            );
            b.file(&format!("{PRES_DIR}/src/{file}"), &text);
        }
        b.file(&format!("{TABS_DIR}/src/content.tsx"), writer);
        b.map("", "tabsish", &format!("{TABS_DIR}/src/content.tsx"));
        b.map(
            TABS_DIR,
            "@radix-ui/react-primitive",
            &format!("{PRIM_DIR}/src/primitive.tsx"),
        );
        b.map(
            TABS_DIR,
            "@radix-ui/react-presence",
            &format!("{PRES_DIR}/src/presence.tsx"),
        );
        // the primitive package's own bare imports are not needed: the factory is recognised by its shape
        b
    }

    fn file(&mut self, rel: &str, text: &str) {
        let p = self.root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn map(&mut self, scope: &str, spec: &str, entry: &str) {
        self.packages
            .scopes
            .entry(scope.into())
            .or_insert_with(HashMap::new)
            .insert(spec.into(), entry.into());
    }

    /// (root tier, every diagnostic of the tree, root jinja, the presence clones: (id, tier, jinja))
    #[allow(clippy::type_complexity)]
    fn compile(&mut self, page: &str) -> (Tier, Vec<String>, String, Vec<(String, Tier, String)>) {
        self.file("App.tsx", page);
        let opts = AnalyzeOptions {
            root: self.root.clone(),
            packages: self.packages.clone(),
            ..Default::default()
        };
        run_on_compiler_thread(move || {
            let tree = compile_tree("App.tsx", None, &opts, DEFAULT_RUNTIME_IMPORT).unwrap();
            let diags = tree
                .iter()
                .flat_map(|c| c.ir.diagnostics.iter().chain(&c.artifacts.diagnostics))
                .map(|d| format!("{}: {}", d.rule, d.message))
                .collect();
            let clones = tree
                .iter()
                .filter(|c| c.ir.id.contains("presence") && c.ir.specialised)
                .map(|c| {
                    (
                        c.ir.id.clone(),
                        c.ir.tier.clone(),
                        c.artifacts.jinja.clone(),
                    )
                })
                .collect();
            (
                tree[0].ir.tier.clone(),
                diags,
                tree[0].artifacts.jinja.clone(),
                clones,
            )
        })
    }
}

impl Drop for Built {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn a_primitive_in_a_rebased_s1_child_and_s2_body_resolves_in_the_writers_scope() {
    let mut b = Built::new(WRITER);
    let (tier, diags, jinja, clones) = b.compile(PAGE);
    assert!(
        !diags.iter().any(|d| d.contains("another scope")),
        "{diags:#?}"
    );
    assert!(matches!(tier, Tier::Native), "{tier:?} {diags:#?}");
    assert!(!jinja.contains("brust-island"), "{jinja}");
    assert_eq!(clones.len(), 2, "one clone per call site: {clones:#?}");
    for (id, tier, jinja) in &clones {
        assert!(matches!(tier, Tier::Native), "{id} {tier:?}");
        // `Primitive.div` / `Primitive.span` is the host element
        assert!(
            jinja.contains("<div") || jinja.contains("<span"),
            "{id}: {jinja}"
        );
    }
    assert!(clones.iter().any(|c| c.2.contains("<div")), "{clones:#?}");
    assert!(clones.iter().any(|c| c.2.contains("<span")), "{clones:#?}");
}

#[test]
fn a_component_the_writers_scope_cannot_resolve_keeps_the_named_refusal() {
    // `Ghost` is imported from a package no scope maps: the content cannot move into the clone, and the refusal names
    // both the component and the module that wrote it.
    let writer = WRITER
        .replace(
            "import { Presence }",
            "import { Ghost } from 'ghost-pkg'\nimport { Presence }",
        )
        .replace("body</Primitive.div>", "<Ghost /></Primitive.div>");
    let mut b = Built::new(&writer);
    let (_, diags, _, _) = b.compile(PAGE);
    let refusal = diags
        .iter()
        .find(|d| d.contains("another scope"))
        .unwrap_or_else(|| panic!("{diags:#?}"));
    assert!(
        refusal.contains("<Ghost>") && refusal.contains(TABS_DIR),
        "{refusal}"
    );
}
