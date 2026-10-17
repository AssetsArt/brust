//! F362: a module list the client rows run over ships only the keys the chunk reads (`lower/module_projection.rs`). Every
//! projected page keeps what its rows read and drops the rest (`secret`, never read); every shape the scan does not
//! recognise ships the list whole, as before (C1: the unread field IS in the chunk). The served side (== React, no
//! client script carries the unread field) is tests/server/module-projection.chromium.test.ts.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::Tier;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

/// The page's tier and every client script the tree emits (chunks and shared modules), concatenated.
fn compile(file: &str) -> (Tier, String) {
    let path = format!("crates/brust-compiler/tests/fixtures/module-projection/{file}");
    run_on_compiler_thread(move || {
        let out = compile_tree(
            &path,
            None,
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        let mut client = String::new();
        for l in &out {
            client.push_str(l.artifacts.client_js.as_deref().unwrap_or_default());
            for (_, code) in &l.artifacts.client_modules {
                client.push_str(code);
            }
        }
        (out[0].ir.tier.clone(), client)
    })
}

fn native(file: &str) -> String {
    let (tier, client) = compile(file);
    assert!(matches!(tier, Tier::Native), "{file}: {tier:?}");
    client
}

/// The rows read `id` (key, handler) and `name` (cell): the chunk prints exactly those keys.
#[test]
fn rows_over_a_module_list_ship_the_keys_they_read() {
    let c = native("rows.tsx");
    assert!(
        c.contains(r#"const ITEMS = [{ id: 1, name: "a" }, { id: 2, name: "b" }];"#),
        "{c}"
    );
    assert!(!c.contains("SECRET"), "{c}");
}

/// A key read only by the list's key function is kept (`slug`): adopting the server's rows matches them by it.
#[test]
fn a_key_read_only_by_the_key_function_is_kept() {
    let c = native("key_only.tsx");
    assert!(c.contains(r#"slug: "k1""#) && !c.contains("SECRET"), "{c}");
}

/// A key read only in a row's handler is kept (`code`); `ITEMS.length` reads no key.
#[test]
fn a_key_read_only_in_a_handler_is_kept() {
    let c = native("handler_only.tsx");
    assert!(
        c.contains(r#"code: "C1""#) && c.contains(r#"name: "a""#),
        "{c}"
    );
    assert!(!c.contains("SECRET"), "{c}");
    // (`ITEMS.length` itself folds at build: the list stays a source only.)
    let c = native("length.tsx");
    assert!(
        c.contains(r#"[{ id: 1, name: "a" }, "#) && !c.contains("SECRET"),
        "{c}"
    );
}

/// `it.meta.label` keeps `meta` whole (no nested projection), so what `meta` holds stays; the rest goes.
#[test]
fn a_nested_read_keeps_its_first_key_whole() {
    let c = native("nested.tsx");
    assert!(
        c.contains("SECRET_M") && c.contains(r#"label: "L1""#),
        "{c}"
    );
    assert!(!c.contains("SECRET_A") && !c.contains("name:"), "{c}");
}

/// F361's shapes (Mellow F4): a host clone in the rows (shape 1) and a stateful child (shape 2): the row's link closure
/// `_pN = (it) => ({ … })` is a row closure like the cells.
#[test]
fn a_row_link_closure_is_scanned_like_a_cell() {
    for f in ["clone.tsx", "child_rows.tsx"] {
        let c = native(f);
        assert!(
            c.contains(r#"const ITEMS = [{ id: 1 }, { id: 2 }];"#),
            "{f}: {c}"
        );
        assert!(!c.contains("SECRET"), "{f}: {c}");
    }
}

/// C1: every shape the scan does not recognise ships the list as written (the unread field is in the chunk).
#[test]
fn every_unrecognised_use_ships_the_list_whole() {
    for f in [
        // the row value whole: a handler argument, a child's prop (F4)
        "stop_whole_arg.tsx",
        "stop_tag_whole.tsx",
        // computed access, a method called on a row's chain (F2)
        "stop_index.tsx",
        "stop_method.tsx",
        // the list other than as a source or `.length`
        "stop_find.tsx",
        "stop_list_method.tsx",
        "stop_alias.tsx",
        // code printed as written, another printed declaration (F1)
        "stop_block.tsx",
        "stop_opaque_list.tsx",
        // a ref's initial value, evaluated on the client outside the members (Afrojack, PR1 review)
        "stop_ref_init.tsx",
        // a derived value only a ref init or an effect's deps read (Mellow, PR1 review)
        "stop_ref_derived.tsx",
        "stop_effect_dep.tsx",
        "stop_helper.tsx",
        // a value with a name in it
        "stop_not_literal.tsx",
    ] {
        let c = native(f);
        assert!(c.contains("SECRET_B"), "{f}: {c}");
    }
}

/// PR1 projects module consts only: an imported list keeps its import (PR2).
#[test]
fn an_imported_list_is_not_projected_yet() {
    let c = native("imported.tsx");
    assert!(c.contains(r#"import { ITEMS } from "./data""#), "{c}");
    assert!(!c.contains("const ITEMS"), "{c}");
}

/// A derived value only a ref's initial value or an effect's deps read is declared in the chunk (Mellow, PR1 review):
/// both run on the client, so they are code roots like a handler. Before, `s0()` was called but never declared.
#[test]
fn a_derived_value_only_a_ref_init_or_an_effect_dep_reads_is_declared() {
    for f in ["stop_ref_derived.tsx", "stop_effect_dep.tsx"] {
        let c = native(f);
        assert!(c.contains("const s0 = "), "{f}: {c}");
    }
}
