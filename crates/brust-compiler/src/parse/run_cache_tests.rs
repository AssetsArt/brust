//! F620: the run's source table and the per-module memos answer exactly what a fresh read and parse answers.
use super::{ParseCache, parse_file, run_on_compiler_thread};
use crate::analyze::component::AnalyzeOptions;
use crate::analyze::exports::{Binding, find};
use crate::analyze::modules::ModuleCache;
use std::cell::RefCell;

/// A temp app dir, removed when dropped.
struct Dir(std::path::PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn app(name: &str) -> (Dir, AnalyzeOptions) {
    let dir =
        Dir(std::env::temp_dir().join(format!("brust-run-cache-{}-{name}", std::process::id())));
    let _ = std::fs::remove_dir_all(&dir.0);
    std::fs::create_dir_all(&dir.0).unwrap();
    let w = |rel: &str, text: &str| std::fs::write(dir.0.join(rel), text).unwrap();
    w(
        "a.ts",
        "export function useA() { return 1 }\nexport const x = 1\nexport default function D() { return null }\n",
    );
    w(
        "b.ts",
        "export { useA as useB, useA as useB } from './a'\nimport { x as y, useA as h } from './a'\nexport { y as z, h as useH }\nexport * from './c'\n",
    );
    w(
        "c.ts",
        "export function useC() { return 2 }\nexport function useA() { return 3 }\n",
    );
    w("shadow.ts", "export const useC = 3\nexport * from './c'\n");
    w(
        "barrel.ts",
        "export * from './missing'\nexport * from './shadow'\nexport * from './b'\nexport * as ns from './c'\n",
    );
    w(
        "loop1.ts",
        "export * from './loop2'\nexport { q } from './loop2'\n",
    );
    w(
        "loop2.ts",
        "export * from './loop1'\nexport { q } from './loop1'\n",
    );
    w(
        "s.ts",
        "import { defineStore, signal } from '@brust/core/store'\nexport const count = defineStore('count', () => ({ n: signal(0) }))\nconst plain = 1\nexport { plain }\nexport default defineStore('d', () => ({ m: signal(1) }))\n",
    );
    w(
        "sb.ts",
        "export * from './s'\nexport { count as renamed } from './s'\nexport * as all from './s'\nexport * from './loop1'\n",
    );
    w("broken.ts", "export const = \n");
    let opts = AnalyzeOptions {
        root: dir.0.clone(),
        ..Default::default()
    };
    (dir, opts)
}

const NAMES: &[&str] = &[
    "useA", "useB", "useC", "useH", "z", "x", "default", "nope", "ns", "q", "count", "renamed",
    "all", "plain",
];
const MODULES: &[&str] = &[
    "barrel.ts",
    "b.ts",
    "sb.ts",
    "s.ts",
    "loop1.ts",
    "missing.ts",
    "broken.ts",
    "a.ts",
];

/// Every question of the two memoised walks (`hooks::follow_export`, `stores::read_store_export` /
/// `exports_a_store`) and of the source table, in a fixed order.
fn answers(opts: &AnalyzeOptions) -> Vec<String> {
    let declared = |ast: &bun_ast::Ast<'_>, n: &str| matches!(find(ast, n), Binding::Fn(_));
    let mut out = Vec::new();
    for m in MODULES {
        for n in NAMES {
            let f =
                crate::analyze::hooks::follow_export(opts, m.to_string(), n.to_string(), &declared);
            out.push(format!("hook {m} {n}: {f:?}"));
            // A fresh `ModuleCache` per question: its own memo must not answer for the run cache.
            let modules = RefCell::new(ModuleCache::default());
            let s = crate::analyze::stores::read_store_export(m, n, opts, &modules);
            out.push(format!("store {m} {n}: {s:?}"));
        }
        let modules = RefCell::new(ModuleCache::default());
        out.push(format!(
            "exports_a_store {m}: {}",
            crate::analyze::stores::exports_a_store(m, opts, &modules)
        ));
        let p = match parse_file(&opts.root, m) {
            Ok(p) => format!("parsed {}", p.text().len()),
            Err(super::FileError::Read(e)) => format!("read {e} {:?}", e.kind()),
            Err(super::FileError::Parse(e)) => {
                format!("parse {} {}:{}", e.message, e.line, e.column)
            }
        };
        out.push(format!("file {m}: {p}"));
    }
    out
}

#[test]
fn memoised_answers_equal_fresh_answers() {
    let (_dir, opts) = app("memo");
    run_on_compiler_thread(|| {
        let fresh = answers(&opts);
        let _cache = ParseCache::enter();
        let first = answers(&opts);
        let again = answers(&opts);
        assert_eq!(fresh, first, "with the run cache open, first ask");
        assert_eq!(
            fresh, again,
            "with the run cache open, asked again (memo hits)"
        );
    });
}

#[test]
fn unreadable_file_error_is_the_read_error() {
    let (_dir, opts) = app("unreadable");
    run_on_compiler_thread(|| {
        let io = std::fs::read(opts.root.join("missing.ts"))
            .unwrap_err()
            .to_string();
        let open = || match parse_file(&opts.root, "missing.ts") {
            Err(super::FileError::Read(e)) => e.to_string(),
            _ => panic!("missing.ts must not read"),
        };
        assert_eq!(open(), io);
        let _cache = ParseCache::enter();
        assert_eq!(open(), io);
        assert_eq!(open(), io, "kept for the run");
    });
}

#[test]
fn a_run_reads_each_file_once_and_closes_with_its_guard() {
    let (_dir, opts) = app("once");
    run_on_compiler_thread(|| {
        {
            let _cache = ParseCache::enter();
            let a = parse_file(&opts.root, "a.ts").unwrap();
            // Changed on disk during the run: the run keeps what it read (a run is one native call).
            std::fs::write(opts.root.join("a.ts"), "export const changed = 1\n").unwrap();
            let b = parse_file(&opts.root, "a.ts").unwrap();
            assert!(std::rc::Rc::ptr_eq(&a, &b));
        }
        // The next run reads the file again.
        let c = parse_file(&opts.root, "a.ts").unwrap();
        assert_eq!(c.text(), b"export const changed = 1\n");
    });
}
