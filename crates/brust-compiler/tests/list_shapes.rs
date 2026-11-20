//! F562: list rows with a destructured item (`({ a, b: x }) =>`, `([k, , v]) =>`) and with row-local consts in a block
//! body (`const t = …; if (c) return null; return <jsx>`). A destructured name and a row const read as the expression
//! they stand for; the shapes that cannot (a default, a nested pattern, a rest, JSX or a hook in a const, a name a nested
//! scope would capture) stay React with a `list-shape` finding that says which.
mod lower_common;
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{ComponentIR, Tier};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use lower_common::lower;

fn ir(src: &str) -> ComponentIR {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        let out = compile_tree(
            "tests/fixtures/parent-counter/T.tsx",
            Some(s.into_bytes()),
            &AnalyzeOptions {
                root: lower_common::repo(),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        (*out[0].ir).clone()
    })
}

fn page(row: &str) -> String {
    format!("export default function L({{ rows, title }}: any) {{ return <ul>{{{row}}}</ul> }}")
}

fn shape_messages(ir: &ComponentIR) -> Vec<String> {
    ir.diagnostics
        .iter()
        .filter(|d| d.rule == "list-shape")
        .map(|d| d.message.clone())
        .collect()
}

#[track_caller]
fn accepted(src: &str, tier: Tier) -> ComponentIR {
    let ir = ir(src);
    assert!(
        shape_messages(&ir).is_empty() && ir.tier == tier,
        "{src}\n{:?}\n{:?}",
        ir.tier,
        ir.diagnostics
    );
    ir
}

#[track_caller]
fn refused(src: &str, why: &str) {
    let ir = ir(src);
    let m = shape_messages(&ir);
    assert!(
        m.iter().any(|m| m.contains(why)),
        "{src}: want `{why}` in {m:?}\n{:?}",
        ir.diagnostics
    );
    assert!(
        matches!(ir.tier, Tier::React { .. }),
        "{src}: {:?}",
        ir.tier
    );
}

#[test]
fn each_accepted_shape_reads_with_no_fallback() {
    for row in [
        // D2: object pattern, rename, string key; array pattern with a hole
        "rows.map(({ id, name }: any) => <li key={id}>{name}</li>)",
        "rows.map(({ id, name: n }: any, i: number) => <li key={id} title={n}>{n}{i}</li>)",
        "rows.map(({ 'data-id': d }: any) => <li key={d}>{d}</li>)",
        "rows.map(([k, , v]: any) => <li key={k}>{k}={v}</li>)",
        // D3: call-free consts, chained, a builtin method
        "rows.map((r: any) => { const t = r.a + 1; const u = t * 2; return <li key={r.id}>{t}/{u}</li> })",
        "rows.map((r: any) => { const up = r.name.toUpperCase(); return <li key={r.id}>{up}</li> })",
        // D5: early return null (statement and block forms), a const after it
        "rows.map((r: any) => { if (!r.on) return null; return <li key={r.id}>{r.a}</li> })",
        "rows.map((r: any) => { const t = r.a; if (!t) { return null } const u = t + 1; return <li key={r.id}>{u}</li> })",
        // D2 + D3 together
        "rows.map(({ id, tags }: any) => { const first = tags[0]; return <li key={id}>{first}</li> })",
        // D7: `Array.from` takes the same path
        "Array.from({ length: rows.length }, (_: any, i: number) => { const k = i * 2; return <li key={k}>{k}</li> })",
    ] {
        accepted(&page(row), Tier::Static);
    }
}

#[test]
fn a_row_const_reads_the_same_in_every_position() {
    // an attribute, a child, a key, a condition, a nested component's prop
    let src = "function Item({ label }: any) { return <b>{label}</b> }\nexport default function L({ rows }: any) { return <ul>{rows.map((r: any) => { const t = r.a + '!'; const on = r.n > 1; return <li key={t} title={t}>{t}{on ? <i>{t}</i> : null}<Item label={t} /></li> })}</ul> }";
    let ir = accepted(src, Tier::Static);
    let j = lower(src).jinja;
    assert!(!j.contains("{{ t "), "{j}");
    assert!(j.contains("(r.a | js_string) ~ \"!\""), "{j}");
    let _ = ir;
}

#[test]
fn state_driven_rows_with_a_handler_reading_a_row_const_are_native() {
    let src = "import { useState } from 'react'\nexport default function L({ rows }: any) { const [sel, setSel] = useState(''); return <ul>{rows.map(({ id, name }: any) => { const label = name + '!'; return <li key={id} onClick={() => { setSel(label) }}>{label}{sel === label ? '*' : ''}</li> })}</ul> }";
    accepted(src, Tier::Native);
    let c = lower(src).client_js.unwrap();
    // the handler receives the generated item and reads the const as its expression
    assert!(c.contains("const _h1 = (_row1, ...__args)"), "{c}");
    assert!(c.contains("setSel((_row1.name + \"!\"))"), "{c}");
}

#[test]
fn each_unsupported_shape_says_which() {
    for (row, why) in [
        (
            "rows.map(({ a = 1 }: any) => <li key={a}>{a}</li>)",
            "the item pattern has a default value",
        ),
        (
            "rows.map(({ a: { b } }: any) => <li key={b}>{b}</li>)",
            "the item pattern has a nested pattern",
        ),
        (
            "rows.map(([a, [b]]: any) => <li key={a}>{b}</li>)",
            "the item pattern has a nested pattern",
        ),
        (
            "rows.map(({ a, ...o }: any) => <li key={a}>{o.b}</li>)",
            "the item pattern has a rest element",
        ),
        (
            "rows.map(([a, ...o]: any) => <li key={a}>{o}</li>)",
            "the item pattern has a rest element",
        ),
        (
            "rows.map(({ [title]: a }: any) => <li key={a}>{a}</li>)",
            "the item pattern has a computed key",
        ),
        (
            "rows.map(({ a }: any = {}) => <li key={a}>{a}</li>)",
            "the item parameter has a default value",
        ),
        (
            "rows.map((r: any, [i]: any) => <li key={i}>{r}</li>)",
            "the index parameter is a pattern",
        ),
        (
            "rows.map((r: any) => { const e = <b>{r.a}</b>; return <li key={r.id}>{e}</li> })",
            "the row const `e` holds JSX",
        ),
        (
            "rows.map((r: any) => { const v = useMemo(() => r.a, [r]); return <li key={r.id}>{v}</li> })",
            "the row const `v` calls a hook",
        ),
        (
            "rows.map((r: any) => { let t = r.a; return <li key={r.id}>{t}</li> })",
            "the row binding `t` is declared with `let`",
        ),
        (
            "rows.map((r: any) => { var t = r.a; return <li key={r.id}>{t}</li> })",
            "the row binding `t` is declared with `var`",
        ),
        (
            "rows.map((r: any) => { const { a } = r; return <li key={r.id}>{a}</li> })",
            "a row `const` is a pattern",
        ),
        (
            "rows.map((r: any) => { const a = r.a, b = r.b; return <li key={r.id}>{a}{b}</li> })",
            "declares several names",
        ),
        (
            "rows.map((r: any) => { if (r.x) return <i key={r.id}>x</i>; return <li key={r.id}>{r.a}</li> })",
            "an early return other than `if (cond) return null;`",
        ),
        (
            "rows.map((r: any) => { if (r.x) { return null } else { console.log(r) } return <li key={r.id}>{r.a}</li> })",
            "an early return other than",
        ),
        (
            "rows.map((r: any) => { if (r.x) return null; else return <i key={r.id}>x</i>; })",
            "a block body does not end with `return <jsx>`",
        ),
        (
            "rows.map((r: any) => { console.log(r); return <li key={r.id}>{r.a}</li> })",
            "a row statement other than",
        ),
        (
            "rows.map((r: any) => { const a = b + 1; const b = r.a; return <li key={r.id}>{a}</li> })",
            "reads `b`, declared after it",
        ),
    ] {
        refused(&page(row), why);
    }
}

#[test]
fn a_nested_list_that_hides_a_name_a_row_const_reads_refuses() {
    // D4 (c): `t` stands for `r.a`; inside the nested list `r` is the inner item.
    refused(
        &page(
            "rows.map((r: any) => { const t = r.a; return <li key={r.id}>{r.kids.map((r: any) => <b key={r}>{t}</b>)}</li> })",
        ),
        "the row const `t` is read inside a nested list whose `r` hides the `r` its value reads",
    );
    // the index too
    refused(
        &page(
            "rows.map((r: any, i: number) => { const t = i * 2; return <li key={r.id}>{r.kids.map((k: any, i: number) => <b key={k}>{t}</b>)}</li> })",
        ),
        "whose `i` hides the `i`",
    );
    // a nested list that hides nothing the const reads is fine
    accepted(
        &page(
            "rows.map((r: any) => { const t = r.a; return <li key={r.id}>{r.kids.map((k: any) => <b key={k}>{t}{k}</b>)}</li> })",
        ),
        Tier::Static,
    );
}

#[test]
fn printed_code_that_declares_a_name_a_row_const_reads_refuses() {
    // D4 (d): the handler declares `r`, and `t` prints as `(r.a)`.
    let src = "import { useState } from 'react'\nexport default function L({ rows }: any) { const [n, setN] = useState(0); return <ul>{rows.map((r: any) => { const t = r.a; return <li key={r.id} onClick={() => { const r = 1; setN(t + r) }}>{n}</li> })}</ul> }";
    refused(
        src,
        "the row const `t` is read in code that declares `r`, a name its value reads",
    );
    // a structured callback parameter too
    refused(
        &page(
            "rows.map((r: any) => { const t = r.a; return <li key={r.id}>{r.kids.filter((r: any) => r === t).length}</li> })",
        ),
        "declares `r`",
    );
}

#[test]
fn the_generated_item_name_avoids_a_taken_name() {
    let j = lower("export default function L({ _row1 }: any) { return <ul>{_row1.map(({ a }: any) => <li key={a}>{a}</li>)}</ul> }").jinja;
    assert!(j.contains("{% for _row2 in _row1 %}"), "{j}");
    // nested destructured lists get distinct names
    let j = lower(&page("rows.map(({ id, kids }: any) => <li key={id}>{kids.map(({ k }: any) => <b key={k}>{k}{id}</b>)}</li>)")).jinja;
    assert!(j.contains("{% for _row1 in rows %}"), "{j}");
    assert!(j.contains("{% for _row2 in _row1.kids %}"), "{j}");
    assert!(j.contains("{{ _row2.k | e }}{{ _row1.id | e }}"), "{j}");
}

// ---- lowering: the server job and the template ----

#[test]
fn array_pattern_over_tuples() {
    let j = lower("export default function L({ rows }: any) { return <ul>{rows.map(([k, , v]: any) => <li key={k}>{k}={v}</li>)}</ul> }").jinja;
    assert!(
        j.contains("<ul>{% for _row1 in rows %}<li>{{ _row1[0] | e }}={{ _row1[2] | e }}</li>{% endfor %}</ul>"),
        "{j}"
    );
}

#[test]
fn object_pattern_with_a_rename() {
    let j = lower("export default function L({ rows }: any) { return <ul>{rows.map(({ id, name: n }: any) => <li key={id} title={n}>{n}</li>)}</ul> }").jinja;
    assert!(
        j.contains("<ul>{% for _row1 in rows %}<li{% if _row1.name | present_plain %} title=\"{{ _row1.name | attr_str | e }}\"{% endif %}>{{ _row1.name | e }}</li>{% endfor %}</ul>"),
        "{j}"
    );
}

#[test]
fn a_call_free_const_is_its_expression_where_read() {
    let a = lower(
        "export default function L({ rows }: any) { return <ul>{rows.map((r: any) => { const t = r.a + 1; const u = t * 2; return <li key={r.id}>{t}/{u}</li> })}</ul> }",
    );
    assert!(a.server_ts.is_none(), "{:?}", a.server_ts);
    assert!(
        a.jinja.contains(
            "<li>{{ (r.a | js_add(1)) | e }}/{{ ((r.a | js_add(1)) | js_mul(2)) | e }}</li>"
        ),
        "{}",
        a.jinja
    );
}

#[test]
fn a_helper_const_read_twice_is_two_slots_calling_it() {
    // D6: no slot merging; each read is its own slot with the initialiser inlined.
    let a = lower(
        "import { fmt } from './money'\nexport default function L({ rows }: any) { return <ul>{rows.map((r: any) => { const p = fmt(r.price); return <li key={r.id} title={p}>{p}</li> })}</ul> }",
    );
    let job = a.server_ts.unwrap();
    assert!(
        job.contains(
            "return { _s1: (rows).map((r) => fmt(r.price)), _s2: (rows).map((r) => fmt(r.price)) }"
        ),
        "{job}"
    );
    assert!(
        a.jinja.contains("title=\"{{ _s1[_i1] | attr_str | e }}\""),
        "{}",
        a.jinja
    );
    assert!(a.jinja.contains(">{{ _s2[_i1] | e }}</li>"), "{}", a.jinja);
}

#[test]
fn an_early_return_null_is_the_conditional_arm() {
    let early = lower("export default function L({ rows }: any) { return <ul>{rows.map((r: any) => { if (!r.on) return null; return <li key={r.id}>{r.a}</li> })}</ul> }").jinja;
    let ternary = lower("export default function L({ rows }: any) { return <ul>{rows.map((r: any) => !r.on ? null : <li key={r.id}>{r.a}</li>)}</ul> }").jinja;
    assert_eq!(early, ternary);
    assert!(
        early.contains("{% for r in rows %}{% if (not (r.on | truthy)) %}{% else %}<li>{{ r.a | e }}</li>{% endif %}{% endfor %}"),
        "{early}"
    );
    // two early returns: either condition renders nothing
    let two = lower("export default function L({ rows }: any) { return <ul>{rows.map((r: any) => { if (!r.on) return null; if (r.hide) return null; return <li key={r.id}>{r.a}</li> })}</ul> }").jinja;
    assert!(
        two.contains(
            "{% if (not (r.on | truthy)) %}{% else %}{% if (r.hide) | truthy %}{% else %}<li>"
        ),
        "{two}"
    );
}
