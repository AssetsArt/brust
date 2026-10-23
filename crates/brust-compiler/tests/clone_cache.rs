//! F238: a specialised clone's module-cache key and id name its call site (the module, the enclosing clone's id: F298 /
//! F307 `spec_salt`, and the offset) and, since F238, the shape of the content it is made with. Two call sites at one
//! offset of one template (content written in another module keeps that module's offsets) would otherwise share the
//! first one's clone: the second content is lost. On main that only happens when the content holds a Provider call that
//! is still a React island where it is written, which the F3 `holds_island` fallback refuses first, so the pins here are
//! the shapes around it. The served side is tests/server/clone-cache.chromium.test.ts.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{ComponentIR, DiagClass};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

struct Item {
    ir: ComponentIR,
    jinja: String,
}

fn compile(file: &str) -> Vec<Item> {
    let path = format!("crates/brust-compiler/tests/fixtures/clone-cache/{file}");
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
        .filter(|i| i.ir.specialised && i.ir.id.starts_with(of))
        .collect()
}

/// Two clones of one Provider (`Prov`), each with its own content; inside each, the Provider it calls around its
/// `{children}` (`Frame`) is specialised with THAT clone's content: four distinct clones, no content in the wrong one.
#[test]
fn clones_inside_two_clones_of_one_provider_keep_their_own_content() {
    let all = compile("two_on.tsx");
    let provs = clones(&all, "prov_");
    let frames = clones(&all, "frame_");
    assert_eq!((provs.len(), frames.len()), (2, 2));
    for c in provs.iter().chain(&frames) {
        let (a, b) = (c.jinja.contains("AAA"), c.jinja.contains("BBB"));
        assert!(
            a ^ b,
            "{} holds {}",
            c.ir.id,
            if a { "both" } else { "neither" }
        );
    }
    assert_ne!(frames[0].ir.id, frames[1].ir.id);
}

/// Content spliced into Prov's clone holds a Frame call at the very offset of Prov's own Frame call. Specialised where
/// it is written (`same_loc3`), it reaches the clone as a clone already, and the two Frames nest as in React (two
/// sections). Still a React island where it is written (`same_loc`), F3 refuses the clone by name and the page keeps
/// Prov's island: with F3 lifted locally, this is where the second Frame reused the first one's clone before F238.
#[test]
fn a_provider_call_at_the_offset_of_the_clones_own_call_stays_apart() {
    let all = compile("same_loc3.tsx");
    let prov = clones(&all, "prov_");
    assert_eq!(prov.len(), 1);
    assert_eq!(
        prov[0].jinja.matches("<section").count(),
        2,
        "{}",
        prov[0].jinja
    );
    assert_eq!(clones(&all, "frame_").len(), 2);

    let all = compile("same_loc.tsx");
    assert!(clones(&all, "prov_").is_empty());
    assert!(
        all[0]
            .jinja
            .contains(r#"<brust-island style="display:contents" data-id="prov_"#),
        "{}",
        all[0].jinja
    );
    assert!(
        all[0]
            .ir
            .diagnostics
            .iter()
            .any(|d| d.class == DiagClass::Info && d.rule == "specialise-unsupported")
    );
}

/// Found with F238 (pre-existing, served): content reading the context of a Provider that the cloned component's own
/// template opens around `{children}` (`Both` reads Frame's `K` inside Prov) was handed the call site's value (no K
/// frame there: the default) as a hidden input, which overrode Frame's frame in the clone: data-k printed 0 where React
/// prints Frame's k. Refused by name now: the page keeps Prov an island (served == React).
#[test]
fn content_reading_a_provider_inside_the_clones_template_is_refused_by_name() {
    let all = compile("two.tsx");
    assert!(clones(&all, "prov_").is_empty());
    assert!(
        all[0]
            .jinja
            .contains(r#"<brust-island style="display:contents" data-id="prov_"#),
        "{}",
        all[0].jinja
    );
    assert!(all[0].ir.diagnostics.iter().any(|d| {
        d.rule == "specialise-unsupported"
            && d.message
                .contains("reads a context that a Provider inside `Prov` provides")
    }));
}

fn info(all: &[Item], id: &str, text: &str) -> bool {
    all.iter()
        .filter(|i| i.ir.id.starts_with(id))
        .flat_map(|i| &i.ir.diagnostics)
        .any(|d| d.rule == "specialise-unsupported" && d.message.contains(text))
}

/// F374 (Afrojack, PR1 review; pre-existing): a wrapper that hands its children on to a native Provider in a spread
/// (`<Prov {...props} />`) or as the `children` prop had the Provider specialised with NO content, so the children were
/// dropped (`<Outer>hello</Outer>` printed an empty section, no diagnostic). Refused by name now: the Provider stays an
/// island in the wrapper, which renders with React, children included. The F371 shape through such a wrapper
/// (`rest_k`) keeps its content; content reading the Provider's own context still clones the wrapper (F298, `rest_on`).
#[test]
fn children_handed_to_a_native_provider_in_a_spread_or_prop_are_never_dropped() {
    let all = compile("rest_text.tsx");
    assert!(info(&all, "outer_", "a spread may carry its children"));
    assert!(info(&all, "outerProp_", "given as the `children` prop"));
    for (id, text) in [("outer_", "hello"), ("outerProp_", "world")] {
        let w = all.iter().find(|i| i.ir.id.starts_with(id)).unwrap();
        assert!(
            matches!(w.ir.tier, brust_compiler::ir::Tier::React { .. }),
            "{id}"
        );
        assert!(all[0].jinja.contains(text), "{}", all[0].jinja);
    }
    let all = compile("rest_k.tsx");
    assert!(
        all[0].jinja.contains("AAA") && all[0].jinja.contains("brust-island"),
        "{}",
        all[0].jinja
    );
    let all = compile("rest_on.tsx");
    assert!(!all[0].jinja.contains("brust-island"), "{}", all[0].jinja);
    assert_eq!(clones(&all, "prov_").len(), 1);
}
