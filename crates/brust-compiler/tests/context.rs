//! S2 context lowering (R34.100-R34.104): a Provider hands its value fields to the consumers under it as hidden props.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

/// Every component of the tree of `file`: (id, IR, jinja, precompute job module).
fn compile_all(file: &str) -> Vec<(String, ComponentIR, String, Option<String>)> {
    let file = file.to_string();
    run_on_compiler_thread(move || {
        let opts = AnalyzeOptions {
            root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
            ..Default::default()
        };
        compile_tree(
            &format!("crates/brust-compiler/tests/fixtures/context/{file}"),
            None,
            &opts,
            "/_brust/client/runtime.js",
        )
        .unwrap()
        .into_iter()
        .map(|l| {
            (
                l.ir.id.clone(),
                (*l.ir).clone(),
                l.artifacts.jinja.clone(),
                l.artifacts.server_ts.clone(),
            )
        })
        .collect()
    })
}

fn compile(file: &str) -> Vec<(String, ComponentIR, String)> {
    compile_all(file)
        .into_iter()
        .map(|(a, b, c, _)| (a, b, c))
        .collect()
}

fn rules(ir: &ComponentIR) -> Vec<&str> {
    ir.diagnostics.iter().map(|d| d.rule.as_str()).collect()
}

fn page(file: &str) -> (ComponentIR, String) {
    let all = compile(file);
    let want = file
        .trim_end_matches(".tsx")
        .replace('-', "")
        .to_lowercase();
    all.into_iter()
        .find(|(id, ..)| id.to_lowercase().starts_with(&want))
        .map(|(_, ir, j)| (ir, j))
        .expect("the page")
}

fn is_react(ir: &ComponentIR) -> bool {
    matches!(ir.tier, Tier::React { .. })
}

/// React's `createContext`: the consumer under a Provider component reads its value, printed at the call site (R34.100).
#[test]
fn a_react_context_resolves_at_compile_time_for_a_consumer_under_a_provider() {
    let (ir, jinja) = page("react-basic.tsx");
    assert!(
        !is_react(&ir) && ir.diagnostics.is_empty(),
        "{:?} {:?}",
        ir.tier,
        ir.diagnostics
    );
    assert!(
        jinja.contains("<section>") && jinja.contains(r#"("hi" ~ "!")"#),
        "{jinja}"
    );
    assert!(
        !jinja.contains("__ctx_"),
        "no hidden prop reaches the page: {jinja}"
    );
}

/// Radix's `createContextScope` (R34.100, R34.101): the Provider takes the fields as props, a default applies.
#[test]
fn a_radix_context_scope_hands_props_and_defaults_to_the_indicator() {
    let (ir, jinja) = page("radix-scope.tsx");
    assert!(
        !is_react(&ir) && ir.diagnostics.is_empty(),
        "{:?} {:?}",
        ir.tier,
        ir.diagnostics
    );
    // value is the call site's 66, max falls back to the Provider's default 100.
    assert!(jinja.contains("(66)") && jinja.contains("(100)"), "{jinja}");
    assert!(!jinja.contains("__ctx_"), "{jinja}");
}

/// A wrapper around a consumer stays a plain component; the page that puts it under the Provider fills the need.
#[test]
fn a_consumer_inside_a_wrapper_gets_its_value_from_the_provider_above_the_wrapper() {
    let (ir, jinja) = page("wrapper.tsx");
    assert!(
        !is_react(&ir) && ir.diagnostics.is_empty(),
        "{:?} {:?}",
        ir.tier,
        ir.diagnostics
    );
    assert!(jinja.contains(r#""L""#), "{jinja}");
    // The wrapper itself carries the hidden prop (it reads the context through its child).
    let all = compile("wrapper.tsx");
    let wrapped = all
        .iter()
        .find(|(id, ..)| id.starts_with("wrapped_"))
        .expect("wrapped");
    assert_eq!(wrapped.1.ctx_uses.len(), 1, "{:?}", wrapped.1.ctx_uses);
}

/// The nearest Provider wins, and a sibling after a nested Provider sees the outer one again.
#[test]
fn the_nearest_provider_wins() {
    let (ir, jinja) = page("nested.tsx");
    assert!(
        !is_react(&ir) && ir.diagnostics.is_empty(),
        "{:?} {:?}",
        ir.tier,
        ir.diagnostics
    );
    assert!(
        jinja.contains(
            "<div><b>{{ (1) | e }}</b><div><b>{{ (2) | e }}</b></div><b>{{ (1) | e }}</b></div>"
        ),
        "{jinja}"
    );
}

/// A route component whose consumer has no Provider falls back (never a build error).
#[test]
fn a_consumer_with_no_provider_falls_back_at_the_route() {
    let (ir, _) = page("no-provider.tsx");
    assert!(
        rules(&ir).contains(&"context-no-provider"),
        "{:?}",
        ir.diagnostics
    );
    assert!(is_react(&ir), "{:?}", ir.tier);
}

/// The context value used as a whole, and a Provider value that is not an object literal, fall back.
#[test]
fn a_whole_context_value_and_a_scalar_provider_value_fall_back() {
    for (f, code) in [
        ("escape.tsx", "context-escape"),
        ("value-shape.tsx", "context-value"),
    ] {
        let all = compile(f);
        let rules: Vec<&str> = all.iter().flat_map(|(_, ir, _)| rules(ir)).collect();
        assert!(rules.contains(&code), "{f}: {rules:?}");
    }
}

/// The Provider's values call helpers of ITS module (`clamp`, `stateOf`): a call is not a literal, so under the lead's scope
/// cut the page renders with React (context-value); F174 narrows it to helpers proven to return primitives.
#[test]
fn a_provider_value_that_calls_a_helper_is_not_lowered_yet() {
    let out = compile_all("helper-page.tsx");
    let page = out
        .iter()
        .find(|(id, ..)| id.starts_with("helperPage_"))
        .expect("page");
    assert!(
        rules(&page.1).contains(&"context-value"),
        "{:?}",
        page.1.diagnostics
    );
    assert!(is_react(&page.1), "{:?}", page.1.tier);
}

/// R34.104: an `if` whose branches only call `console.*` is a diagnostic, not part of the render; any other effect
/// in a branch keeps the control-flow fallback.
#[test]
fn a_console_only_if_is_left_out_and_any_other_if_still_falls_back() {
    let (ir, jinja) = page("console-if.tsx");
    assert!(
        !is_react(&ir) && ir.diagnostics.is_empty(),
        "{:?} {:?}",
        ir.tier,
        ir.diagnostics
    );
    assert!(jinja.contains("<p>"), "{jinja}");
    let (ir, _) = page("real-if.tsx");
    assert!(is_react(&ir), "{:?}", ir.tier);
}

/// A wrapper that forwards its `...rest` into the Provider component (the shadcn shape): the frame VALUES here read props
/// (`max` from the rest, `value` the Provider default), which the lead's scope cut keeps out of a lowered frame
/// (context-value, F174 narrows it): nothing wrong is printed, the page renders with React.
#[test]
fn a_rest_spread_into_the_provider_stays_react_while_frame_values_must_be_literals() {
    let all = compile_all("rest-wrapper.tsx");
    let rules_all: Vec<&str> = all.iter().flat_map(|(_, ir, ..)| rules(ir)).collect();
    assert!(rules_all.contains(&"context-value"), "{rules_all:?}");
    let page = all
        .iter()
        .find(|(id, ..)| id.starts_with("restWrapper_"))
        .expect("page");
    assert!(!page.2.contains("(5)"), "{}", page.2);
}

/// A Provider that hands out state (a native provider is a later step) stays a React island, as before; the page that
/// renders it stays static and never becomes React because of it.
#[test]
fn a_provider_that_hands_out_state_stays_an_island_and_the_page_stays_static() {
    let all = compile_all("state-provider.tsx");
    let tier = |prefix: &str| {
        all.iter()
            .find(|(id, ..)| id.starts_with(prefix))
            .map(|(_, ir, ..)| ir.clone())
            .expect(prefix)
    };
    let provider = tier("disclosure_");
    assert!(is_react(&provider), "{:?}", provider.tier);
    assert!(
        rules(&provider).contains(&"context-state"),
        "{:?}",
        provider.diagnostics
    );
    let page = tier("stateProvider_");
    assert!(!is_react(&page), "{:?} {:?}", page.tier, page.diagnostics);
}

/// Mellow F1: a context field is part of an identifier, so a key that is not a plain identifier (`'x-y'`) is refused by
/// a named fallback on whichever side writes it, never printed (`const { __ctx_Ctx_x-y } = props`).
#[test]
fn a_context_field_that_is_not_a_plain_identifier_is_refused_by_name() {
    let all = compile_all("field-job.tsx");
    let shapes = all
        .iter()
        .filter(|(_, ir, ..)| rules(ir).contains(&"context-shape"))
        .count();
    assert!(
        shapes >= 1,
        "{:?}",
        all.iter()
            .map(|(i, ir, ..)| (i, rules(ir)))
            .collect::<Vec<_>>()
    );
    for (id, _, jinja, ts) in &all {
        assert!(
            !jinja.contains("x-y") || jinja.contains("brust-island"),
            "{id}: {jinja}"
        );
        assert!(
            ts.as_deref()
                .is_none_or(|t| !t.contains("__ctx_") || !t.contains("x-y")),
            "{id}"
        );
    }
    // The control with a plain key compiles.
    let (ir, _) = page("field-ok.tsx");
    assert!(
        !is_react(&ir) && ir.diagnostics.is_empty(),
        "{:?} {:?}",
        ir.tier,
        ir.diagnostics
    );
}

/// Mellow F2: a context is the declaring module AND its name. Two modules each declare `Ctx`: a consumer of B's never
/// reads A's Provider (React reads B's default).
#[test]
fn a_context_with_the_same_local_name_in_another_module_is_another_context() {
    let (ir, jinja) = page("same-name.tsx");
    assert!(
        !jinja.contains("from-A"),
        "A's value must not reach B's consumer: {jinja}"
    );
    assert!(
        rules(&ir).contains(&"context-no-provider"),
        "{:?}",
        ir.diagnostics
    );
    assert!(is_react(&ir), "{:?}", ir.tier);
}

/// A context declared in a THIRD module and imported by both sides is not recognised across modules (v1): the Provider
/// and the consumer stay React islands (as before this lane), the page stays static, and no value is ever substituted.
#[test]
fn a_context_declared_in_a_shared_module_stays_react() {
    let all = compile_all("shared-ctx.tsx");
    for (id, ir, jinja, _) in &all {
        assert!(!jinja.contains("from-S"), "{id}: {jinja}");
        if id.starts_with("panelS_") || id.starts_with("badgeS_") {
            assert!(is_react(ir), "{id}: {:?}", ir.tier);
        } else {
            assert!(
                !is_react(ir),
                "the page stays static: {:?} {:?}",
                ir.tier,
                ir.diagnostics
            );
        }
    }
}

/// Mellow F3 (lead ruling): an island under a Provider that is lowered away would hydrate standalone and read the
/// context DEFAULT. Any island under an active frame (directly, through a static wrapper, or reading the context from
/// another module) keeps the page React; an island BESIDE the Provider does not, and a Provider with none still lowers.
#[test]
fn an_island_under_a_lowered_provider_keeps_the_page_react() {
    for f in ["island-under.tsx", "island-cross.tsx", "island-wrapped.tsx"] {
        let (ir, _) = page(f);
        assert!(
            rules(&ir).contains(&"context-island"),
            "{f}: {:?}",
            ir.diagnostics
        );
        assert!(is_react(&ir), "{f}: {:?}", ir.tier);
    }
    // A consumer passed as the children of a React island: the island's own React context is the Provider, so the
    // consumer must not lower on its own (it would wait for a frame that never comes).
    let (ir, _) = page("island-consumer.tsx");
    assert!(
        rules(&ir).contains(&"context-island"),
        "island-consumer.tsx: {:?}",
        ir.diagnostics
    );
    assert!(is_react(&ir), "island-consumer.tsx: {:?}", ir.tier);
    for f in ["island-beside.tsx", "react-basic.tsx"] {
        let (ir, _) = page(f);
        assert!(
            !rules(&ir).contains(&"context-island"),
            "{f}: {:?}",
            ir.diagnostics
        );
        assert!(!is_react(&ir), "{f}: {:?} {:?}", ir.tier, ir.diagnostics);
    }
}

/// Mellow (lead ruling b): a module-level JSX const used as a child printed NOTHING (main's bug, widened by Providers).
/// One guard at the shared drop point (a printed slot) falls back by name for plain wrappers and Providers alike.
#[test]
fn a_module_level_jsx_const_used_as_a_child_falls_back_by_name() {
    for f in ["jsx-const-wrap.tsx", "jsx-const-provider.tsx"] {
        let (ir, _) = page(f);
        assert!(
            rules(&ir).contains(&"jsx-const-child"),
            "{f}: {:?}",
            ir.diagnostics
        );
        assert!(is_react(&ir), "{f}: {:?}", ir.tier);
    }
}

/// Lead ruling (a): an imported binding in child position is printed only when it provably is not JSX. An imported JSX
/// const (under a plain wrapper, under a Provider, through a namespace) and an unresolvable import fall back by name;
/// an imported plain value still lowers, and a prop that shadows the imported name is the prop.
#[test]
fn an_imported_child_is_printed_only_when_it_provably_is_not_jsx() {
    for f in [
        "imp-wrap.tsx",
        "imp-provider.tsx",
        "imp-unreadable.tsx",
        "imp-ns.tsx",
    ] {
        let (ir, _) = page(f);
        assert!(
            rules(&ir).contains(&"jsx-const-child"),
            "{f}: {:?}",
            ir.diagnostics
        );
        assert!(is_react(&ir), "{f}: {:?}", ir.tier);
    }
    for f in ["imp-plain.tsx", "imp-shadow.tsx"] {
        let (ir, jinja) = page(f);
        assert!(
            !rules(&ir).contains(&"jsx-const-child") && !is_react(&ir),
            "{f}: {:?} {:?}",
            ir.tier,
            ir.diagnostics
        );
        assert!(
            jinja.contains("plain") || jinja.contains("mine"),
            "{f}: {jinja}"
        );
    }
}

/// Lead ruling (allowlist): a child passed to a component under a Provider is printed only when EVERY identifier it reads,
/// anywhere in the expression, is a prop, a printed local or a primitive constant. Table-driven over the shapes found so
/// far (root, `&&`, `?:`, `??`, member, index, `?.`, computed key, template literal), each with the element holder
/// IMPORTED and LOCAL: every one falls back. The control children (a prop, a primitive import, a primitive local) lower.
#[test]
fn a_child_that_reads_anything_but_props_locals_and_primitives_falls_back() {
    for shape in [
        "root", "and", "tern", "nullish", "member", "index", "opt", "computed", "template",
    ] {
        for kind in ["imp", "loc"] {
            let f = format!("{kind}-m-{shape}.tsx");
            let (ir, _) = page(&f);
            assert!(
                rules(&ir).contains(&"jsx-const-child"),
                "{f}: {:?}",
                ir.diagnostics
            );
            assert!(is_react(&ir), "{f}: {:?}", ir.tier);
        }
    }
    for f in ["imp-plain.tsx", "imp-shadow.tsx"] {
        let (ir, _) = page(f);
        assert!(
            !rules(&ir).contains(&"jsx-const-child") && !is_react(&ir),
            "{f}: {:?} {:?}",
            ir.tier,
            ir.diagnostics
        );
    }
}

/// Mellow (Provider-own template): the Provider tag lowers to a Fragment, so the component's OWN template is judged by the
/// same predicate as children passed to a component. An element holder read directly under the Provider element, imported
/// or local, in every shape of the table, falls back.
#[test]
fn a_providers_own_template_is_judged_by_the_same_predicate() {
    for shape in ["root", "and", "tern", "member", "index"] {
        for kind in ["imp", "loc"] {
            let all = compile_all(&format!("pown-{kind}-{shape}.tsx"));
            let panel = all
                .iter()
                .find(|(id, ..)| id.starts_with("panel_"))
                .expect("panel");
            assert!(
                rules(&panel.1).contains(&"jsx-const-child"),
                "{kind}-{shape}: {:?}",
                panel.1.diagnostics
            );
            assert!(is_react(&panel.1), "{kind}-{shape}: {:?}", panel.1.tier);
        }
    }
}

/// F173 + F190: a plain wrapper is judged by the same total predicate as a Provider frame (`Placer::painted`). An element
/// holder at the root of a child, in its `&&` / `?:` value positions, through a member, an index or an array, and a helper
/// returning an element (imported or local) fall back; on main they printed nothing. The ordinary child reads
/// `{LABELS[kind]}`, `{items.length}`, `{formatPrice(x)}` still LOWER, wrapper or Provider: the const map folds, and an
/// imported helper is proven plain in its own module (`plain_fn::imported_plain_fn`).
#[test]
fn plain_wrappers_are_judged_by_the_total_predicate_and_ordinary_reads_keep_lowering() {
    for kind in ["imp", "loc"] {
        for shape in ["root", "and", "tern", "member", "index", "array", "call"] {
            let f = format!("plain-{kind}-{shape}.tsx");
            let (ir, _) = page(&f);
            assert!(
                rules(&ir).contains(&"jsx-const-child"),
                "{f}: {:?}",
                ir.diagnostics
            );
            assert!(is_react(&ir), "{f}: {:?}", ir.tier);
        }
    }
    // A list over a module const (the scroll-area shape) lowers; one whose rows are elements falls back (main's guard).
    let (ir, _) = page("plain-const-jsx-list.tsx");
    assert!(
        rules(&ir).contains(&"jsx-const-child") && is_react(&ir),
        "{:?}",
        ir.diagnostics
    );
    for f in [
        "trio-plain.tsx",
        "trio-prov.tsx",
        "plain-helper-ok.tsx",
        "plain-const-list.tsx",
        // Only `{child}` slots are judged under a plain wrapper: an unproven helper in an attribute or a component prop
        // (`className={cn(...)}`) prints as React prints it and keeps lowering, as on main.
        "plain-attr-helper.tsx",
        // Local string helpers (a const arrow, `.replace(/re/, …)` on a parameter's field, a comparison or a template
        // over its fields) are proven plain: the docs site's own pages keep lowering.
        "plain-helper-string.tsx",
        // Lead ruling on @57714ece: every allowlisted built-in method on an accepted read or on `new Date(…)`.
        "plain-methods.tsx",
        // `useState(1234.5)` then `n.toFixed(2)`: a primitive state keeps lowering (native page).
        "plain-method-state-primitive.tsx",
    ] {
        let (ir, jinja) = page(f);
        assert!(
            !rules(&ir).contains(&"jsx-const-child") && !is_react(&ir),
            "{f}: {:?} {:?}",
            ir.tier,
            ir.diagnostics
        );
        assert!(!jinja.is_empty(), "{f}");
    }
}

/// F173: an imported helper is plain only when its own module proves it by the PR 1c rules: an index or member read
/// inside it, a `let` export (rebindable), a namespace member call, an import that does not resolve, and a proven
/// helper called with an element holder as its argument all fall back by name.
#[test]
fn an_imported_helper_is_plain_only_when_its_module_proves_it() {
    for f in [
        "plain-helper-index.tsx",
        "plain-helper-member.tsx",
        "plain-helper-let.tsx",
        "plain-helper-ns.tsx",
        "plain-helper-unresolved.tsx",
        "plain-helper-arg.tsx",
        // A regular expression is plain only as a method's argument: a helper returning its argument would print it.
        "plain-helper-regex.tsx",
    ] {
        let (ir, _) = page(f);
        assert!(
            rules(&ir).contains(&"jsx-const-child"),
            "{f}: {:?}",
            ir.diagnostics
        );
        assert!(is_react(&ir), "{f}: {:?}", ir.tier);
    }
}

/// Mellow (scoping): a component PROP under a Provider frame is printed too (`<Badge icon={el}/>`), so it goes through the
/// predicate at the single print point (`Placer::painted`), imported and local.
#[test]
fn a_component_prop_under_a_provider_frame_is_judged_by_the_predicate() {
    for f in ["pprop-imp.tsx", "pprop-loc.tsx"] {
        let (ir, _) = page(f);
        assert!(
            rules(&ir).contains(&"jsx-const-child"),
            "{f}: {:?}",
            ir.diagnostics
        );
        assert!(is_react(&ir), "{f}: {:?}", ir.tier);
    }
}

/// Mellow: a Provider VALUE field holding an element holder (`value={{ icon: el }}`, imported or local) reaches the consumer
/// as a hidden prop and would print as nothing: the Provider component stays a React island (the page stays static).
#[test]
fn a_provider_value_field_holding_an_element_keeps_the_provider_an_island() {
    for f in ["pfield-imp.tsx", "pfield-loc.tsx"] {
        let all = compile_all(f);
        let panel = all
            .iter()
            .find(|(id, ..)| id.starts_with("panel_"))
            .expect("panel");
        assert!(
            rules(&panel.1).contains(&"context-state"),
            "{f}: {:?}",
            panel.1.diagnostics
        );
        assert!(is_react(&panel.1), "{f}: {:?}", panel.1.tier);
    }
}

/// Lead ruling on 84a4650a: every Provider frame VALUE must be a literal (no prop read, no call, no import): a Prop-fed field
/// (`<PanelP icon={el}>` with `value={{ icon }}`) and a helper-fed field (`value={{ icon: makeIcon() }}`) keep the page React
/// (the Provider cannot be lowered); a user prop named `__ctx_*` fails closed with its own code.
#[test]
fn frame_values_are_literals_and_the_ctx_prefix_is_reserved() {
    for f in ["pframe-prop.tsx", "pframe-call.tsx"] {
        let (ir, _) = page(f);
        assert!(
            rules(&ir).contains(&"context-value"),
            "{f}: {:?}",
            ir.diagnostics
        );
        assert!(is_react(&ir), "{f}: {:?}", ir.tier);
    }
    let all = compile_all("pframe-reserved.tsx");
    let rules_all: Vec<&str> = all.iter().flat_map(|(_, ir, ..)| rules(ir)).collect();
    assert!(rules_all.contains(&"context-shape"), "{rules_all:?}");
    // The literal case still lowers (react-basic: value={{ title, shout }} from literal props at the call site).
    let (ir, _) = page("react-basic.tsx");
    assert!(!is_react(&ir), "{:?} {:?}", ir.tier, ir.diagnostics);
}

/// Mellow (reservation): a call-site prop named EXACTLY the hidden name the lowering would use must fail closed too (the
/// author-prop scan sees only author props), whether the consumer is fed by a Provider or not.
#[test]
fn a_call_site_prop_with_the_exact_hidden_name_fails_closed() {
    for f in ["hid-provfed.tsx", "hid-bare.tsx"] {
        let all = compile_all(f);
        let page = all
            .iter()
            .find(|(id, ..)| id.starts_with("hid"))
            .expect("page");
        assert!(
            rules(&page.1).contains(&"context-shape"),
            "{f}: {:?}",
            page.1.diagnostics
        );
        assert!(is_react(&page.1), "{f}: {:?}", page.1.tier);
        assert!(
            !page.2.contains("forged") || is_react(&page.1),
            "{f}: {}",
            page.2
        );
    }
}

/// F174 (PR 1c): a module function the compiler PROVES returns a primitive (a literal, a template, an operator or a
/// conversion over plain values, other proven helpers) may be called under a Provider; one that can return an element,
/// an object, a function or a member of its argument cannot, nor can one that calls such a helper.
#[test]
fn a_helper_proven_to_return_a_primitive_may_be_read_under_a_provider() {
    let (ir, _) = page("ph-plain.tsx");
    assert!(!is_react(&ir), "{:?} {:?}", ir.tier, ir.diagnostics);
    let all = compile_all("ph-plain.tsx");
    let panel = all
        .iter()
        .find(|(id, ..)| id.starts_with("panel_"))
        .expect("panel");
    assert!(
        !rules(&panel.1).contains(&"jsx-const-child"),
        "{:?}",
        panel.1.diagnostics
    );
    assert!(!is_react(&panel.1), "{:?}", panel.1.tier);
    for f in [
        "ph-jsx.tsx",
        "ph-obj.tsx",
        "ph-member.tsx",
        "ph-closure.tsx",
        "ph-chain.tsx",
        "ph-reassign.tsx",
        // Afrojack F1/F2: a rest parameter returns an array; a body local that shadows a helper is not the helper.
        "ph-rest.tsx",
        "ph-shadow.tsx",
        // Mellow F1: a global is the language's own only when nothing in the module binds the name.
        "ph-g-string.tsx",
        "ph-g-number.tsx",
        "ph-g-parseint.tsx",
        "ph-g-math-ns.tsx",
        "ph-g-import-string.tsx",
        "ph-g-const-math.tsx",
        "ph-g-param.tsx",
        "ph-g-nan.tsx",
    ] {
        let all = compile_all(f);
        let panel = all
            .iter()
            .find(|(id, ..)| id.starts_with("panel_"))
            .expect("panel");
        assert!(
            rules(&panel.1).contains(&"jsx-const-child"),
            "{f}: {:?}",
            panel.1.diagnostics
        );
        assert!(is_react(&panel.1), "{f}: {:?}", panel.1.tier);
    }
}

/// Lead ruling on @57714ece: an allowlisted method is plain only on a built-in receiver. An object literal carrying its
/// own method of that name (through a local, a member, an index or an array, or built by `Object.fromEntries`), a class instance, a shadowed `Date`, a reassigned method, a computed
/// method name and an optional member or call all fall back by name.
#[test]
fn an_allowlisted_method_on_a_user_defined_receiver_falls_back() {
    for f in [
        "plain-method-override.tsx",
        "plain-method-class.tsx",
        "plain-method-date-shadow.tsx",
        "plain-method-reassigned.tsx",
        "plain-method-computed.tsx",
        "plain-method-optional.tsx",
        "plain-method-optional-call.tsx",
        // Mellow F1: the receiver is a positive allowlist, so an object literal one indirection away refuses too.
        "plain-method-via-member.tsx",
        "plain-method-via-array-index.tsx",
        "plain-method-via-literal-member.tsx",
        "plain-method-via-local-array.tsx",
        "plain-method-via-from-entries.tsx",
        "plain-method-via-from-entries-local.tsx",
        // A proven helper returning a method of its argument: the argument must be an accepted receiver too.
        "plain-method-via-helper.tsx",
        // Mellow F2: a list item is a receiver only when its list is (a local, an inline and a module const list).
        "plain-method-loop-local.tsx",
        "plain-method-loop-inline.tsx",
        "plain-method-loop-module.tsx",
        // Mellow F3: a state value is a receiver only when its initial value is primitive.
        "plain-method-state-object.tsx",
        "plain-method-state-prop.tsx",
        "plain-method-state-lazy.tsx",
    ] {
        let (ir, _) = page(f);
        assert!(
            rules(&ir).contains(&"jsx-const-child"),
            "{f}: {:?}",
            ir.diagnostics
        );
        assert!(is_react(&ir), "{f}: {:?}", ir.tier);
    }
}
