//! F622 D5: a pool of compiler threads compiles each route tree byte for byte as one thread does, whatever the number of
//! threads and whatever thread takes which entry: the same 8 entries, 20 times at 8 threads, against 1 thread; with and
//! without a compiler session.
use brust_compiler::analyze::aliases::PathAlias;
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::parse::{
    close_session, in_entry_order, open_session, run_on_pool, run_on_pool_caught,
};
use brust_compiler::pipeline::compile_tree;
use std::path::{Path, PathBuf};

fn write(root: &Path, rel: &str, text: &str) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

/// Eight pages over shared modules: a barrel, a context, helpers, a store, components that several pages render.
fn write_app(root: &Path) -> Vec<String> {
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
        "export const TOKENS = { gap: 'g-2', pad: 'p-2' }\n",
    );
    write(
        root,
        "stores.ts",
        "import { defineStore, signal } from '@brust/core/store'\nexport const count = defineStore('count', () => ({ n: signal(0) }))\n",
    );
    write(
        root,
        "parts/card.tsx",
        "import { useContext } from 'react'\nimport { useStore } from '@brust/core/store/react'\nimport { Tone } from '../ctx'\nimport { fmt } from '@/lib/format'\nimport { TOKENS } from '@/lib/tokens'\nimport { count } from '../stores'\nexport function Card({ title }: { title: string }) {\n  const t = useContext(Tone)\n  const s = useStore(count)\n  return <section class={TOKENS.gap} data-tone={t?.tone} data-n={s.n}>{fmt(title)}</section>\n}\n",
    );
    write(
        root,
        "parts/badge.tsx",
        "export function Badge({ n }: { n: number }) {\n  return <b class=\"badge\">{n}</b>\n}\n",
    );
    write(
        root,
        "parts/index.ts",
        "export { Card } from './card'\nexport * from './badge'\n",
    );
    let mut pages = Vec::new();
    for i in 0..8 {
        let extra = "<Badge n={1} />".repeat(i + 1);
        write(
            root,
            &format!("pages/p{i}.tsx"),
            &format!(
                "import {{ Card, Badge }} from '../parts'\nimport {{ Tone }} from '../ctx'\nexport default function P{i}() {{\n  return (\n    <Tone.Provider value={{{{ tone: 't{i}' }}}}>\n      <main><Card title=\" page {i} \" />{extra}</main>\n    </Tone.Provider>\n  )\n}}\n"
            ),
        );
        pages.push(format!("pages/p{i}.tsx"));
    }
    pages
}

fn compile_all(threads: usize, pages: &[String], opts: &AnalyzeOptions) -> Vec<String> {
    let order = pages
        .iter()
        .enumerate()
        .map(|(i, _)| ((i % 3) as u64, i))
        .collect();
    run_on_pool(threads, pages.len(), order, |i| {
        match compile_tree(&pages[i], None, opts, "/_brust/client/runtime.js") {
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
fn every_entry_compiles_the_same_at_one_and_at_eight_threads() {
    let root: PathBuf = std::env::temp_dir().join(format!("brust-pool-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let pages = write_app(&root);
    let opts = AnalyzeOptions {
        root: root.clone(),
        path_aliases: vec![PathAlias {
            pattern: "@/*".into(),
            targets: vec!["./*".into()],
        }],
        ..Default::default()
    };
    let one = compile_all(1, &pages, &opts);
    assert!(one.iter().all(|t| !t.starts_with("error")), "{one:?}");
    for round in 0..20 {
        assert_eq!(
            compile_all(8, &pages, &opts),
            one,
            "round {round}, threads of the call"
        );
    }
    // The same in a session (its threads keep their caches across the calls).
    // SAFETY: the only test of this binary; nothing else reads the environment meanwhile.
    unsafe { std::env::set_var("BRUST_COMPILE_THREADS", "8") };
    open_session();
    for round in 0..20 {
        assert_eq!(compile_all(8, &pages, &opts), one, "round {round}, session");
    }
    close_session();
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn every_entry_runs_and_keeps_its_own_failure() {
    // N3: an entry's panic is that entry's result; the thread goes on, so no entry is left without one.
    let order = (0..12).map(|i| (0, i)).collect();
    let results = run_on_pool_caught(4, 12, order, |i| {
        if i == 5 || i == 9 {
            panic!("entry {i}");
        }
        i * 10
    });
    assert_eq!(results.len(), 12);
    for (i, r) in results.into_iter().enumerate() {
        match r {
            Ok(v) => assert_eq!(v, i * 10),
            Err(p) => {
                assert!(i == 5 || i == 9, "entry {i} panicked");
                assert_eq!(
                    p.downcast_ref::<String>().map(String::as_str),
                    Some(format!("entry {i}").as_str())
                );
            }
        }
    }
}

/// What the caller of a pool sees for `kinds` (one per entry: "ok", "error", "panic") at `threads`: the entries up to the
/// first failure, or the panic message when the first failure is a panic.
fn outcome(kinds: &[&str], threads: usize) -> Result<Vec<String>, String> {
    let order = (0..kinds.len())
        .map(|i| ((kinds.len() - i) as u64, i))
        .collect();
    let results = run_on_pool_caught(threads, kinds.len(), order, |i| {
        if kinds[i] == "panic" {
            // A later entry takes longer, so at 8 threads it fails before an earlier one is done.
            panic!("compiler panic in entry {i}");
        }
        std::thread::sleep(std::time::Duration::from_millis(
            20 * (kinds.len() - i) as u64,
        ));
        format!("{} {i}", kinds[i])
    });
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        in_entry_order(
            results,
            |t: &String| t.starts_with("error"),
            || "unreached".to_string(),
        )
    }))
    .map_err(|p| p.downcast_ref::<String>().cloned().unwrap_or_default())
}

#[test]
fn the_first_failing_entry_by_index_wins_at_any_number_of_threads() {
    // [ok, BuildError, panic]: the error of entry 1, never the later panic; [ok, panic, error]: the panic of entry 1.
    for kinds in [
        &["ok", "error", "panic"][..],
        &["ok", "panic", "error"],
        &["panic", "ok", "panic", "error"],
        &["ok", "ok", "error", "ok", "panic", "panic"],
        &["ok", "ok", "ok"],
    ] {
        let one = outcome(kinds, 1);
        for _ in 0..10 {
            assert_eq!(outcome(kinds, 8), one, "{kinds:?}");
        }
    }
    assert_eq!(
        outcome(&["ok", "error", "panic"], 8),
        Ok(vec![
            "ok 0".to_string(),
            "error 1".to_string(),
            "unreached".to_string()
        ])
    );
    // A lone panic comes back with its own message, as it left the compile.
    assert_eq!(
        outcome(&["ok", "panic", "error"], 8),
        Err("compiler panic in entry 1".to_string())
    );
}
