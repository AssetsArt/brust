//! F149 (R34.88-R34.92): an inlined instance whose child job reads only constants and allowed code is
//! a build-evaluation candidate; with the build's values (the recompile) its record is dropped and its
//! slots print as literals. Everything else keeps its per-request job, unchanged.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::ComponentIR;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::collections::HashMap;
use std::path::PathBuf;

struct App {
    root: PathBuf,
}

impl App {
    fn new() -> App {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("brust-cnfold-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        App { root }
    }

    fn file(&mut self, rel: &str, text: &str) -> &mut Self {
        let p = self.root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
        self
    }

    /// Every component of the tree under `App.tsx`: (IR, jinja), compiled with `values` as the build's
    /// results.
    fn compile_with(
        &mut self,
        app: &str,
        values: HashMap<String, serde_json::Value>,
    ) -> Vec<(ComponentIR, String)> {
        self.file("App.tsx", app);
        let opts = AnalyzeOptions {
            root: self.root.clone(),
            slot_values: values,
            ..Default::default()
        };
        run_on_compiler_thread(move || {
            compile_tree("App.tsx", None, &opts, DEFAULT_RUNTIME_IMPORT)
                .unwrap()
                .into_iter()
                .map(|l| ((*l.ir).clone(), l.artifacts.jinja.clone()))
                .collect()
        })
    }

    fn compile(&mut self, app: &str) -> Vec<(ComponentIR, String)> {
        self.compile_with(app, HashMap::new())
    }
}

impl Drop for App {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// shadcn's Badge: `cva` + `cn`, both allowlisted packages.
const BADGE: &str = r#"import { cva } from "class-variance-authority"
import { cn } from "cn"
const badgeVariants = cva("inline-flex rounded-full", {
  variants: { variant: { default: "bg-primary", secondary: "bg-secondary", outline: "border" } },
  defaultVariants: { variant: "default" },
})
export function Badge({ className, variant, ...props }: { className?: string; variant?: "default" | "secondary" | "outline"; children?: any }) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
"#;

fn infos(ir: &ComponentIR) -> Vec<String> {
    ir.diagnostics
        .iter()
        .filter(|d| d.rule == "build-eval-instance")
        .map(|d| d.message.clone())
        .collect()
}

#[test]
fn a_literal_instance_of_an_allowlisted_job_is_a_candidate() {
    let mut a = App::new();
    a.file("badge.tsx", BADGE);
    let tree = a.compile(
        "import { Badge } from './badge'\nexport default function App() { return <div><Badge variant=\"secondary\">New</Badge><Badge>Old</Badge></div> }\n",
    );
    let root = &tree[0].0;
    let c = &root.build_eval_instances;
    assert_eq!(c.len(), 2, "{c:?}");
    assert_eq!(c[0].inputs, serde_json::json!({ "variant": "secondary" }));
    // R34.88: an omitted prop is absent, as the server drops `__undefined`.
    assert_eq!(c[1].inputs, serde_json::json!({}));
    assert_eq!(c[0].outputs, vec!["_s1".to_string()]);
    assert!(c[0].stubs.is_empty());
    assert!(c[0].key.starts_with("App.tsx@"));
    assert_ne!(c[0].key, c[1].key);
    // Until the build's values come back, the instances keep their records (and jobs).
    assert_eq!(root.instances.len(), 2);
    assert!(root.folded_instances.is_empty());
}

#[test]
fn a_module_const_input_folds_into_the_literals() {
    let mut a = App::new();
    a.file("badge.tsx", BADGE);
    let tree = a.compile(
        "import { Badge } from './badge'\nconst v = 'outline'\nconst compact = true\nexport default function App() { return <div><Badge variant={v} /><Badge variant={compact ? 'secondary' : 'default'} /></div> }\n",
    );
    let root = &tree[0].0;
    assert_eq!(root.instances[0].literals["variant"], "outline");
    assert!(root.instances[0].exprs.get("variant").is_none());
    let c = &root.build_eval_instances;
    assert_eq!(c.len(), 2, "{c:?}");
    assert_eq!(c[0].inputs, serde_json::json!({ "variant": "outline" }));
    assert_eq!(c[1].inputs, serde_json::json!({ "variant": "secondary" }));
}

#[test]
fn the_recompile_prints_the_values_and_drops_the_record() {
    let mut a = App::new();
    a.file("badge.tsx", BADGE);
    let app = "import { Badge } from './badge'\nexport default function App() { return <div><Badge variant=\"secondary\">New</Badge><Badge>Old</Badge></div> }\n";
    let first = a.compile(app);
    let c = first[0].0.build_eval_instances.clone();
    let mut values = HashMap::new();
    values.insert(
        format!("{}#_s1", c[0].key),
        serde_json::json!("inline-flex rounded-full bg-secondary"),
    );
    // The second instance's evaluation failed: it keeps its record and job.
    let tree = a.compile_with(app, values);
    let (root, jinja) = &tree[0];
    assert_eq!(root.folded_instances.len(), 1);
    assert_eq!(root.folded_instances[0].k, 1);
    assert_eq!(root.instances.len(), 1, "{:?}", root.instances);
    assert_eq!(root.instances[0].k, 2);
    assert!(
        jinja.contains("inline-flex rounded-full bg-secondary"),
        "{jinja}"
    );
    // The server numbers the remaining records by position (brust-core ordinal): the second call site's
    // record is now the first, so its slots are `__<child>_1`.
    let child = &root.folded_instances[0].child_id;
    assert!(jinja.contains(&format!("__{child}_1")), "{jinja}");
    assert!(!jinja.contains(&format!("__{child}_2")), "{jinja}");
    let out = render(jinja);
    assert!(
        out.contains(r#"class="inline-flex rounded-full bg-secondary""#),
        "{out}"
    );
}

/// Renders a page template with an empty context (folded slots need no job output).
fn render(jinja: &str) -> String {
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    env.render_str(jinja, brust_jinja::value_of(&serde_json::json!({})))
        .unwrap_or_else(|e| panic!("{e:#}\n{jinja}"))
}

#[test]
fn a_hostile_value_is_escaped_never_markup() {
    let mut a = App::new();
    a.file("badge.tsx", BADGE);
    let app = "import { Badge } from './badge'\nexport default function App() { return <Badge variant=\"secondary\">x</Badge> }\n";
    let first = a.compile(app);
    let key = first[0].0.build_eval_instances[0].key.clone();
    let mut values = HashMap::new();
    values.insert(
        format!("{key}#_s1"),
        serde_json::json!("\"><script>alert(1)</script> {{ 7*7 }} {% raw %} %}"),
    );
    let tree = a.compile_with(app, values);
    let jinja = &tree[0].1;
    // The value sits inside a jinja string literal; what matters is what renders.
    let out = render(jinja);
    assert!(!out.contains("49"), "{out}");
    assert!(!out.contains("<script>"), "{out}");
    assert!(out.contains("&lt;script&gt;"), "{out}");
}

#[test]
fn an_imported_cva_const_is_re_emitted_folded_without_its_module() {
    let mut a = App::new();
    a.file(
        "button.tsx",
        r#"import { Slot } from "radix-ui"
import { cva } from "class-variance-authority"
import { cn } from "cn"
export const buttonVariants = cva("inline-flex", { variants: { size: { sm: "h-8", icon: "size-9" } }, defaultVariants: { size: "sm" } })
export function Button({ className, size, ...props }: any) { return <button className={cn(buttonVariants({ size }), className)} {...props} /> }
"#,
    )
    .file(
        "link.tsx",
        r#"import { cn } from "cn"
import { buttonVariants } from "./button"
export function PageLink({ className, size = "icon", ...props }: any) { return <a className={cn(buttonVariants({ size }), className)} {...props} /> }
"#,
    );
    let tree = a.compile(
        "import { PageLink } from './link'\nexport default function App() { return <PageLink href=\"/2\">2</PageLink> }\n",
    );
    let c = &tree[0].0.build_eval_instances;
    assert_eq!(c.len(), 1, "{:?}", infos(&tree[0].0));
    let [stub] = c[0].stubs.as_slice() else {
        panic!("{:?}", c[0].stubs)
    };
    assert_eq!(stub.source, "./button");
    assert!(
        stub.code
            .contains("import { cva as __c0 } from \"class-variance-authority\""),
        "{}",
        stub.code
    );
    assert!(
        stub.code.contains("export const buttonVariants = __c0(\"inline-flex\", { \"variants\": { \"size\": { \"sm\": \"h-8\", \"icon\": \"size-9\" } }, \"defaultVariants\": { \"size\": \"sm\" } })"),
        "{}",
        stub.code
    );
    assert!(!stub.code.contains("radix"), "{}", stub.code);
}

#[test]
fn a_pure_relative_helper_and_lib_utils_are_bundled_whole() {
    let mut a = App::new();
    a.file(
        "lib/utils.ts",
        "import { clsx, type ClassValue } from \"clsx\"\nimport { twMerge } from \"tailwind-merge\"\nexport function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)) }\n",
    )
    .file(
        "tone.ts",
        "export function label(tone: string) { return tone === 'warn' ? 'text-amber-600' : 'text-slate-600' }\n",
    )
    .file(
        "note.tsx",
        "import { cn } from './lib/utils'\nimport { label } from './tone'\nexport function Note({ tone, className }: any) { return <p className={cn(label(tone), className)}>n</p> }\n",
    );
    let tree = a.compile(
        "import { Note } from './note'\nexport default function App() { return <Note tone=\"warn\" /> }\n",
    );
    let c = &tree[0].0.build_eval_instances;
    assert_eq!(c.len(), 1, "{:?}", infos(&tree[0].0));
    assert!(c[0].stubs.is_empty());
    assert_eq!(c[0].inputs, serde_json::json!({ "tone": "warn" }));
}

/// R34.92: each case keeps its per-request job, and says why when its inputs were constant.
#[test]
fn fail_closed_cases_keep_the_job() {
    // A props input: no candidate (and no info: a prop is per request by nature).
    let mut a = App::new();
    a.file("badge.tsx", BADGE);
    let tree = a.compile(
        "import { Badge } from './badge'\nexport default function App(props: { v: 'secondary' }) { return <Badge variant={props.v} /> }\n",
    );
    assert!(tree[0].0.build_eval_instances.is_empty());
    assert_eq!(tree[0].0.instances.len(), 1);
    assert!(infos(&tree[0].0).is_empty());

    // A package off the allowlist.
    let mut a = App::new();
    a.file(
        "chip.tsx",
        "import { tone } from 'tones'\nimport { cn } from 'cn'\nexport function Chip({ className }: any) { return <i className={cn(tone, className)} /> }\n",
    );
    let tree = a.compile(
        "import { Chip } from './chip'\nexport default function App() { return <Chip /> }\n",
    );
    assert!(tree[0].0.build_eval_instances.is_empty());
    assert_eq!(tree[0].0.instances.len(), 1);
    let why = infos(&tree[0].0);
    assert!(why.iter().any(|m| m.contains("`tones`")), "{why:?}");

    // `@/lib/utils` before tsconfig paths resolve it reads as a package (ruling Q5).
    let mut a = App::new();
    a.file(
        "chip.tsx",
        "import { cn } from '@/lib/utils'\nexport function Chip({ className }: any) { return <i className={cn('a', className)} /> }\n",
    );
    let tree = a.compile(
        "import { Chip } from './chip'\nexport default function App() { return <Chip /> }\n",
    );
    assert!(tree[0].0.build_eval_instances.is_empty());
    let why = infos(&tree[0].0);
    assert!(why.iter().any(|m| m.contains("`@/lib/utils`")), "{why:?}");

    // A denied global in a module const the job reads.
    let mut a = App::new();
    a.file(
        "chip.tsx",
        "import { cn } from 'cn'\nconst stamp = Date.now() > 0 ? 'a' : 'b'\nexport function Chip({ className }: any) { return <i className={cn(stamp, className)} /> }\n",
    );
    let tree = a.compile(
        "import { Chip } from './chip'\nexport default function App() { return <Chip /> }\n",
    );
    assert!(tree[0].0.build_eval_instances.is_empty());
    let why = infos(&tree[0].0);
    // F215 allowlist: the child's module is not clean (a load-time call / a `let`), so it falls back
    // `module-side-effect` before build evaluation is asked; either way nothing is evaluated.
    assert!(
        why.iter().any(|m| m.contains("`Date`"))
            || tree.iter().any(|t| t
                .0
                .diagnostics
                .iter()
                .any(|d| d.rule == "module-side-effect")),
        "{why:?}"
    );

    // A relative module that is neither pure nor a foldable const.
    let mut a = App::new();
    a.file("state.ts", "export let n = 0\nexport function bump() { return ++n }\n")
        .file(
            "chip.tsx",
            "import { cn } from 'cn'\nimport { bump } from './state'\nexport function Chip({ className }: any) { return <i className={cn(String(bump()), className)} /> }\n",
        );
    let tree = a.compile(
        "import { Chip } from './chip'\nexport default function App() { return <Chip /> }\n",
    );
    assert!(tree[0].0.build_eval_instances.is_empty());
    let why = infos(&tree[0].0);
    // F215 allowlist: the child's module is not clean (a load-time call / a `let`), so it falls back
    // `module-side-effect` before build evaluation is asked; either way nothing is evaluated.
    assert!(
        why.iter().any(|m| m.contains("./state"))
            || tree.iter().any(|t| t
                .0
                .diagnostics
                .iter()
                .any(|d| d.rule == "module-side-effect")),
        "{why:?}"
    );

    // A child with useId values.
    let mut a = App::new();
    a.file(
        "field.tsx",
        "import { useId } from 'react'\nimport { cn } from 'cn'\nexport function Field({ className }: any) { const id = useId(); return <input id={id} className={cn('f', className)} /> }\n",
    );
    let tree = a.compile(
        "import { Field } from './field'\nexport default function App() { return <Field /> }\n",
    );
    assert!(tree[0].0.build_eval_instances.is_empty());

    // A row-reading instance over a constant list (`per-row-literal`, ruling Q4).
    let mut a = App::new();
    a.file("badge.tsx", BADGE);
    let tree = a.compile(
        "import { Badge } from './badge'\nconst rows = [{ v: 'secondary' }, { v: 'outline' }]\nexport default function App() { return <div>{rows.map((r) => <Badge key={r.v} variant={r.v} />)}</div> }\n",
    );
    assert!(tree[0].0.build_eval_instances.is_empty());
}

#[test]
fn a_row_invariant_instance_in_a_list_is_a_candidate() {
    let mut a = App::new();
    a.file("badge.tsx", BADGE);
    let tree = a.compile(
        "import { Badge } from './badge'\nconst rows = ['a', 'b']\nexport default function App() { return <div>{rows.map((r) => <Badge key={r} variant=\"outline\">{r}</Badge>)}</div> }\n",
    );
    let c = &tree[0].0.build_eval_instances;
    assert_eq!(c.len(), 1, "{c:?}");
    assert_eq!(c[0].inputs, serde_json::json!({ "variant": "outline" }));
}
