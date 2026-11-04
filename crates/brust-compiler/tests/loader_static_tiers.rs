//! F494: a stateless child a page feeds only fixed values (a stateless page's loader data, rows of a list the client
//! never re-creates) is cloned for that call site with every prop fixed, and the clone lowers static: its rows lose their
//! links (List), a helper over a row prop rides a per-row instance record rebased onto the page's props (PriceList), and a
//! static child in a row of the clone has its fed child's record fed per row of that list (PageView → SectionView →
//! Price). The shared component keeps its own tier for callers that pass changing values (StatefulList). Served == React:
//! tests/server/loader-static-tiers.chromium.test.ts.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{ComponentIR, Tier};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

struct Item {
    ir: ComponentIR,
    jinja: String,
}

fn compile(file: &str) -> Vec<Item> {
    let path = format!("crates/brust-compiler/tests/fixtures/loader-static/{file}");
    run_on_compiler_thread(move || {
        compile_tree(
            &path,
            None,
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap()
        .into_iter()
        .map(|l| Item {
            ir: (*l.ir).clone(),
            jinja: l.artifacts.jinja.clone(),
        })
        .collect()
    })
}

fn clones<'a>(all: &'a [Item], of: &str) -> Vec<&'a Item> {
    all.iter()
        .filter(|i| {
            i.ir.specialised && i.ir.id.starts_with(&format!("{of}_")) && i.ir.id.contains("_f")
        })
        .collect()
}

fn shared<'a>(all: &'a [Item], of: &str) -> Option<&'a Item> {
    all.iter()
        .find(|i| !i.ir.specialised && i.ir.id.split('_').next() == Some(of))
}

fn assert_static_page(all: &[Item], child: &str) {
    assert!(
        matches!(all[0].ir.tier, Tier::Static),
        "{:?}",
        all[0].ir.tier
    );
    let c = clones(all, child);
    assert_eq!(c.len(), 1, "one clone of {child}");
    assert!(matches!(c[0].ir.tier, Tier::Static), "{:?}", c[0].ir.tier);
    assert!(c[0].ir.child_links.is_empty());
    // Every call site of this tree took the clone: the shared component is not part of the tree.
    assert!(shared(all, child).is_none(), "shared {child} still lowered");
}

#[test]
fn a_list_fed_loader_data_is_static() {
    let all = compile("ListPage.tsx");
    assert_static_page(&all, "list");
    assert!(!all[0].jinja.contains("x-for"), "{}", all[0].jinja);
}

#[test]
fn a_row_helper_over_fixed_props_rides_a_per_row_record_of_the_page() {
    let all = compile("PriceListPage.tsx");
    assert_static_page(&all, "priceList");
    let rec = &all[0].ir.instances;
    assert_eq!(rec.len(), 1, "{rec:?}");
    assert!(rec[0].child_id.starts_with("price_"));
    assert_eq!(rec[0].loops, vec![Some("data.sections".to_string())]);
    assert_eq!(
        rec[0].props.get("price"),
        Some(&Some("data.sections[idx].data.price".to_string()))
    );
    let j = &all[0].jinja;
    assert!(j.contains("{% set _i1 = loop.index0 %}"), "{j}");
    assert!(j.contains("_1[_i1][\"_s1\"]"), "{j}");
}

#[test]
fn a_static_child_in_a_row_of_a_fixed_clone_is_fed_per_row() {
    let all = compile("PageViewPage.tsx");
    assert_static_page(&all, "pageView");
    let rec = &all[0].ir.instances;
    assert_eq!(rec.len(), 1, "{rec:?}");
    assert_eq!(rec[0].loops, vec![Some("data.sections".to_string())]);
    assert_eq!(
        rec[0].props.get("price"),
        Some(&Some("data.sections[idx].data.price".to_string()))
    );
    // The inlined SectionView reads the slot of the row it sits in.
    let j = &all[0].jinja;
    assert!(j.contains("{% set _i1 = loop.index0 %}"), "{j}");
    assert!(j.contains("_1[_i1][\"_s1\"]"), "{j}");
}

#[test]
fn the_same_list_under_a_stateful_parent_stays_native() {
    let all = compile("StatefulList.tsx");
    assert!(
        matches!(all[0].ir.tier, Tier::Native),
        "{:?}",
        all[0].ir.tier
    );
    assert!(clones(&all, "list").is_empty());
    let list = shared(&all, "list").expect("the shared List");
    assert!(matches!(list.ir.tier, Tier::Native), "{:?}", list.ir.tier);
    assert!(list.jinja.contains("x-for"), "{}", list.jinja);
}
