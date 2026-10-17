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

/// A whole context value (`JSON.stringify(c)`) the Provider hands out as FIELDS, and an object Provider `value` that is not
/// an object literal, fall back.
#[test]
fn a_whole_context_value_and_a_non_literal_provider_value_fall_back() {
    for (f, code) in [
        // R34.142: a context with a literal default may be read whole (`__whole`); this Provider hands out fields
        ("escape.tsx", "context-shape"),
        ("value-shape.tsx", "context-value"),
    ] {
        let all = compile(f);
        let rules: Vec<&str> = all.iter().flat_map(|(_, ir, _)| rules(ir)).collect();
        assert!(rules.contains(&code), "{f}: {rules:?}");
    }
}

/// R34.142: a context declared with a literal default (`createContext(0)`) is one whole value: its Provider's `value` is any
/// expression, a consumer reads it as a value, and the page lowers (no island).
#[test]
fn a_scalar_context_provider_value_reaches_a_consumer_that_reads_it_whole() {
    let all = compile("scalar-value.tsx");
    let rules: Vec<&str> = all.iter().flat_map(|(_, ir, _)| rules(ir)).collect();
    assert!(
        !all.iter().any(|(_, ir, _)| is_react(ir))
            && !rules.iter().any(|r| r.starts_with("context")),
        "{rules:?}"
    );
    let jinja = &all[0].2;
    assert!(jinja.contains("<b>{{ (1) | e }}</b>"), "{jinja}");
}

/// W1d (progress, ruling on challenge 2c9522ea): the Provider's values call helpers of ITS module (`clamp`, `stateOf`), proven to
/// return primitives. A call is not a literal and a call site cannot substitute it into a lowered frame (the cut stays: no
/// call in a frame), so the Provider's own native instance evaluates it and the page lowers with a native clone.
#[test]
fn a_provider_value_that_calls_a_plain_helper_makes_a_native_frame() {
    let out = compile_all("helper-page.tsx");
    let page = out
        .iter()
        .find(|(id, ..)| id.starts_with("helperPage_"))
        .expect("page");
    assert!(!is_react(&page.1), "{:?}", page.1.tier);
    assert!(
        !rules(&page.1).iter().any(|r| r.starts_with("context")),
        "{:?}",
        page.1.diagnostics
    );
    // the consumer's value is the Provider instance's own derived member, never a call printed at the call site
    assert!(
        page.2.contains("data-state=") && page.2.contains("\"complete\""),
        "{}",
        page.2
    );
    assert!(
        !page.2.contains("clamp(") && !page.2.contains("stateOf("),
        "{}",
        page.2
    );
}

/// The same shape with a function-valued prop whose default is a plain module function (Radix `getValueLabel`): the Provider
/// qualifies (condition 1: a call of a proven-plain function over plain props, read through a conditional), the page lowers.
#[test]
fn a_function_prop_with_a_plain_default_lowers_the_provider() {
    let all = compile("fn-default.tsx");
    assert!(
        !all.iter().any(|(_, ir, _)| is_react(ir)),
        "{:?}",
        all.iter()
            .map(|(_, ir, _)| (&ir.id, &ir.tier))
            .collect::<Vec<_>>()
    );
    let page = all
        .iter()
        .map(|(_, _, j)| j.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        page.contains("progressbar") && page.contains("data-value"),
        "{page}"
    );
}

/// A wrapper that spreads its own props onto the Provider component (shadcn's `<Progress.Root {...props}>`) carries whatever
/// ITS callers pass: the callable requirement moves up, the call site that passes no function stays native and the one that
/// passes any refuses by name.
#[test]
fn a_wrapper_spreading_its_props_moves_the_callable_requirement_to_its_callers() {
    let all = compile("fn-wrap-ok.tsx");
    assert!(
        !all.iter().any(|(_, ir, _)| is_react(ir)),
        "{:?}",
        all.iter()
            .map(|(_, ir, _)| (&ir.id, &ir.tier))
            .collect::<Vec<_>>()
    );
    let out = compile_all("fn-wrap-passed.tsx");
    let page = out
        .iter()
        .find(|(id, ..)| id.starts_with("fnWrapPassed_"))
        .expect("page");
    assert!(is_react(&page.1), "{:?}", page.1.tier);
    assert!(
        rules(&page.1).contains(&"frozen-prop"),
        "{:?}",
        page.1.diagnostics
    );
}

/// F328b: `typeof children === 'function' ? children(..) : children` is read as `{children}` when every child given is provably a
/// node; a function (an arrow, an identifier, `children={fn}`) is one React calls, so those call sites fall back by name.
#[test]
fn a_component_that_calls_its_function_children_takes_only_provable_nodes() {
    let ok = compile("cc-ok.tsx");
    assert!(
        !ok.iter().any(|(_, ir, _)| is_react(ir)),
        "{:?}",
        ok.iter()
            .map(|(_, ir, _)| (&ir.id, &ir.tier))
            .collect::<Vec<_>>()
    );
    for (file, id) in [
        ("cc-arrow.tsx", "ccArrow_"),
        ("cc-ident.tsx", "ccIdent_"),
        ("cc-prop.tsx", "ccProp_"),
    ] {
        let out = compile_all(file);
        let page = out.iter().find(|(i, ..)| i.starts_with(id)).expect("page");
        assert!(is_react(&page.1), "{file}: {:?}", page.1.tier);
        assert!(
            rules(&page.1).contains(&"children-read"),
            "{file}: {:?}",
            page.1.diagnostics
        );
    }
}

/// F328a: `composeEventHandlers` is a function (its handler body may read `document`) only when it comes from
/// `@radix-ui/primitive`; the same name from any other package is an ordinary call, painted like one.
#[test]
fn compose_event_handlers_is_a_function_only_from_the_radix_package() {
    let radix = compile_all("compose-radix.tsx");
    let page = radix
        .iter()
        .find(|(i, ..)| i.starts_with("composeRadix_"))
        .expect("page");
    assert!(
        !rules(&page.1).contains(&"browser-global"),
        "{:?}",
        page.1.diagnostics
    );
    let other = compile_all("compose-other.tsx");
    let page = other
        .iter()
        .find(|(i, ..)| i.starts_with("composeOther_"))
        .expect("page");
    assert!(
        rules(&page.1).contains(&"browser-global"),
        "{:?}",
        page.1.diagnostics
    );
}

/// F340: the requirement a wrapper moves up names the callable props (`getValueLabel`), not every key its callers pass: a
/// `className={expr}` through `{...props}` stays native.
#[test]
fn a_wrapper_only_moves_the_callable_names_up_not_every_key() {
    let all = compile("fn-wrap-class.tsx");
    assert!(
        !all.iter().any(|(_, ir, _)| is_react(ir)),
        "{:?}",
        all.iter()
            .map(|(_, ir, d)| (&ir.id, &ir.tier, d))
            .collect::<Vec<_>>()
    );
}

/// F347: only the rest or the whole props (an exact `*`) deliver a key under the name its callers wrote, so only they move
/// the callable requirement up. `{...props.cfg}` delivers `cfg`'s members, which no caller key names, so the wrapper itself
/// refuses the Root call site by the callable name (F335 closes the component-tag path spread under another rule).
#[test]
fn a_member_spread_does_not_move_the_callable_requirement_up() {
    let all = compile("fn-wrap-cfg.tsx");
    let wrap = all
        .iter()
        .find(|(id, ..)| id.starts_with("wrap_"))
        .expect("Wrap");
    assert!(
        wrap.1.diagnostics.iter().any(|d| d.rule == "frozen-prop"
            && d.message.contains("`getValueLabel`")
            && d.message.contains("may call a function prop")),
        "{:?}",
        wrap.1.diagnostics
    );
    assert!(
        !wrap.1.callable_props.iter().any(|p| p == "getValueLabel"),
        "the requirement was lifted to callers that cannot name it: {:?}",
        wrap.1.callable_props
    );
}

/// F329: a `useRef` cell whose every use is the `ref` prop of a component element (Radix ToggleGroupItem's `ref`) hands nothing to
/// anyone: the call site drops it and the child renders; one read in a handler keeps the fallback.
#[test]
fn a_ref_nothing_reads_is_dropped_at_the_call_site() {
    for file in ["sink-ref-ok.tsx", "sink-ref-two.tsx"] {
        let all = compile(file);
        assert!(
            !all.iter().any(|(_, ir, _)| is_react(ir)),
            "{file}: {:?}",
            all.iter()
                .map(|(_, ir, _)| (&ir.id, &ir.tier, rules(ir)))
                .collect::<Vec<_>>()
        );
    }
    let out = compile_all("sink-ref-read.tsx");
    let page = out
        .iter()
        .find(|(i, ..)| i.starts_with("sinkRefRead_"))
        .expect("page");
    assert!(is_react(&page.1), "{:?}", page.1.tier);
    assert!(
        rules(&page.1).contains(&"forwardref-ref"),
        "{:?}",
        page.1.diagnostics
    );
}

/// A Provider field that IS a call of a proven-plain module function (`pct: clamp(value)`) is evaluated by the Provider's own
/// instance (a native clone per call site): the call is never substituted into a lowered frame at the call site.
#[test]
fn a_provider_field_that_is_a_plain_call_is_evaluated_by_the_native_clone() {
    let all = compile("call-field.tsx");
    assert!(
        !all.iter().any(|(_, ir, _)| is_react(ir)),
        "{:?}",
        all.iter().map(|(_, ir, _)| &ir.tier).collect::<Vec<_>>()
    );
    assert!(
        all.iter()
            .any(|(id, ..)| id.starts_with("meter_") && id.contains("_s")),
        "{:?}",
        all.iter().map(|(id, ..)| id).collect::<Vec<_>>()
    );
    assert!(
        all.iter().all(|(.., j)| !j.contains("clamp(")),
        "a call printed at a call site"
    );
}

/// A call site that passes the function itself (the prop the Provider's helper call may run) cannot be served by a job that
/// evaluates the module's default: the prop is frozen, and the page renders with React rather than print the default's value.
#[test]
fn a_call_site_that_passes_the_function_prop_keeps_the_page_react() {
    // an inline arrow, and a named module function (neither reads state, so only the callable rule can refuse them)
    for (file, id) in [
        ("fn-default-passed.tsx", "fnDefaultPassed_"),
        ("fn-default-named.tsx", "fnDefaultNamed_"),
    ] {
        let out = compile_all(file);
        let page = out.iter().find(|(i, ..)| i.starts_with(id)).expect("page");
        assert!(is_react(&page.1), "{file}: {:?}", page.1.tier);
        assert!(
            rules(&page.1).contains(&"frozen-prop"),
            "{file}: {:?}",
            page.1.diagnostics
        );
    }
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

/// A Provider that hands out state is a React island by itself; the page that renders it stays static and never becomes
/// React because of it. F267: with the content written in the Provider's own module, the call site gets a native clone
/// (2c-2), and the island nobody references is not part of the tree.
#[test]
fn a_provider_that_hands_out_state_is_specialised_for_content_of_its_own_module() {
    let all = compile_all("state-provider.tsx");
    let clone = all
        .iter()
        .find(|(id, ir, ..)| id.starts_with("disclosure_") && ir.specialised)
        .map(|(_, ir, ..)| ir.clone())
        .expect("the clone");
    assert!(
        !is_react(&clone),
        "{:?} {:?}",
        clone.tier,
        clone.diagnostics
    );
    assert!(
        !all.iter()
            .any(|(id, ir, ..)| id.starts_with("disclosure_") && !ir.specialised),
        "no island Provider is left"
    );
    let page = all
        .iter()
        .find(|(id, ..)| id.starts_with("stateProvider_"))
        .map(|(_, ir, ..)| ir.clone())
        .expect("page");
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

/// F198 + F199: the same element holders printed with no wrapper (`<section>{icons.home}</section>`) or passed as a prop
/// the child prints (`<Badge icon={icons.home} />`) fall back by name, as under a wrapper; on main they printed the
/// element's internals (`{'key': None, 'props': …}`). Ordinary reads at the top level and in props keep lowering.
#[test]
fn an_element_holder_falls_back_with_no_wrapper_and_as_a_prop() {
    for at in ["top", "prop"] {
        for kind in ["imp", "loc"] {
            for shape in ["root", "and", "tern", "member", "index", "array", "call"] {
                let f = format!("{at}-{kind}-{shape}.tsx");
                let (ir, _) = page(&f);
                assert!(
                    rules(&ir).contains(&"jsx-const-child") && is_react(&ir),
                    "{f}: {:?} {:?}",
                    ir.tier,
                    ir.diagnostics
                );
            }
        }
    }
    // A prop helper is judged through what it reads: another helper that writes JSX, an app module holding elements,
    // React's `createElement`.
    for f in [
        "prop-loc-indirect.tsx",
        "prop-loc-via-import.tsx",
        "prop-loc-react.tsx",
        // A spread of an element into an object literal copies its fields.
        "prop-spread-object.tsx",
        // A module object another function fills with an element.
        "prop-loc-mutated.tsx",
        "prop-loc-assign.tsx",
        // … through an alias, or through a root that is not a name.
        "prop-loc-alias.tsx",
        "prop-loc-opaque-write.tsx",
        // An app function called with a callback that returns an element.
        "prop-loc-callback.tsx",
        // An element-free helper handed an element to store.
        "prop-loc-put.tsx",
        "prop-loc-push.tsx",
        // Mellow round 1: a parameter default, a destructured module binding, the comma operator; a state started with
        // an element, a loop over a list of elements.
        "top-param-default.tsx",
        "top-param-pattern.tsx",
        "top-pattern-binding.tsx",
        "top-hoisted-var.tsx",
        "top-comma.tsx",
        "top-state-element.tsx",
        "top-loop-element.tsx",
    ] {
        let (ir, _) = page(f);
        assert!(
            rules(&ir).contains(&"jsx-const-child") && is_react(&ir),
            "{f}: {:?} {:?}",
            ir.tier,
            ir.diagnostics
        );
    }
    // Accepted lowering loss, as under a wrapper: a member of an imported object is not provable (objects never cross a
    // module boundary by R1.1b, so another importer could rebind the field).
    let (ir, _) = page("top-imp-object.tsx");
    assert!(
        rules(&ir).contains(&"jsx-const-child") && is_react(&ir),
        "{:?}",
        ir.diagnostics
    );
    let (ir, jinja) = page("top-ordinary.tsx");
    assert!(
        !rules(&ir).contains(&"jsx-const-child") && !is_react(&ir),
        "{:?} {:?}",
        ir.tier,
        ir.diagnostics
    );
    assert!(!jinja.is_empty());
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

/// F205: narrowings of the plain-wrapper receiver rule, each with a proof. A state whose `?:` / `&&` / `||` / `??` init is
/// primitive-typed in every branch; an item field of a module-const or literal array whose every value is a primitive
/// literal (nested lists too); `filter(pred)` with a read-only `pred` over an accepted list; `new Date(x)` through a local.
#[test]
fn f205_proven_receivers_lower() {
    let mut bad = Vec::new();
    for f in [
        "f205-state-cond.tsx",
        "f205-state-logical.tsx",
        "f205-module-items.tsx",
        "f205-module-nested.tsx",
        "f205-inline-strings.tsx",
        "f205-prop-filter.tsx",
        "f205-module-filter.tsx",
        "f205-date-local.tsx",
        "f205-date-local-nested.tsx",
    ] {
        let (ir, jinja) = page(f);
        if rules(&ir).contains(&"jsx-const-child") || is_react(&ir) || jinja.is_empty() {
            bad.push(format!("{f}: {:?}", ir.diagnostics));
        }
    }
    assert!(bad.is_empty(), "{bad:#?}");
}

/// F205 hostile probes: each breaks one step of a proof above and falls back by name.
#[test]
fn f205_unproven_receivers_fall_back() {
    for f in [
        // An object in one branch; a prop operand (a prop init stays refused, Mellow F3).
        "f205-x-state-cond-object.tsx",
        "f205-x-state-logical-prop.tsx",
        // A field that is an object, missing on one element, shadowed by a later duplicate key, only on `__proto__`,
        // a const written at module level, the element itself (an object), an index out of range, a non-literal leaf.
        "f205-x-module-leaf-object.tsx",
        "f205-x-module-missing-key.tsx",
        "f205-x-module-duplicate-key.tsx",
        "f205-x-module-proto.tsx",
        "f205-x-module-mutated.tsx",
        "f205-x-module-item-object.tsx",
        "f205-x-module-index-range.tsx",
        "f205-x-local-leaf.tsx",
        // A predicate that calls, assigns, is not an arrow, or converts an operand (`valueOf` may run author code).
        "f205-x-filter-call.tsx",
        "f205-x-filter-assign.tsx",
        "f205-x-filter-prop-pred.tsx",
        "f205-x-filter-coerce.tsx",
        // A const holding a function is not plain data: its own `toString` may write it (`this.s = …`).
        "f205-x-data-method.tsx",
    ] {
        let (ir, _) = page(f);
        assert!(
            rules(&ir).contains(&"jsx-const-child") && is_react(&ir),
            "{f}: {:?} {:?}",
            ir.tier,
            ir.diagnostics
        );
    }
}

/// F215: a precompute job, the client chunk and the build evaluation copy a module's declarations, never a statement
/// that changes them (`xs.push('b')` at the top level printed "a" where React prints "a,b"). A component that reads a
/// module binding of a module with such a statement falls back by name; a module without one, or a component that
/// reads none of its bindings, keeps lowering.
#[test]
fn a_module_level_side_effect_falls_back_when_a_module_binding_is_read() {
    for f in [
        "side-push.tsx",
        "side-closure.tsx",
        "side-init.tsx",
        "side-writer.tsx",
        // A package call handed a module object it may change.
        "side-arg.tsx",
        // A `displayName` the module also reads.
        "side-display-read.tsx",
        // Round 1 (Mellow F1, Afrojack F1): code runs at module time through any callable value: an IIFE, a callback,
        // a class static block, static field and constructor, an object method, an arrow const, a getter, a function in
        // an array, a writer handed to a call.
        "side-iife.tsx",
        "side-callback.tsx",
        "side-class-static.tsx",
        "side-class-field.tsx",
        "side-class-ctor.tsx",
        "side-object-method.tsx",
        "side-arrow.tsx",
        "side-getter.tsx",
        "side-array-fn.tsx",
        "side-handed-writer.tsx",
        // Mellow F2: a statement that changes an imported module's object; the import is read.
        "side-import.tsx",
        // Round 2 (Mellow F3): a declaration calling an app import, directly or through a module function.
        "side-import-call.tsx",
        "side-app-caller.tsx",
        // Mellow F4: a write through a callback's parameter to a module object handed in a literal or as the receiver.
        "side-param-write.tsx",
        "side-param-array.tsx",
        // Mellow F5: a destructuring default that runs a writer.
        "side-pattern-default.tsx",
        // Mellow x1 (the allowlist ruling): an implicit call, a template coercing a module object whose toString writes.
        "side-coerce.tsx",
        // Mellow n10, n14, n15: a write through `this` in an object method, a static class method, a writer reached by a
        // parameter default.
        "side-this-method.tsx",
        "side-static-method.tsx",
        "side-param-default.tsx",
        // F215 allowlist (lead ruling b0dff21e): a function that writes a module binding makes its module unclean even
        // when nothing calls it at load time.
        "side-writer-uncalled.tsx",
        // A load-time call of this module's own code (`fmt('a')`, `reg.pick('x')`): only package code and read-only globals
        // may run at load time.
        "side-own-call.tsx",
        // The invariant (lead ruling b0dff21e): no accepted value holds code that writes a module binding, so a package
        // handed a writing callback is refused.
        "side-package-writer.tsx",
        // Mellow V1 (delta b3932298): package code handed a function that returns a module object (a literal arrow or a
        // module function); V2: a member read of an app import, which may run an app getter at load time.
        "side-later.tsx",
        "side-later-fn.tsx",
        "side-app-getter.tsx",
        "side-local-forwardref.tsx",
        // Lead ruling c2f61a77: the exemption is by symbol only; an app re-export or a local alias of forwardRef gets none.
        "side-app-forwardref.tsx",
        "side-alias-forwardref.tsx",
        // Mellow V3 (delta 7f6ce3e0): package code handed an app-imported object, directly or through a closure.
        "side-app-object-handed.tsx",
        "side-app-object-closure.tsx",
        // … and a package handed a callback that calls app code (`wrap((e) => { e.value = formatPrice(1) })`).
        "side-package-callback.tsx",
        // Lead ruling b76d738c: an app re-export of brust's cache gets no exemption.
        "side-app-cache.tsx",
    ] {
        let (ir, _) = page(f);
        assert!(
            rules(&ir).contains(&"module-side-effect") && is_react(&ir),
            "{f}: {:?} {:?}",
            ir.tier,
            ir.diagnostics
        );
    }
    // Callable values that write nothing (an arrow const called, a class, an object method) keep lowering.
    for f in [
        "side-none.tsx",
        "side-unread.tsx",
        "side-callables-pure.tsx",
        "side-class-pure.tsx",
        // Lead ruling c2f61a77: React's forwardRef / memo (by symbol: named, namespace or default import of 'react') handed a
        // render function that reads a module array; they store it and never call it at load time.
        "side-react-forwardref.tsx",
        "side-react-memo.tsx",
        // Lead ruling b76d738c: brust's own cache (by symbol) stores the component, called only at render.
        "side-brust-cache.tsx",
    ] {
        let (ir, jinja) = page(f);
        assert!(
            !rules(&ir).contains(&"module-side-effect") && !is_react(&ir),
            "{f}: {:?} {:?}",
            ir.tier,
            ir.diagnostics
        );
        assert!(!jinja.is_empty(), "{f}");
    }
}

// ---- W1d PR 4a (F326): a local object that spreads the props among plain entries ----

/// Radix ToggleGroupItem's `commonProps = { ...props, pressed, disabled }` spread onto a native child: the props spread, then
/// the own entries (a later entry replaces an earlier key). The page lowers; each instance keeps its own values.
#[test]
fn a_local_object_that_spreads_the_props_among_plain_entries_spreads_as_its_parts() {
    let all = compile("local-spread.tsx");
    let rules: Vec<&str> = all.iter().flat_map(|(_, ir, _)| rules(ir)).collect();
    assert!(all.iter().all(|(_, ir, _)| !is_react(ir)), "{rules:?}");
    let page = all
        .iter()
        .find(|(id, ..)| id.to_lowercase().starts_with("localspread"))
        .expect("page");
    // value="a" is pressed, value="b" is not (and is disabled)
    assert!(
        page.2.contains("aria-pressed") && page.2.contains("disabled"),
        "{}",
        page.2
    );
    assert!(
        page.2.contains("first"),
        "the title travelled through the props spread: {}",
        page.2
    );
}

/// Anything the reader cannot expand stays a refusal: a second spread of another local object, a method.
#[test]
fn a_local_object_with_another_spread_or_a_method_is_still_not_expanded() {
    for f in ["local-spread-other.tsx", "local-spread-method.tsx"] {
        let all = compile(f);
        let item = all
            .iter()
            .find(|(id, ..)| id.starts_with("item"))
            .expect("item");
        assert!(
            is_react(&item.1) && item.1.diagnostics.iter().any(|d| d.rule == "spread-props"),
            "{f}: {:?} {:?}",
            item.1.tier,
            item.1.diagnostics
        );
    }
}

// ---- W1d PR 2: Radix scope hooks and `props.__scopeX` (Mellow C1-C4) ----

fn all_rules(file: &str) -> Vec<String> {
    compile(file)
        .iter()
        .flat_map(|(_, ir, _)| ir.diagnostics.iter().map(|d| d.rule.clone()))
        .collect()
}

fn react_with(file: &str, rule: &str) -> bool {
    let all = compile(file);
    all.iter()
        .any(|(_, ir, _)| ir.diagnostics.iter().any(|d| d.rule == rule) && is_react(ir))
}

/// `props.__scopeX` is the component's own scope, a scope hook's result spread on a component is dropped, and the page stays
/// off React.
#[test]
fn a_scope_read_off_the_props_parameter_and_a_scope_token_spread_on_a_component_lower() {
    let (ir, jinja) = page("scope-props.tsx");
    assert!(!is_react(&ir), "{:?} {:?}", ir.tier, ir.diagnostics);
    assert!(
        all_rules("scope-props.tsx")
            .iter()
            .all(|r| r != "context-scope"),
        "{:?}",
        all_rules("scope-props.tsx")
    );
    assert!(jinja.contains("(7)"), "{jinja}");
}

/// C2: sibling Providers of one context do not leak into each other.
#[test]
fn sibling_scoped_providers_each_serve_their_own_consumer() {
    let (ir, jinja) = page("scope-sibling.tsx");
    assert!(!is_react(&ir), "{:?} {:?}", ir.tier, ir.diagnostics);
    assert!(
        all_rules("scope-sibling.tsx")
            .iter()
            .all(|r| r != "context-scope")
    );
    let (one, two) = (jinja.find("(1)"), jinja.find("(2)"));
    assert!(one.is_some() && two.is_some() && one < two, "{jinja}");
}

/// C2: a scoped Provider nested in another of the same context cannot be told apart by position.
#[test]
fn nested_scoped_providers_of_one_context_fail_closed() {
    assert!(
        react_with("scope-nested.tsx", "context-scope")
            || all_rules("scope-nested.tsx")
                .iter()
                .any(|r| r == "context-scope")
    );
    let (ir, _) = page("scope-nested.tsx");
    assert!(
        ir.diagnostics.iter().any(|d| d.rule == "context-scope") || is_react(&ir),
        "{:?}",
        ir.diagnostics
    );
}

/// C4: a call site that hands a scope to a native component keeps it an island.
#[test]
fn a_call_site_that_writes_a_scope_attribute_on_a_native_component_is_refused() {
    let rules = all_rules("scope-guard.tsx");
    assert!(rules.iter().any(|r| r == "context-scope"), "{rules:?}");
}

/// C3: a scope token spread on a host element, or read as a value, is refused.
#[test]
fn a_scope_token_on_a_host_element_or_read_as_a_value_is_refused() {
    for f in ["scope-token-host.tsx", "scope-token-value.tsx"] {
        let all = compile(f);
        let ind = all
            .iter()
            .find(|(id, ..)| id.starts_with("indicator"))
            .expect("indicator");
        assert!(
            ind.1.diagnostics.iter().any(|d| d.rule == "context-scope") && is_react(&ind.1),
            "{f}: {:?} {:?}",
            ind.1.tier,
            ind.1.diagnostics
        );
    }
}

/// C1: a scope hook is found by what it was made from, never by its name.
#[test]
fn a_hook_named_like_a_scope_hook_that_createcontextscope_did_not_make_is_not_one() {
    for f in ["scope-by-name.tsx", "scope-cross-fake.tsx"] {
        let all = compile(f);
        let ind = all
            .iter()
            .find(|(id, ..)| id.starts_with("indicator"))
            .expect("indicator");
        assert!(
            is_react(&ind.1)
                && ind
                    .1
                    .diagnostics
                    .iter()
                    .any(|d| d.rule == "hook-unsupported"),
            "{f}: {:?} {:?}",
            ind.1.tier,
            ind.1.diagnostics
        );
    }
}

/// C1: provenance through an import: `createYScope` is the second binding of createContextScope in the module it comes from.
/// (The module-level call of an app module's function is `module-side-effect` for any component that reads a module binding,
/// which is unrelated; the scope hook itself must be accepted: no `useYScope` refusal and no `context-scope`.)
#[test]
fn a_scope_factory_imported_from_a_module_that_made_it_is_followed() {
    let all = compile("scope-cross.tsx");
    let ind = all
        .iter()
        .find(|(id, ..)| id.starts_with("indicator"))
        .expect("indicator");
    assert!(
        ind.1
            .diagnostics
            .iter()
            .all(|d| d.rule != "context-scope" && !d.message.contains("useYScope")),
        "{:?} {:?}",
        ind.1.tier,
        ind.1.diagnostics
    );
}

// ---- W1d PR 3: early-return chains and a render error (ruling A) ----

/// An early-return chain is one nested conditional; each branch's consts are hoisted; the last arm is a plain return.
#[test]
fn an_early_return_chain_is_one_nested_conditional() {
    let all = compile("chain.tsx");
    assert!(
        all.iter().all(|(_, ir, _)| !is_react(ir)),
        "{:?}",
        all.iter()
            .map(|(_, ir, _)| &ir.diagnostics)
            .collect::<Vec<_>>()
    );
    let boxed = all
        .iter()
        .find(|(id, ..)| id.starts_with("box"))
        .expect("box");
    assert!(
        boxed.2.contains(r#"kind == "a""#)
            && boxed.2.contains(r#"kind == "b""#)
            && boxed.2.contains("<div>"),
        "{}",
        boxed.2
    );
}

/// Ruling A: the ending `throw new Error(<literal>)` is a render error arm; the message never reaches the template.
#[test]
fn a_chain_ending_in_a_literal_throw_prints_a_render_error_arm_without_the_message() {
    let all = compile("chain-throw.tsx");
    assert!(
        all.iter().all(|(_, ir, _)| !is_react(ir)),
        "{:?}",
        all.iter()
            .map(|(_, ir, _)| &ir.diagnostics)
            .collect::<Vec<_>>()
    );
    let sw = all
        .iter()
        .find(|(id, ..)| id.starts_with("switch"))
        .expect("switch");
    assert!(sw.2.contains("render_error"), "{}", sw.2);
    assert!(
        !sw.2.contains("Missing prop") && !sw.2.contains("Switch'"),
        "{}",
        sw.2
    );
}

/// Ruling A (1, 3): a thrown value that is not an Error with a literal message, or a test that reads state, stays React.
#[test]
fn a_throw_that_is_not_a_literal_error_or_a_test_that_changes_after_mount_stays_react() {
    for f in [
        "chain-throw-msg.tsx",
        "chain-throw-value.tsx",
        "chain-throw-state.tsx",
    ] {
        let all = compile(f);
        let sw = all
            .iter()
            .find(|(id, ..)| id.starts_with("switch"))
            .expect("switch");
        assert!(
            is_react(&sw.1) && sw.1.diagnostics.iter().any(|d| d.rule == "control-flow"),
            "{f}: {:?} {:?}",
            sw.1.tier,
            sw.1.diagnostics
        );
    }
}

/// W1d PR 3: Radix ToggleGroup's root shape: a rest object aliased in each branch (`const singleProps = rest`), a module
/// const object as the discriminant's other side, a literal throw at the end.
#[test]
fn a_rest_aliased_in_each_branch_of_a_type_switch_lowers() {
    let all = compile("chain-rest.tsx");
    let rules: Vec<&str> = all.iter().flat_map(|(_, ir, _)| rules(ir)).collect();
    assert!(all.iter().all(|(_, ir, _)| !is_react(ir)), "{rules:?}");
    let page = all
        .iter()
        .find(|(id, ..)| id.to_lowercase().starts_with("chainrest"))
        .expect("page");
    assert!(
        page.2.contains("radiogroup") && page.2.contains("toolbar"),
        "{}",
        page.2
    );
}

/// W1d PR 3 (ruling A, condition 3; Mellow F1): the props a throwing chain tests are frozen, so a call site that passes a value
/// that changes on the client falls back (`frozen-prop`), and a literal passes.
#[test]
fn the_props_a_throwing_chain_tests_are_frozen_against_a_changing_call_site() {
    let all = compile("chain-throw-live.tsx");
    let sw = all
        .iter()
        .find(|(id, ..)| id.starts_with("switch"))
        .expect("switch");
    assert!(
        sw.1.frozen_props.iter().any(|p| p == "type"),
        "{:?}",
        sw.1.frozen_props
    );
    let page = all
        .iter()
        .find(|(id, ..)| id.to_lowercase().starts_with("chainthrowlive"))
        .expect("page");
    assert!(
        is_react(&page.1) && page.1.diagnostics.iter().any(|d| d.rule == "frozen-prop"),
        "{:?} {:?}",
        page.1.tier,
        page.1.diagnostics
    );
    // a literal at the call site is fine (chain-throw.tsx)
    let ok = compile("chain-throw.tsx");
    assert!(ok.iter().all(|(_, ir, _)| !is_react(ir)));
}

/// N1 (Mellow, Afrojack): only a `const` can alias the rest object.
#[test]
fn a_let_alias_of_the_rest_object_is_not_an_alias() {
    let all = compile("chain-rest-let.tsx");
    let sw = all
        .iter()
        .find(|(id, ..)| id.starts_with("switch"))
        .expect("switch");
    assert!(
        is_react(&sw.1) && sw.1.diagnostics.iter().any(|d| d.rule == "let-var"),
        "{:?} {:?}",
        sw.1.tier,
        sw.1.diagnostics
    );
}

// ---- W1d PR 4b (F327): the rest inside a local object that is only ever spread ----

/// Radix ToggleGroupImpl's `commonProps = { role: 'group', dir: direction, ...toggleGroupProps }`: the rest is not read as a
/// value when the object is only spread onto JSX elements; the children travel in the rest.
#[test]
fn a_local_object_holding_the_rest_that_is_only_spread_reads_no_rest_as_a_value() {
    let all = compile("local-spread-rest.tsx");
    let rules: Vec<&str> = all.iter().flat_map(|(_, ir, _)| rules(ir)).collect();
    assert!(all.iter().all(|(_, ir, _)| !is_react(ir)), "{rules:?}");
    let page = all
        .iter()
        .find(|(id, ..)| id.to_lowercase().starts_with("localspreadrest"))
        .expect("page");
    assert!(
        page.2.contains(r#"role="{{ "group""#) && page.2.contains("one"),
        "{}",
        page.2
    );
}

/// The same object also read as a value stays `prop-pattern`: the rest would be printed as a value.
#[test]
fn the_same_object_read_as_a_value_still_refuses_the_rest() {
    let all = compile("local-spread-rest-value.tsx");
    let g = all
        .iter()
        .find(|(id, ..)| id.starts_with("group"))
        .expect("group");
    assert!(
        is_react(&g.1) && g.1.diagnostics.iter().any(|d| d.rule == "prop-pattern"),
        "{:?} {:?}",
        g.1.tier,
        g.1.diagnostics
    );
}

/// F341: a local object that spreads the props and adds a local function for a callable prop (`{ ...props, getValueLabel: fmt }`)
/// is read as a named key at the Root (F326), so the function is refused by name; one that adds only plain entries stays native.
#[test]
fn a_local_object_spread_carrying_a_local_function_to_a_callable_prop_is_refused() {
    let out = compile("fn-local-spread.tsx");
    assert!(
        out.iter()
            .any(|(_, ir, _)| is_react(ir) && rules(ir).contains(&"frozen-prop")),
        "{:?}",
        out.iter()
            .map(|(id, ir, _)| (id, &ir.tier, rules(ir)))
            .collect::<Vec<_>>()
    );
    let all = compile("fn-local-spread-prop.tsx");
    assert!(
        !all.iter().any(|(_, ir, _)| is_react(ir)),
        "{:?}",
        all.iter()
            .map(|(id, ir, _)| (id, &ir.tier))
            .collect::<Vec<_>>()
    );
}

/// F364 (Afrojack r1): every guard of the sink drop keeps the fallback by name; each fixture is a ref that LOOKS like a sink.
#[test]
fn a_ref_that_is_not_a_sink_keeps_the_forwardref_fallback() {
    for (file, page) in [
        ("sink-ref-child-reads.tsx", "sinkRefChildReads_"),
        ("sink-ref-on-element.tsx", "sinkRefOnElement_"),
        ("sink-ref-assigned.tsx", "sinkRefAssigned_"),
        ("sink-ref-nested-fn.tsx", "sinkRefNestedFn_"),
        ("sink-ref-spread-after.tsx", "sinkRefSpreadAfter_"),
        ("sink-ref-spread-before.tsx", "sinkRefSpreadBefore_"),
        ("sink-ref-child-string.tsx", "sinkRefChildString_"),
        ("sink-ref-child-compose.tsx", "sinkRefChildCompose_"),
    ] {
        let out = compile_all(file);
        let p = out
            .iter()
            .find(|(i, ..)| i.starts_with(page))
            .unwrap_or_else(|| panic!("{file}: page"));
        assert!(is_react(&p.1), "{file}: {:?}", p.1.tier);
        assert!(
            rules(&p.1).contains(&"forwardref-ref"),
            "{file}: {:?}",
            p.1.diagnostics
        );
    }
}
