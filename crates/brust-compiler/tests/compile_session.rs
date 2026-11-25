//! F621: one compiler session (thread and parse cache) across the native calls of a build. Each call is an epoch: a file
//! changed, created or removed between two calls is seen as without the session, a file left alone is not read or
//! parsed again, and a compile answers byte for byte what it answers without a session.
use brust_compiler::analyze::aliases::{PathAlias, Scope};
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::parse::{
    FileError, close_session, open_session, parse_file, run_on_compiler_thread, session_open,
};
use brust_compiler::pipeline::compile_tree;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The session is process-wide: the tests of this file take turns.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

struct App(PathBuf);

impl Drop for App {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn app(name: &str) -> App {
    let root = std::env::temp_dir().join(format!("brust-session-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("lib")).unwrap();
    App(root)
}

fn write(root: &Path, rel: &str, text: &str) {
    std::fs::write(root.join(rel), text).unwrap();
}

/// One native call: the text `parse_file` gives for `rel`, or the read / parse error.
fn read(root: &Path, rel: &str) -> String {
    let root = root.to_path_buf();
    let rel = rel.to_string();
    run_on_compiler_thread(move || match parse_file(&root, &rel) {
        Ok(p) => String::from_utf8_lossy(p.text()).into_owned(),
        Err(FileError::Read(e)) => format!("read error: {e}"),
        Err(FileError::Parse(e)) => format!("parse error: {}", e.message),
    })
}

/// One native call under the app's `@/*` alias: the import paths of `rel` after rewriting, and how many parses the call
/// made.
fn imports(root: &Path, rel: &str) -> (Vec<String>, u32) {
    let root = root.to_path_buf();
    let rel = rel.to_string();
    run_on_compiler_thread(move || {
        let aliases = vec![PathAlias {
            pattern: "@/*".into(),
            targets: vec!["./*".into()],
        }];
        let _scope = Scope::enter(&root, &aliases);
        let _cache = brust_compiler::parse::ParseCache::enter();
        let p = parse_file(&root, &rel).expect("parses");
        (
            p.import_paths().to_vec(),
            brust_compiler::stats::take().total_parses(),
        )
    })
}

#[test]
fn a_file_changed_created_or_removed_between_calls_is_seen() {
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let a = app("stale");
    let root = &a.0;
    write(root, "a.ts", "export const a = 1\n");
    write(root, "gone.ts", "export const g = 1\n");
    let missing = std::fs::read(root.join("new.ts")).unwrap_err().to_string();
    open_session();
    assert!(session_open());
    assert_eq!(read(root, "a.ts"), "export const a = 1\n");
    assert_eq!(read(root, "new.ts"), format!("read error: {missing}"));
    assert_eq!(read(root, "gone.ts"), "export const g = 1\n");
    // Between two calls: one file changes, one appears, one disappears.
    write(root, "a.ts", "export const a = 22\n");
    write(root, "new.ts", "export const n = 1\n");
    std::fs::remove_file(root.join("gone.ts")).unwrap();
    assert_eq!(
        read(root, "a.ts"),
        "export const a = 22\n",
        "a changed file is read again"
    );
    assert_eq!(
        read(root, "new.ts"),
        "export const n = 1\n",
        "a file that appeared is read"
    );
    assert_eq!(
        read(root, "gone.ts"),
        format!("read error: {missing}").replace("new.ts", "gone.ts"),
        "a file that disappeared is an error, as without the session"
    );
    close_session();
    assert!(!session_open());
    // Without the session: the same answers.
    assert_eq!(read(root, "a.ts"), "export const a = 22\n");
    assert_eq!(read(root, "gone.ts"), format!("read error: {missing}"));
}

#[test]
fn an_unchanged_file_is_not_parsed_again_and_an_alias_target_that_appears_is_seen() {
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let a = app("alias");
    let root = &a.0;
    write(
        root,
        "page.ts",
        "import { x } from '@/lib/x'\nexport const y = x\n",
    );
    open_session();
    // `@/lib/x` names no file yet: it stays a package specifier.
    let (first, parses) = imports(root, "page.ts");
    assert_eq!(first, vec!["@/lib/x".to_string()]);
    assert_eq!(parses, 1);
    // A later call under the same alias configuration reuses the parse (Mellow: cross-call hits, not assumed).
    let (again, parses) = imports(root, "page.ts");
    assert_eq!(again, first);
    assert_eq!(parses, 0, "an unchanged file is not parsed again");
    // The alias target appears between two calls: the page's own text is unchanged, its parse is not reused.
    write(root, "lib/x.ts", "export const x = 1\n");
    let (now, parses) = imports(root, "page.ts");
    assert_eq!(now, vec!["./lib/x.ts".to_string()]);
    assert_eq!(parses, 1);
    close_session();
    let (without, _) = imports(root, "page.ts");
    assert_eq!(without, now, "as without the session");
}

#[test]
fn a_panic_is_raised_on_the_caller_and_the_session_goes_on() {
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let a = app("panic");
    write(&a.0, "a.ts", "export const a = 1\n");
    open_session();
    let r = std::panic::catch_unwind(|| run_on_compiler_thread(|| panic!("boom")));
    let msg = r.unwrap_err();
    assert_eq!(msg.downcast_ref::<&str>(), Some(&"boom"));
    assert_eq!(read(&a.0, "a.ts"), "export const a = 1\n");
    close_session();
}

/// A small app: a page over a barrel, a context, helpers, a store; written fresh.
fn write_app(root: &Path) {
    std::fs::create_dir_all(root.join("parts")).unwrap();
    write(
        root,
        "ctx.ts",
        "import { createContext } from 'react'\nexport const Tone = createContext<{ tone: string } | null>(null)\n",
    );
    write(
        root,
        "lib/format.ts",
        "export function fmt(v: string) {\n  return v.trim().toUpperCase()\n}\n",
    );
    write(
        root,
        "lib/tokens.ts",
        "export const TOKENS = { gap: 'g-2' }\n",
    );
    write(
        root,
        "stores.ts",
        "import { defineStore, signal } from '@brust/core/store'\nexport const count = defineStore('count', () => ({ n: signal(0) }))\n",
    );
    write(
        root,
        "parts/a.tsx",
        "import { useContext } from 'react'\nimport { useStore } from '@brust/core/store/react'\nimport { Tone } from '../ctx'\nimport { fmt } from '@/lib/format'\nimport { TOKENS } from '@/lib/tokens'\nimport { count } from '../stores'\nexport function A() {\n  const t = useContext(Tone)\n  const s = useStore(count)\n  return <section class={TOKENS.gap} data-tone={t?.tone} data-n={s.n}>{fmt(' a ')}</section>\n}\n",
    );
    write(
        root,
        "parts/index.ts",
        "export { A } from './a'\nexport * from './b'\n",
    );
    write(
        root,
        "parts/b.tsx",
        "export function B({ n }: { n: number }) {\n  return <b>{n}</b>\n}\n",
    );
    write(
        root,
        "page.tsx",
        "import { A, B } from './parts'\nimport { Tone } from './ctx'\nexport default function Page() {\n  return (\n    <Tone.Provider value={{ tone: 'x' }}>\n      <main><A /><B n={2} /></main>\n    </Tone.Provider>\n  )\n}\n",
    );
}

/// One native call: everything `compile_tree` produced, printed.
fn compiled(root: &Path, entry: &str) -> String {
    let opts = AnalyzeOptions {
        root: root.to_path_buf(),
        path_aliases: vec![PathAlias {
            pattern: "@/*".into(),
            targets: vec!["./*".into()],
        }],
        ..Default::default()
    };
    let entry = entry.to_string();
    run_on_compiler_thread(move || {
        match compile_tree(&entry, None, &opts, "/_brust/client/runtime.js") {
            Err(d) => format!("error {d:?}"),
            Ok(tree) => tree
                .iter()
                .map(|l| {
                    format!(
                        "{}\n{}\n{}\n{:?}\n{:?}\n{:?}\n",
                        l.ir.id,
                        serde_json::to_string(&*l.ir).unwrap(),
                        l.artifacts.jinja,
                        l.artifacts.client_js,
                        l.artifacts.server_ts,
                        l.artifacts.diagnostics
                    )
                })
                .collect(),
        }
    })
}

#[test]
fn a_compile_in_a_session_answers_what_it_answers_without_one() {
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let a = app("compile");
    let root = &a.0;
    write_app(root);
    let fresh = compiled(root, "page.tsx");
    let fresh_b = compiled(root, "parts/b.tsx");
    open_session();
    assert_eq!(compiled(root, "page.tsx"), fresh, "first call");
    assert_eq!(
        compiled(root, "parts/b.tsx"),
        fresh_b,
        "another entry, same session"
    );
    assert_eq!(
        compiled(root, "page.tsx"),
        fresh,
        "again, from the kept parses"
    );
    // A module changes between two calls: the session compiles what a fresh compile does.
    write(
        root,
        "parts/b.tsx",
        "export function B({ n }: { n: number }) {\n  return <i>{n + 1}</i>\n}\n",
    );
    let in_session = compiled(root, "page.tsx");
    close_session();
    let changed = compiled(root, "page.tsx");
    assert_ne!(changed, fresh);
    assert_eq!(in_session, changed);
}
