//! F307 (option B, Mellow's binding conditions S1-S6 on the design note): slot content a caller prints inside a child's
//! own host is answered by a clone of the child for that call site, with the content at its `{children}`. These pin what
//! is NOT cloned and what a clone must keep: a child whose children reach its host only through its rest (S1, F324 /
//! F342), content reading the frame of a native Provider around the call site (S2, C2), a bare text slot React prints as a
//! text node (S4), call sites the re-read does not specialise (S5) and module data in a clone's content (F325).
//! The served side (== React in Chromium) is tests/server/host-specialise.chromium.test.ts.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{ComponentIR, DiagClass, Tier};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

struct Item {
    ir: ComponentIR,
    jinja: String,
    client: String,
}

fn compile(file: &str) -> Vec<Item> {
    let path = format!("crates/brust-compiler/tests/fixtures/host-specialise/{file}");
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
        .map(|l| {
            let mut client = l.artifacts.client_js.clone().unwrap_or_default();
            for (_, code) in &l.artifacts.client_modules {
                client.push_str(code);
            }
            Item {
                ir: (*l.ir).clone(),
                jinja: l.artifacts.jinja.clone(),
                client,
            }
        })
        .collect()
    })
}

fn host_clones(all: &[Item]) -> usize {
    all.iter()
        .filter(|i| i.ir.specialised && i.ir.id.contains("_h"))
        .count()
}

fn rules(ir: &ComponentIR, class: DiagClass) -> Vec<String> {
    ir.diagnostics
        .iter()
        .filter(|d| d.class == class)
        .map(|d| d.rule.clone())
        .collect()
}

fn is_react(ir: &ComponentIR) -> bool {
    matches!(ir.tier, Tier::React { .. })
}

/// S1: children that reach the child's host only through its rest are not cloned (no `{children}` slot to splice
/// into), and not dropped: the call site keeps its refusal (F342) and React renders them.
#[test]
fn a_child_whose_rest_carries_the_children_is_not_cloned() {
    let all = compile("rest.tsx");
    assert_eq!(host_clones(&all), 0);
    assert!(is_react(&all[0].ir), "{:?}", all[0].ir.tier);
    assert!(rules(&all[0].ir, DiagClass::Fallback).contains(&"slot-owner".to_string()));
}

/// S2 (C2): a host's content that consumes a native Provider's frame is cloned only where that frame is the clone's
/// own scope: inside the Provider's clone (`scoped_ok`, the Provider's state carried in as an input; served == React,
/// page `scoped`). Around a call site that is not inside such a clone the frame is another instance's: A1 (`check_owner`)
/// refuses the clone, and so does Carry for a frame value it cannot express (`scoped`): the refusal stands, never a
/// native page reading another frame.
#[test]
fn content_reading_a_native_providers_frame_is_cloned_only_inside_that_providers_clone() {
    let all = compile("scoped_ok.tsx");
    assert!(!is_react(&all[0].ir), "{:?}", all[0].ir.diagnostics);
    assert!(
        all.iter()
            .any(|i| i.ir.specialised && i.ir.id.starts_with("pO_"))
    );
    assert_eq!(host_clones(&all), 1);
    let all = compile("scoped.tsx");
    assert!(is_react(&all[0].ir), "{:?}", all[0].ir.tier);
    assert!(
        rules(&all[0].ir, DiagClass::Fallback).contains(&"slot-owner".to_string()),
        "{:?}",
        all[0].ir.diagnostics
    );
    assert_eq!(
        all.iter()
            .filter(|i| i.ir.specialised && i.ir.id.starts_with("box_"))
            .count(),
        0
    );
}

/// S4: a bare text slot that is the host element's only child binds `x-text` on that element (React prints a text
/// node there); next to an element of the child, or of the content, it would need a `<span>`: refused by name.
#[test]
fn a_bare_text_slot_binds_on_its_element_or_is_refused_by_name() {
    let all = compile("text_lone.tsx");
    assert!(!is_react(&all[0].ir), "{:?}", all[0].ir.diagnostics);
    let clone = all
        .iter()
        .find(|i| i.ir.specialised && i.ir.id.starts_with("box_"))
        .expect("a clone of Box");
    assert!(!clone.jinja.contains("<span"), "{}", clone.jinja);
    assert!(clone.jinja.contains("x-text="), "{}", clone.jinja);
    for file in ["text_pair.tsx", "text_mixed.tsx"] {
        let all = compile(file);
        assert_eq!(host_clones(&all), 0, "{file}");
        assert!(is_react(&all[0].ir), "{file}: {:?}", all[0].ir.tier);
        assert!(
            rules(&all[0].ir, DiagClass::Info).contains(&"slot-text-wrapper".to_string()),
            "{file}: {:?}",
            all[0].ir.diagnostics
        );
    }
}

/// S5: the re-read specialises only the refused call site: the other call site of the same child prints as it does
/// on a page with no refusal at all, and the child itself compiles the same.
#[test]
fn the_re_read_leaves_every_other_call_site_as_it_was() {
    let two = compile("two_sites.tsx");
    let stock = compile("two_sites_stock.tsx");
    assert_eq!(host_clones(&two), 1);
    assert_eq!(host_clones(&stock), 0);
    let first = |all: &[Item]| {
        let j = all[0].jinja.replace(&all[0].ir.id, "PAGE");
        let end = j.find("fixed").expect("the first call site") + "fixed".len();
        j[..end].to_string()
    };
    assert_eq!(first(&two), first(&stock));
    let boxed = |all: &[Item]| {
        let b = all
            .iter()
            .find(|i| i.ir.id.starts_with("box_") && !i.ir.specialised)
            .expect("Box");
        (
            serde_json::to_string(&b.ir).unwrap(),
            b.jinja.clone(),
            b.client.clone(),
        )
    };
    assert_eq!(boxed(&two), boxed(&stock));
}

/// F325 in a clone: module data stays where it was printed, never shipped with a clone's chunk. Content that reads an
/// import is not carried into a clone at all (the refusal stands); a host whose own rows over module data read its
/// prop keeps them printed once in its clone (F325), although the clone's props follow its caller (S3).
#[test]
fn module_data_is_never_shipped_with_a_clone() {
    let all = compile("module_list.tsx");
    assert_eq!(host_clones(&all), 0);
    assert!(
        rules(&all[0].ir, DiagClass::Info).contains(&"host-specialise-unsupported".to_string()),
        "{:?}",
        all[0].ir.diagnostics
    );
    for file in ["module_list.tsx", "module_rows.tsx"] {
        let all = compile(file);
        for i in &all {
            assert!(
                !i.client.contains("S3CR3T"),
                "{file} {}: {}",
                i.ir.id,
                i.client
            );
            assert!(
                !i.client.contains("USERS"),
                "{file} {}: {}",
                i.ir.id,
                i.client
            );
        }
    }
    // The rows are printed once in the clone (a job the server feeds); a clone fed per instance cannot also take a
    // carried value that changes, so this page falls back by name (`instance-prop-path`), still shipping no data.
    let all = compile("module_rows.tsx");
    assert_eq!(host_clones(&all), 1);
    let clone = all.iter().find(|i| i.ir.specialised).unwrap();
    assert!(!clone.jinja.contains("x-for"), "{}", clone.jinja);
    assert!(
        rules(&all[0].ir, DiagClass::Fallback).contains(&"instance-prop-path".to_string()),
        "{:?}",
        all[0].ir.diagnostics
    );
}

/// S3, narrowed (progress-flip): only a host clone reads its props as signals. A Provider clone (R34.122) whose call site
/// passes constants keeps the instance rule: no instance, no `<brust-host>` wrapper around the Provider's markup (Radix
/// Progress's shape; with S3 on every clone its `value` counted as live and the page's DOM gained a wrapper).
#[test]
fn a_provider_clone_given_constants_stays_without_an_instance() {
    let all = compile("provider_const.tsx");
    let clone = all
        .iter()
        .find(|i| i.ir.specialised && i.ir.id.starts_with("root_"))
        .expect("the Provider's clone");
    assert!(matches!(clone.ir.tier, Tier::Static), "{:?}", clone.ir.tier);
    assert!(clone.client.is_empty(), "{}", clone.client);
    assert!(!all[0].jinja.contains("brust-host"), "{}", all[0].jinja);
    assert!(!clone.jinja.contains("brust-host"), "{}", clone.jinja);
}

/// F345: a clone's props the call site does not change are pinned, so S3 holds for every clone. A stateless wrapper
/// passing its own prop to a Provider it specialises (shadcn Progress over Radix Root) pins it and freezes it (F319):
/// a constant caller stays static with no instance; a changing caller falls back by name; a wrapper with an instance
/// of its own follows its caller, and so does its clone.
#[test]
fn a_wrappers_own_prop_is_pinned_in_its_clone_and_frozen_at_the_wrapper() {
    let all = compile("wrap_const.tsx");
    assert!(
        all.iter().all(|i| matches!(i.ir.tier, Tier::Static)),
        "{:?}",
        all.iter()
            .map(|i| (&i.ir.id, &i.ir.tier))
            .collect::<Vec<_>>()
    );
    assert!(!all.iter().any(|i| i.jinja.contains("brust-host")));
    let clone = all.iter().find(|i| i.ir.specialised).unwrap();
    assert!(
        clone.ir.fixed_props.iter().any(|p| p == "value"),
        "{:?}",
        clone.ir.fixed_props
    );
    let wrap = all.iter().find(|i| i.ir.id.starts_with("wrap_")).unwrap();
    assert!(
        wrap.ir.frozen_props.iter().any(|p| p == "value"),
        "{:?}",
        wrap.ir.frozen_props
    );
    // shadcn Progress exactly: the props reach the clone through the wrapper's own rest (`*`, frozen per call site)
    let all = compile("restwrap_const.tsx");
    assert!(
        all.iter().all(|i| matches!(i.ir.tier, Tier::Static)),
        "{:?}",
        all.iter()
            .map(|i| (&i.ir.id, &i.ir.tier))
            .collect::<Vec<_>>()
    );
    assert!(!all.iter().any(|i| i.jinja.contains("brust-host")));
    let all = compile("wrap_live.tsx");
    assert!(is_react(&all[0].ir));
    assert!(rules(&all[0].ir, DiagClass::Fallback).contains(&"frozen-prop".to_string()));
    let all = compile("livewrap_live.tsx");
    assert!(!is_react(&all[0].ir), "{:?}", all[0].ir.diagnostics);
    let clone = all.iter().find(|i| i.ir.specialised).unwrap();
    assert!(
        !clone.ir.fixed_props.iter().any(|p| p == "value"),
        "{:?}",
        clone.ir.fixed_props
    );
}

/// F348: a clone that is LINKED for another reason (`max` is the page's state) still pins what its call site never
/// changes (`value`), so the S3 freeze holds on that path too; only the live input follows the page. Mutation check:
/// with `pinned()` returning nothing, `fixed_props` is empty and this fails.
#[test]
fn a_clone_linked_for_another_reason_still_pins_the_inputs_that_never_change() {
    let all = compile("linked_other.tsx");
    assert!(!is_react(&all[0].ir), "{:?}", all[0].ir.diagnostics);
    let clone = all.iter().find(|i| i.ir.specialised).expect("a clone");
    // linked: the page binds the clone's live input (`x-props-bind`)
    assert!(all[0].jinja.contains("x-props-bind"), "{}", all[0].jinja);
    assert!(
        clone.ir.fixed_props.iter().any(|p| p == "value"),
        "{:?}",
        clone.ir.fixed_props
    );
    assert!(
        !clone.ir.fixed_props.iter().any(|p| p == "max"),
        "{:?}",
        clone.ir.fixed_props
    );
}

/// switch-provider-chain PR1 + F345: a context value is never pinned in a clone. Radix Switch's shape (a render prop
/// called with the Provider's own context object, a trigger handing `checked` to a static button before the caller's
/// rest, a Thumb in that rest): pinned, the trigger's rest clone printed `data-state` once (served: switch-chain).
#[test]
fn a_context_value_is_never_pinned_in_a_clone() {
    let all = compile("sw_thumb.tsx");
    // the switch page is lowered (its Show tier is not React) and has clones: the loop below is not vacuous
    assert!(!is_react(&all[0].ir), "{:?}", all[0].ir.diagnostics);
    assert!(all.iter().any(|i| i.ir.specialised), "no clone");
    for i in all.iter().filter(|i| i.ir.specialised) {
        assert!(
            !i.ir.fixed_props.iter().any(|p| p.starts_with("__ctx_")),
            "{}: {:?}",
            i.ir.id,
            i.ir.fixed_props
        );
    }
}

/// F351: the shapes of a render prop that a Provider's clone cannot take are pinned as fixtures (`SwRefuse.tsx`): the
/// argument is a local object built by a call, a computation, the prop called twice, and a body that reads the setter
/// member. Each call site keeps the Provider as an island (nothing is dropped); the two with a named reason say it.
#[test]
fn render_prop_shapes_a_clone_cannot_take_keep_the_island() {
    for (file, reason) in [
        ("sw_ref_notliteral.tsx", None),
        ("sw_ref_computed.tsx", Some("is a computation")),
        ("sw_ref_twice.tsx", Some("exactly once")),
        ("sw_setter.tsx", None),
    ] {
        let all = compile(file);
        assert!(
            is_react(&all[0].ir) || all[0].jinja.contains("brust-island"),
            "{file}: {:?}",
            all[0].ir.diagnostics
        );
        assert!(
            !all.iter().any(|i| i.ir.specialised),
            "{file}: a clone was taken"
        );
        if let Some(r) = reason {
            assert!(
                all[0]
                    .ir
                    .diagnostics
                    .iter()
                    .any(|d| d.rule == "specialise-unsupported" && d.message.contains(r)),
                "{file}: {:?}",
                all[0].ir.diagnostics
            );
        }
    }
}
