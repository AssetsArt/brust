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

/// PR2 (Mellow F3): an imported `export const` list, read from its module as written, is declared projected in the
/// chunk instead of imported, so the data module is not bundled.
#[test]
fn an_imported_list_is_declared_projected_instead_of_imported() {
    for f in ["imported.tsx", "imported_alias.tsx"] {
        let c = native(f);
        assert!(
            c.contains(r#"const ITEMS = [{ id: 1, name: "a" }, { id: 2, name: "b" }];"#),
            "{f}: {c}"
        );
        assert!(
            !c.contains("import { ITEMS }") && !c.contains("SECRET"),
            "{f}: {c}"
        );
    }
}

/// PR2, C1: the import stays (the data module is bundled whole, as before) when its module writes the list (at load or in
/// a function), runs anything at load or imports another module (Afrojack), when the
/// value has a name in it, or when the chunk's own use is not recognised (a row bare; another printed declaration reads it, F1).
#[test]
fn an_imported_list_its_module_writes_or_the_chunk_uses_whole_stays_imported() {
    for f in [
        "imported_mut.tsx",
        "imported_env.tsx",
        "imported_whole.tsx",
        "imported_helper.tsx",
        // the module runs something at load the chunk would no longer run, or writes the list in a function body
        "imported_effect.tsx",
        "imported_import.tsx",
        "imported_fnwrite.tsx",
    ] {
        let c = native(f);
        assert!(c.contains("import { ITEMS } from"), "{f}: {c}");
        assert!(!c.contains("const ITEMS"), "{f}: {c}");
    }
}

/// C4 + C5: the value is read from the data module's source on every compile (an edit is seen; `brust dev` rebuilds the
/// whole app on each change) and nothing runs, so two compiles of the same source print the same bytes.
#[test]
fn an_imported_list_follows_its_source_and_prints_the_same_bytes_twice() {
    let first = native("imported.tsx");
    assert_eq!(first, native("imported.tsx"));
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/module-projection");
    let tmp = dir.join("zz_edit");
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::copy(dir.join("imported.tsx"), tmp.join("imported.tsx")).unwrap();
    let data = std::fs::read_to_string(dir.join("data.ts")).unwrap();
    std::fs::write(tmp.join("data.ts"), &data).unwrap();
    let before = native("zz_edit/imported.tsx");
    std::fs::write(
        tmp.join("data.ts"),
        data.replace("name: 'a'", "name: 'edited'"),
    )
    .unwrap();
    let after = native("zz_edit/imported.tsx");
    std::fs::remove_dir_all(&tmp).unwrap();
    assert!(before.contains(r#"name: "a""#), "{before}");
    assert!(
        after.contains(r#"name: "edited""#) && !after.contains("SECRET"),
        "{after}"
    );
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
