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

/// The frame clone (`Frame` specialised) whose content holds `label`: it binds the consumer's `K` to its own `k`.
fn reads_own_k(all: &[Item], label: &str) -> bool {
    clones(all, "frame_").iter().any(|c| {
        c.jinja.contains(label)
            && c.jinja.contains("x-props='{{ {\"__ctx_K_")
            && c.jinja.contains("___whole\": k, ")
    })
}

/// F372 (was F371's refusal by name): content reading the context of a Provider that the cloned component's own template
/// opens around `{children}` (`Both` reads Frame's `K` inside Prov). The call site leaves that consumer to the clone (a
/// shadow frame), and inside Prov's clone the Frame clone fills it by position with Frame's own `k`, as React does. Two
/// call sites: four clones, each with its own content.
#[test]
fn content_reading_a_provider_inside_the_clones_template_reads_that_provider() {
    let all = compile("two.tsx");
    assert_eq!(clones(&all, "prov_").len(), 2);
    assert!(!all[0].jinja.contains("brust-island"), "{}", all[0].jinja);
    assert!(reads_own_k(&all, "AAA") && reads_own_k(&all, "BBB"));
    // the page itself hands Both no K (nothing at the call site may override Frame's frame)
    assert!(
        !all[0]
            .ir
            .props
            .iter()
            .any(|p| p.name.starts_with("__ctx_K_")),
        "{:?}",
        all[0].ir.props
    );
}

/// F372: the same under a plain element of the content, and with an OUTER K Provider around Prov (React: the inner
/// Frame is nearer, so the content reads it, not the outer one).
#[test]
fn the_inner_provider_wins_under_an_element_and_over_an_outer_one() {
    for file in ["pdiv.tsx", "outerk.tsx"] {
        let all = compile(file);
        assert!(
            !all[0].jinja.contains("brust-island"),
            "{file}: {}",
            all[0].jinja
        );
        assert!(reads_own_k(&all, "AAA"), "{file}");
    }
    // outerk: in the outer Frame's clone (which prints Prov and the inner clone inline) the consumer reads the inner
    // clone's `k`, never the outer clone's own
    let all = compile("outerk.tsx");
    let outer = clones(&all, "frame_")
        .into_iter()
        .find(|c| c.jinja.contains("prov_"))
        .expect("the outer frame clone");
    assert!(!outer.jinja.contains("___whole\": k, "), "{}", outer.jinja);
}

/// F372 (the over-refusal): a K Provider the content writes itself (`KP`) is nearer than Frame inside Prov: the consumer
/// reads KP's value. Shadows sit below the content's own frames.
#[test]
fn the_contents_own_provider_is_nearer_than_the_one_inside_the_clone() {
    let all = compile("ownkp.tsx");
    assert!(!all[0].jinja.contains("brust-island"), "{}", all[0].jinja);
    let kp = clones(&all, "kP_");
    assert_eq!(kp.len(), 1);
    assert!(kp[0].jinja.contains("___whole\": n, "), "{}", kp[0].jinja);
    assert!(!reads_own_k(&all, "AAA"));
}

/// F372 R1: Frame beside `{children}` (not around it): the content does not sit under it, so the clone would still need
/// a K the call site no longer hands it. Refused by name: the Provider stays an island (React renders the default).
#[test]
fn content_beside_the_inner_provider_keeps_the_provider_an_island() {
    let all = compile("beside.tsx");
    assert!(
        all[0]
            .jinja
            .contains(r#"<brust-island style="display:contents" data-id="beside_"#),
        "{}",
        all[0].jinja
    );
    assert!(all[0].ir.diagnostics.iter().any(|d| {
        d.rule == "specialise-unsupported" && d.message.contains("but does not sit under it")
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
/// dropped (`<Outer>hello</Outer>` printed an empty section). F375: the spread form is a rest clone of the wrapper now
/// (F298's trigger widened to a rest that lands on a native Provider), so `hello` is printed inside Prov, native; the
/// `children` prop form keeps the refusal (the Provider an island, React renders it). The F371 shape through the wrapper
/// (`rest_k`) is native with F372; content reading the Provider's own context still clones the wrapper (`rest_on`).
#[test]
fn children_handed_to_a_native_provider_in_a_spread_or_prop_are_never_dropped() {
    let all = compile("rest_text.tsx");
    assert!(info(&all, "outerProp_", "given as the `children` prop"));
    let w = all
        .iter()
        .find(|i| i.ir.id.starts_with("outerProp_"))
        .unwrap();
    assert!(matches!(w.ir.tier, brust_compiler::ir::Tier::React { .. }));
    assert!(
        all[0].jinja.contains("brust-island") && all[0].jinja.contains("world"),
        "{}",
        all[0].jinja
    );
    let frame = clones(&all, "frame_");
    assert!(
        frame.iter().any(|c| c.jinja.contains(">hello</section>")),
        "{}",
        all[0].jinja
    );
    for file in ["rest_k.tsx", "rest_on.tsx"] {
        let all = compile(file);
        assert!(
            !all[0].jinja.contains("brust-island"),
            "{file}: {}",
            all[0].jinja
        );
        assert_eq!(clones(&all, "prov_").len(), 1, "{file}");
    }
    assert!(reads_own_k(&compile("rest_k.tsx"), "AAA"));
}

/// F375 (b): `<Outer />` with no children, no spread and no `children` prop: the rest provably carries none, so Prov is
/// specialised with none inside Outer's rest clone (#345 made it an island). A call site that spreads (it may carry
/// children) keeps the refusal.
#[test]
fn a_rest_forwarder_called_with_no_children_specialises_the_provider_with_none() {
    let all = compile("rest_empty.tsx");
    assert!(!all[0].jinja.contains("brust-island"), "{}", all[0].jinja);
    assert_eq!(clones(&all, "prov_").len(), 1);
    let all = compile("rest_spread.tsx");
    assert!(all[0].jinja.contains("brust-island"), "{}", all[0].jinja);
    assert!(info(&all, "outer_", "a spread may carry its children"));
}
