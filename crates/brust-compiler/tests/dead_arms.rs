//! F297: the server renders every state cell at its `useState` initial value, so a condition whose test is such a cell
//! (or a literal) is decided there. The arm it never takes on the server is dropped before placement asks whether the
//! value is in the template subset: `control ? control.closest('form') : true` with `useState(null)` prints `true`
//! instead of becoming a precompute job. The client keeps the whole expression.
mod lower_common;
use lower_common::lower;

const R: &str = "import { useState } from 'react'\n";

/// Radix's `isFormControl` (Switch/Checkbox Provider): the method call sits in the arm the server never takes.
const FORM_CONTROL: &str = "export default function T({ form }: any) { const [control, setControl] = useState<HTMLButtonElement | null>(null); const isFormControl = control ? !!form || !!control.closest('form') : true; return <button ref={setControl} data-f={isFormControl ? 'y' : 'n'}>b</button> }";

#[test]
fn a_dead_arm_on_a_literal_state_init_needs_no_job() {
    let a = lower(&format!("{R}{FORM_CONTROL}"));
    assert!(
        a.server_ts.is_none(),
        "no precompute job: {:?}",
        a.server_ts
    );
    // The server takes the `else` arm; the test still reads the state.
    assert!(a.jinja.contains("control"), "{}", a.jinja);
    assert!(!a.jinja.contains("closest"), "{}", a.jinja);
    // The client keeps the live expression and re-evaluates it once `control` is set.
    let c = a.client_js.unwrap();
    assert!(c.contains("closest(\"form\")"), "{c}");
    assert!(c.contains("control()"), "{c}");
}

#[test]
fn logical_operators_drop_the_right_side_the_server_never_reads() {
    for body in [
        // `&&` on a falsy init.
        "const [el, setEl] = useState<HTMLElement | null>(null); const v = el && el.getAttribute('id'); return <b ref={setEl} data-v={v}>x</b>",
        // `||` on a truthy init.
        "const [on, setOn] = useState(true); const v = on || JSON.stringify(on); return <b onClick={() => setOn(!on)} data-v={v ? 'a' : 'b'}>x</b>",
        // `??` on a non-nullish init, and `!` of a state test.
        "const [n, setN] = useState(0); const [el] = useState(null); const v = !el ? n ?? Number(el.id) : el.id.at(0); return <b onClick={() => setN(n + 1)}>{v}</b>",
    ] {
        let a = lower(&format!("{R}export default function T() {{ {body} }}"));
        assert!(a.server_ts.is_none(), "{body}: {:?}", a.server_ts);
    }
}

#[test]
fn a_live_arm_or_an_unknown_init_keeps_the_job() {
    for body in [
        // The arm the server takes is the one outside the subset.
        "const [n, setN] = useState(null); const v = n ? 'x' : JSON.stringify(label); return <b onClick={() => setN(1 as any)}>{v}</b>",
        // A state seeded from a prop is not a literal on the server.
        "const [c, setC] = useState(label); const v = c ? JSON.stringify(c) : 'none'; return <b onClick={() => setC('')}>{v}</b>",
        // An object init is not a literal either.
        "const [c, setC] = useState({}); const v = c ? JSON.stringify(label) : 'none'; return <b onClick={() => setC({})}>{v}</b>",
    ] {
        let a = lower(&format!(
            "{R}export default function T({{ label }}: any) {{ {body} }}"
        ));
        assert!(a.server_ts.is_some(), "{body}: still a job\n{}", a.jinja);
    }
}

#[test]
fn a_painted_condition_keeps_both_arms_for_the_client() {
    // The client binds a painted value from its placed expression: dropping the arm there would freeze `on` out.
    let a = lower(&format!(
        "{R}export default function T() {{ const [on, setOn] = useState(false); return <button onClick={{() => setOn(!on)}}>{{on ? 'on' : 'off'}}</button> }}"
    ));
    let c = a.client_js.unwrap();
    assert!(c.contains("\"on\"") && c.contains("\"off\""), "{c}");
}
