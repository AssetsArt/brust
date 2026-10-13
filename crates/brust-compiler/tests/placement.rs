//! M1b-2 Task 3: placement — Server / Precomputed / ClientOnly and the
//! precompute job.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::ir::*;
use brust_compiler::parse::run_on_compiler_thread;

pub fn analyze(path: &str, src: &str) -> ComponentIR {
    let (p, s) = (path.to_string(), src.to_string());
    run_on_compiler_thread(move || {
        analyze_source(&p, s.into_bytes(), &AnalyzeOptions::default()).unwrap()
    })
}

fn fixture(name: &str) -> ComponentIR {
    let src = std::fs::read_to_string(format!(
        "{}/../../tests/fixtures/{name}/input.tsx",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    analyze(&format!("tests/fixtures/{name}/input.tsx"), &src)
}

fn derived<'a>(ir: &'a ComponentIR, name: &str) -> &'a Expr {
    &ir.derived.iter().find(|d| d.name == name).unwrap().expr
}

/// Slot expressions of the template, document order.
fn slots(n: &Node, out: &mut Vec<Expr>) {
    match n {
        Node::Slot(e) => out.push(e.clone()),
        Node::Element { children, .. } | Node::Fragment(children) => {
            children.iter().for_each(|c| slots(c, out))
        }
        Node::For { body, .. } => body.iter().for_each(|c| slots(c, out)),
        Node::If { then, else_, .. } => then.iter().chain(else_).for_each(|c| slots(c, out)),
        _ => {}
    }
}

#[test]
fn product_card_places_server_and_precomputed() {
    let ir = fixture("product-card");
    let mut s = Vec::new();
    slots(&ir.template, &mut s);
    // `{item.name}`, `{unit}`, `{total}` are template reads.
    assert!(s.iter().all(|e| matches!(e, Expr::Server(_))), "{s:?}");
    assert_eq!(
        derived(&ir, "unit"),
        &Expr::Precomputed {
            slot: "_s1".into(),
            js: "formatPrice(item.price)".into(),
            client_js: None,
            inputs: vec!["item.price".into()],
            state_dependent: false,
            per_item: None,
        }
    );
    assert_eq!(
        derived(&ir, "total"),
        &Expr::Precomputed {
            slot: "_s2".into(),
            js: "formatPrice(item.price * qty)".into(),
            client_js: Some("formatPrice(props().item.price * qty())".into()),
            inputs: vec!["item.price".into()],
            state_dependent: true,
            per_item: None,
        }
    );
    assert!(matches!(ir.state[0].init, Expr::Server(_)));
    assert_eq!(
        ir.jobs,
        [JobDecl {
            kind: JobKind::Precompute,
            inputs: vec!["item.price".into()],
            outputs: vec!["_s1".into(), "_s2".into()],
            per_item: None,
            props: None,
            literals: Default::default(),
        }]
    );
}

#[test]
fn theme_toggle_needs_no_job() {
    let ir = fixture("theme-toggle");
    assert!(matches!(derived(&ir, "label"), Expr::Server(_)));
    assert!(matches!(
        &ir.state[0].init,
        Expr::Server(ServerExpr(RawExpr {
            kind: RawKind::Lit(_),
            ..
        }))
    ));
    assert!(ir.jobs.is_empty());
}

/// Review Focus 3: a slot in a list body is per item and the list is the input.
#[test]
fn list_slots_are_per_item() {
    let ir = analyze(
        "L.tsx",
        "import { fmt } from './money'\nexport default function L({ items }: any) { return <ul>{items.map((i: any) => <li key={i.id}>{fmt(i.price)}</li>)}</ul> }",
    );
    let mut s = Vec::new();
    slots(&ir.template, &mut s);
    assert_eq!(
        s,
        [Expr::Precomputed {
            slot: "_s1".into(),
            js: "fmt(i.price)".into(),
            client_js: None,
            inputs: vec!["items".into()],
            state_dependent: false,
            per_item: Some("i".into()),
        }]
    );
    assert_eq!(ir.jobs[0].inputs, ["items"]);
}

#[test]
fn unreached_derived_and_refs_are_client_only() {
    let ir = analyze(
        "C.tsx",
        "import { useState, useRef } from 'react'\nexport default function C({ a }: any) { const [n, setN] = useState(0); const r = useRef(null); const next = n + a; return <button ref={r} onClick={() => setN(next)}>{n}</button> }",
    );
    assert_eq!(
        derived(&ir, "next"),
        &Expr::ClientOnly {
            js: "n() + props().a".into()
        }
    );
    assert!(matches!(ir.refs[0].init, Expr::ClientOnly { .. }));
}

#[test]
fn derived_chain_slot_feeds_a_template_read() {
    let ir = analyze(
        "D.tsx",
        "import { fmt } from './money'\nexport default function D({ a }: any) { const p = fmt(a); const q = p + '!'; return <p title={q}>{p}</p> }",
    );
    assert!(matches!(derived(&ir, "p"), Expr::Precomputed { slot, .. } if slot == "_s1"));
    assert!(matches!(derived(&ir, "q"), Expr::Server(_)));
    let Node::Element { attrs, .. } = &ir.template else {
        panic!()
    };
    assert!(matches!(
        &attrs[0],
        Attr::Dynamic {
            value: Expr::Server(_),
            ..
        }
    ));
}

#[test]
fn jsx_in_an_expression_falls_back() {
    let ir = analyze(
        "J.tsx",
        "export default function J({ a }: any) { return <p>{a ?? <b/>}</p> }",
    );
    assert!(ir.diagnostics.iter().any(|d| d.rule == "jsx-expression"));
}

/// F33: `user && fmt(user.balance)` must put `user` itself in the job inputs so null and {} differ.
#[test]
fn truthiness_guard_contributes_the_prop_root_to_job_inputs() {
    let ir = analyze(
        "T.tsx",
        "import { fmt } from './money'\nexport default function Card(props: { user: { balance: number } | null }) { return <div>{props.user && <b>{fmt(props.user.balance)}</b>}</div> }",
    );
    let job = ir
        .jobs
        .iter()
        .find(|j| matches!(j.kind, JobKind::Precompute))
        .expect("precompute job");
    assert_eq!(job.inputs, vec!["user".to_string()], "{:?}", job.inputs);
}

// L1 (gap-const-fold): module consts fold into the template; anything unprovable stays a slot.

fn module_const(head: &str, body: &str) -> ComponentIR {
    analyze(
        "C.tsx",
        &format!("{head}\nexport default function C() {{ {body} }}"),
    )
}

fn painted(ir: &ComponentIR) -> Vec<Expr> {
    let mut s = Vec::new();
    slots(&ir.template, &mut s);
    s
}

#[test]
fn module_const_folds_to_a_server_value_with_no_job() {
    let ir = module_const(
        "const A = 2\nconst B = A * 3\nconst O = { k: [1, B] }",
        "return <p>{O.k[1]}</p>",
    );
    assert!(painted(&ir).iter().all(|e| matches!(e, Expr::Server(_))));
    assert!(ir.jobs.is_empty() && !ir.needs_worker, "{:?}", ir.jobs);
}

#[test]
fn module_const_used_by_use_state_folds() {
    let ir = module_const(
        "import { useState } from 'react'\nconst START = 5",
        "const [n] = useState(START); return <p>{n}</p>",
    );
    assert!(
        matches!(ir.state[0].init, Expr::Server(_)),
        "{:?}",
        ir.state
    );
    assert!(ir.jobs.is_empty() && !ir.needs_worker);
}

#[test]
fn mutated_array_const_stays_a_slot_but_a_primitive_folds() {
    for head in [
        "const A = [1]\nA.push(2)",
        "const A = [1]\nA[0] = 9",
        "const A = [1]\nconst B = A\nB.sort()",
        "const A = [1]\nfunction touch(x: number[]) { x.length = 0 }\ntouch(A)",
        // R1.1a: a written `.length` is a mutation
        "const A = [1]\nA.length = 0",
        "const A = [1]\nA.length++",
        "const A = [1]\nA.length -= 1",
        // R1.1a: element aliases and literal containers
        "const A = [{ v: 1 }]\nfor (const x of A) x.v = 2",
        "const A = [{ v: 1 }]\nA.forEach((x) => { x.v = 2 })",
        "const A = [{ v: 1 }]\nconst BOX = { items: A }\nBOX.items.push({ v: 2 })",
        "const A = [{ v: 1 }]\nconst B = [A]\nB[0].push({ v: 2 })",
        "const A = [{ v: 1 }]\nA.map((x) => { x.v = 2; return x })",
        "const A = [{ v: 1 }]\nA.find((x) => x.v === 1)!.v = 3",
        "const A = [{ v: 1 }]\nconst first = A[0]\nfirst.v = 4",
        "const A = [{ v: 1 }]\nObject.values(A)[0].v = 5",
        "const A = [{ v: 1 }]\nfunction f() { return A }\nf().push({ v: 2 })",
    ] {
        let ir = module_const(head, "return <p>{A.length}</p>");
        assert!(ir.needs_worker, "{head}: must stay a job");
    }
    let ir = module_const("const A = [1]\nconsole.log(A)", "return <p>{A.length}</p>");
    assert!(ir.needs_worker, "an array handed to a call stays a job");
    // Proven read-only uses keep the fold.
    for head in [
        "const A = [{ v: 1 }]\nconst n = A.filter((x) => x.v > 0).length",
        "const A = [{ v: 1 }]\nconst s = [...A]\nconst k = Object.keys(A)",
        "const A = [{ v: 1 }]\nA.some((x) => x.v === 1)",
    ] {
        let ir = module_const(head, "return <p>{A.length}</p>");
        assert!(!ir.needs_worker, "{head}: read-only uses still fold");
    }
    let ir = module_const("const N = 4\nconsole.log(N)", "return <p>{N}</p>");
    assert!(
        !ir.needs_worker,
        "a primitive folds even when passed to a call"
    );
}

#[test]
fn const_with_a_call_global_or_let_stays_a_slot() {
    for head in [
        "const A = Date.now()",
        "const A = [3, 1].slice()",
        "let A = 1",
        "const A = process.env.X",
        "const A = new Map()",
    ] {
        let ir = module_const(head, "return <p>{A}</p>");
        assert!(ir.needs_worker, "{head}: must stay a job");
    }
}

#[test]
fn a_body_local_shadowing_a_const_wins() {
    let ir = analyze(
        "C.tsx",
        "const label = 'module'\nexport default function C({ name }: { name: string }) { const label = name.toUpperCase(); return <p>{label}</p> }",
    );
    let src = format!("{:?}", painted(&ir));
    assert!(!src.contains("module"), "{src}");
}

#[test]
fn a_cycle_and_a_deep_chain_do_not_fold_or_hang() {
    let ir = module_const("const A = B + 1\nconst B = A + 1", "return <p>{A}</p>");
    assert!(ir.needs_worker);
    let chain: String = (0..20)
        .map(|i| {
            format!(
                "const C{} = {}",
                i + 1,
                if i == 0 {
                    "1".into()
                } else {
                    format!("C{i} + 1")
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let ir = module_const(&chain, "return <p>{C20}</p>");
    assert!(ir.needs_worker, "a chain deeper than 16 stays a job");
    let ir = module_const(&chain, "return <p>{C10}</p>");
    assert!(!ir.needs_worker, "a chain within 16 folds");
}

// L2 (gap-build-eval): which precompute slots the build may evaluate once.

fn eval_slots(head: &str, body: &str) -> Vec<(String, bool)> {
    module_const(head, body)
        .build_eval
        .iter()
        .map(|b| (b.slot.clone(), b.build_time))
        .collect()
}

#[test]
fn a_pure_helper_called_with_constants_is_a_build_eval_candidate() {
    let r = eval_slots(
        "function fmt(n: number) { return n.toFixed(2) }\nconst K = 3",
        "return <p>{fmt(K)}</p>",
    );
    assert_eq!(r, vec![("_s1".to_string(), false)]);
}

#[test]
fn impure_or_request_dependent_slots_are_not_candidates() {
    for (head, body) in [
        ("function f() { return Date.now() }", "return <p>{f()}</p>"),
        (
            "function f() { return new Intl.NumberFormat().format(1) }",
            "return <p>{f()}</p>",
        ),
        (
            "function f() { return process.env.X }",
            "return <p>{f()}</p>",
        ),
        (
            "function f() { return Math.random() }",
            "return <p>{Math.random()}</p>",
        ),
        (
            "let n = 1\nfunction f() { return n }",
            "return <p>{f()}</p>",
        ),
        (
            "var n = 1\nfunction f() { return n }",
            "return <p>{f()}</p>",
        ),
        (
            "import { g } from 'pkg'\nfunction f() { return g() }",
            "return <p>{f()}</p>",
        ),
        (
            "function f(x: number) { return x * 2 }",
            "return <p>{f(props.n)}</p>",
        ),
    ] {
        let src = head.to_string();
        let ir = analyze(
            "C.tsx",
            &format!("{src}\nexport default function C(props: any) {{ {body} }}"),
        );
        assert!(
            ir.build_eval.is_empty(),
            "{head} / {body}: {:?}",
            ir.build_eval
        );
    }
    // inside a condition or a list, and state-dependent values, stay jobs
    assert!(
        eval_slots(
            "function f() { return 1 }",
            "return <p>{props.ok && f()}</p>"
        )
        .is_empty()
    );
}

#[test]
fn build_time_is_recognised_only_from_core_and_allows_package_imports() {
    let ok = analyze(
        "C.tsx",
        "import { buildTime } from '@brust/core'\nimport { hl } from 'pkg'\nexport default function C() { const h = buildTime(async () => hl('x')); return <p>{h}</p> }",
    );
    assert_eq!(ok.build_eval.len(), 1, "{:?}", ok.diagnostics);
    assert!(ok.build_eval[0].build_time);
    // a function that merely has the name is not the opt-in
    let named = analyze(
        "C.tsx",
        "import { buildTime } from './mine'\nimport { hl } from 'pkg'\nexport default function C() { const h = buildTime(() => hl('x')); return <p>{h}</p> }",
    );
    assert!(named.build_eval.is_empty());
}

#[test]
fn build_time_that_reads_props_warns_and_stays_a_job() {
    let ir = analyze(
        "C.tsx",
        "import { buildTime } from '@brust/core'\nexport default function C({ code }: any) { const h = buildTime(() => code.toUpperCase()); return <p>{h}</p> }",
    );
    assert!(ir.build_eval.is_empty());
    let d = ir
        .diagnostics
        .iter()
        .find(|d| d.rule == "build-time-input")
        .unwrap();
    assert!(d.message.contains("code"), "{}", d.message);
    assert!(d.line > 0, "a real location");
    assert!(
        ir.jobs
            .iter()
            .any(|j| matches!(j.kind, JobKind::Precompute))
    );
}

#[test]
fn build_time_reading_time_or_randomness_is_an_error() {
    let ir = analyze(
        "C.tsx",
        "import { buildTime } from '@brust/core'\nexport default function C() { const h = buildTime(() => Date.now()); return <p>{h}</p> }",
    );
    let d = ir
        .diagnostics
        .iter()
        .find(|d| d.rule == "build-time-impure")
        .unwrap();
    assert_eq!(d.class, DiagClass::Error);
    assert!(d.message.contains("Date"), "{}", d.message);
}

#[test]
fn build_time_in_client_code_is_an_error() {
    let ir = analyze(
        "C.tsx",
        "import { buildTime } from '@brust/core'\nimport { useState } from 'react'\nexport default function C() { const [n, setN] = useState(0); return <button onClick={() => setN(buildTime(() => n + 1))}>{n}</button> }",
    );
    let d = ir
        .diagnostics
        .iter()
        .find(|d| d.rule == "build-time-client")
        .unwrap();
    assert_eq!(d.class, DiagClass::Error);
}

#[test]
fn a_slot_value_from_the_build_replaces_the_slot_with_a_literal_and_drops_the_job() {
    use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
    use brust_compiler::parse::run_on_compiler_thread;
    let src = "function f() { return 6 * 7 }\nexport default function C() { return <p>{f()}</p> }";
    let first = analyze("C.tsx", src);
    let key = first.build_eval[0].key.clone();
    assert!(first.needs_worker);
    // objects use the build's `{"$": [[key, value]…]}` encoding (key order survives serde_json)
    let mut values = std::collections::HashMap::new();
    values.insert(key, serde_json::json!(42));
    let s = src.to_string();
    let second = run_on_compiler_thread(move || {
        analyze_source(
            "C.tsx",
            s.into_bytes(),
            &AnalyzeOptions {
                slot_values: values,
                ..Default::default()
            },
        )
        .unwrap()
    });
    assert!(
        second.jobs.is_empty() && !second.needs_worker,
        "{:?}",
        second.jobs
    );
    assert!(second.build_eval.is_empty());
    let mut s = Vec::new();
    slots(&second.template, &mut s);
    assert!(
        matches!(&s[0], Expr::Server(ServerExpr(r)) if matches!(&r.kind, RawKind::Lit(Literal::Num(n)) if *n == 42.0)),
        "{s:?}"
    );
}
