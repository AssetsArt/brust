//! F511: a reactive `if / else if / … / else` run (a `switch` with a return per case, an early-return chain, nested
//! ternaries in the else position) lowers to sibling branches, each printed once: the template and the work grow
//! linearly with the run. Before, each else nested the rest of the run inside both the visible and the hidden copy of the
//! previous arm (2^n: a 38-case store-driven switch never finished building). Nesting that still doubles (a reactive
//! conditional inside an arm, a reactive list row) stops the build past `REACTIVE_DEPTH_CAP` levels with
//! `reactive-if-depth` instead of printing 2^depth copies. Served: tests/server/if-chain.chromium.test.ts.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::{Diagnostic, Tier};
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;
use std::time::{Duration, Instant};

struct Page {
    tier: Tier,
    jinja: String,
    client: String,
}

fn compile(src: &str) -> Result<Page, Diagnostic> {
    let s = src.to_string();
    run_on_compiler_thread(move || {
        let tree = compile_tree(
            "crates/brust-compiler/tests/fixtures/F.tsx",
            Some(s.into_bytes()),
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )?;
        Ok(Page {
            tier: tree[0].ir.tier.clone(),
            jinja: tree[0].artifacts.jinja.clone(),
            client: tree[0].artifacts.client_js.clone().unwrap_or_default(),
        })
    })
}

fn render(jinja: &str, props: serde_json::Value) -> String {
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    let mut ctx = props;
    ctx["_props"] = serde_json::json!({});
    env.render_str(jinja, brust_jinja::value_of(ctx)).unwrap()
}

/// A state-driven chain of `n` arms (`k === 'a0' ? <i>0</i> : k === 'a1' ? … : <i>z</i>`).
fn ternary_chain(n: usize) -> String {
    let mut chain = String::from("<i>z</i>");
    for i in (0..n).rev() {
        chain = format!("k === 'a{i}' ? <i>{i}</i> : {chain}");
    }
    format!(
        "import {{ useState }} from 'react'\nexport default function F() {{ const [k, setK] = useState('a1'); \
         return <main onClick={{() => setK('a2')}}>{{{chain}}}</main> }}"
    )
}

/// A state-driven `switch` of `n` cases, each returning its own element.
fn switch_of(n: usize) -> String {
    let cases: String = (0..n)
        .map(|i| {
            format!(
                "case 'a{i}': return <b onClick={{() => setK('a{}')}}>{i}</b>\n",
                (i + 1) % n
            )
        })
        .collect();
    format!(
        "import {{ useState }} from 'react'\nexport default function F() {{ const [k, setK] = useState('a1')\n\
         switch (k) {{\n{cases}default: return <b onClick={{() => setK('a0')}}>z</b>\n}}\n}}"
    )
}

fn visible(html: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}");
    html.split(&open)
        .skip(1)
        .filter(|rest| rest.starts_with([' ', '>']))
        .filter(|rest| {
            let attrs = &rest[..rest.find('>').unwrap()];
            !attrs.split(' ').any(|a| a == "hidden")
        })
        .map(|rest| {
            let body = &rest[rest.find('>').unwrap() + 1..];
            body[..body.find('<').unwrap()].to_string()
        })
        .collect()
}

#[test]
fn a_long_reactive_chain_lowers_linearly() {
    for build in [ternary_chain as fn(usize) -> String, switch_of] {
        let t = Instant::now();
        let p40 = compile(&build(40)).unwrap();
        assert!(
            t.elapsed() < Duration::from_secs(1),
            "40 arms took {:?}",
            t.elapsed()
        );
        assert!(matches!(p40.tier, Tier::Native), "{:?}", p40.tier);
        let p20 = compile(&build(20)).unwrap();
        let ratio = p40.jinja.len() as f64 / p20.jinja.len() as f64;
        assert!(
            ratio < 2.5,
            "size(40) / size(20) = {ratio} ({} / {})",
            p40.jinja.len(),
            p20.jinja.len()
        );
        // Each of the 41 arms is in the template twice (visible + hidden copy), never more.
        assert_eq!(p40.jinja.matches("x-if=").count(), 2 * 41, "{}", p40.jinja);
    }
}

#[test]
fn a_three_arm_chain_shows_one_arm_with_stable_members() {
    let p = compile(&switch_of(3)).unwrap();
    assert!(matches!(p.tier, Tier::Native), "{:?}", p.tier);
    let html = render(&p.jinja, serde_json::json!({}));
    // useState('a1'): the second case shows, every other arm is in the DOM hidden, none twice.
    assert_eq!(visible(&html, "b"), vec!["1"], "{html}");
    assert_eq!(html.matches("<b ").count(), 4, "{html}");
    // The visible and the hidden copy of an arm carry the same member; each arm its own.
    let mut members: Vec<&str> = p
        .jinja
        .split("x-if=\"")
        .skip(1)
        .map(|r| &r[..r.find('"').unwrap()])
        .collect();
    assert_eq!(members.len(), 8, "{}", p.jinja);
    members.dedup();
    assert_eq!(members.len(), 4, "{}", p.jinja);
    for m in &members {
        assert!(
            p.client.contains(&format!("const {m} =")),
            "{m} not in the chunk:\n{}",
            p.client
        );
    }
    // Arm i is guarded by every earlier test negated (the default by all of them).
    let last = members[3];
    let guard = p.client.split(&format!("const {last} =")).nth(1).unwrap();
    let guard = &guard[..guard.find('\n').unwrap_or(guard.len())];
    assert_eq!(guard.matches('!').count(), 3, "{guard}");
}

/// A page reading `cart.count` (tests/fixtures/store-read/cart.ts) that renders `chain` once per row of a module-constant
/// list: the row variable `m` is fixed for the life of the page (the list never changes), so a test on it is decided on
/// the server alone, a test on the store is reactive.
fn store_rows(chain: &str) -> Page {
    let src = format!(
        "import {{ useStore }} from 'brust/store/react'\nimport {{ cart }} from './cart'\n\
         const MODES = ['x', 'y']\n\
         export default function F() {{ const s = useStore(cart)\n\
         return <main>{{MODES.map((m) => <p key={{m}}>{{{chain}}}</p>)}}</main> }}"
    );
    let s = src.clone();
    let p = run_on_compiler_thread(move || {
        compile_tree(
            "tests/fixtures/store-read/F.tsx",
            Some(s.into_bytes()),
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .map(|tree| Page {
            tier: tree[0].ir.tier.clone(),
            jinja: tree[0].artifacts.jinja.clone(),
            client: tree[0].artifacts.client_js.clone().unwrap_or_default(),
        })
    })
    .unwrap();
    assert!(matches!(p.tier, Tier::Native), "{:?}\n{src}", p.tier);
    p
}

/// Per `<p>` row: (the `<b>` texts a user sees, how many `<b>` arms the row holds).
fn rows(html: &str) -> Vec<(Vec<String>, usize)> {
    html.split("<p")
        .skip(1)
        .map(|row| {
            let row = &row[..row.find("</p>").unwrap()];
            let arms = row.matches("<b ").count() + row.matches("<b>").count();
            (visible(row, "b"), arms)
        })
        .collect()
}

fn count(n: i64) -> serde_json::Value {
    serde_json::json!({ "__store": { "cart": { "count": n } } })
}

#[test]
fn a_non_reactive_prefix_keeps_its_plain_if() {
    let p = store_rows(
        "m === 'x' ? <b>x</b> : s.count === 0 ? <b>0</b> : s.count === 1 ? <b>1</b> : <b>z</b>",
    );
    // Row `x`: the prefix holds on the server, nothing of the run is printed. Row `y`: the run, every arm once.
    let html = render(&p.jinja, count(1));
    assert_eq!(
        rows(&html),
        vec![(vec!["x".to_string()], 1), (vec!["1".to_string()], 3)],
        "{html}\n{}",
        p.jinja
    );
    let html = render(&p.jinja, count(7));
    assert_eq!(rows(&html)[1].0, vec!["z"], "{html}");
    // The run's 3 arms, each once visible + once hidden; the prefix arm has no member.
    assert_eq!(p.jinja.matches("x-if=").count(), 6, "{}", p.jinja);
}

#[test]
fn a_non_reactive_test_after_the_run_is_its_trailing_else() {
    let p = store_rows(
        "s.count === 0 ? <b>0</b> : s.count === 1 ? <b>1</b> : m === 'x' ? <b>x</b> : <b>z</b>",
    );
    let html = render(&p.jinja, count(5));
    // The trailing else holds the server-decided test: `x` in row `x`, `z` in row `y`, one arm each.
    assert_eq!(
        rows(&html),
        vec![(vec!["x".to_string()], 3), (vec!["z".to_string()], 3)],
        "{html}\n{}",
        p.jinja
    );
    let html = render(&p.jinja, count(0));
    assert_eq!(rows(&html)[0].0, vec!["0"], "{html}");
    assert_eq!(rows(&html)[1].0, vec!["0"], "{html}");
    // Two reactive arms + the trailing else, each once visible + once hidden.
    assert_eq!(p.jinja.matches("x-if=").count(), 6, "{}", p.jinja);
}

/// `depth` state conditionals, each in the previous one's `then`: no run to flatten, every level doubles.
fn nested(depth: usize) -> String {
    let mut body = String::from("<i>in</i>");
    for i in (0..depth).rev() {
        body = format!("<p>{{k > {i} ? {body} : <i>out{i}</i>}}</p>");
    }
    format!(
        "import {{ useState }} from 'react'\nexport default function F() {{ const [k, setK] = useState(0); \
         return <main onClick={{() => setK(k + 1)}}>{body}</main> }}"
    )
}

#[test]
fn nesting_past_the_work_budget_stops_the_build_with_the_reason() {
    let t = Instant::now();
    let err = compile(&nested(30))
        .err()
        .expect("past the budget the build stops");
    assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
    assert_eq!(err.rule, "reactive-if-depth", "{err:?}");
    assert!(
        err.message.contains("`f_"),
        "names the component: {}",
        err.message
    );
    assert!(err.message.contains("MiB"), "{}", err.message);
    assert!(
        err.file.as_deref().is_some_and(|f| f.ends_with("F.tsx")),
        "{err:?}"
    );
}

#[test]
fn depth_alone_is_not_the_budget() {
    // Ten levels of small arms (2^10 copies of a few bytes) build as they did before the budget.
    let p = compile(&nested(10)).unwrap();
    assert!(matches!(p.tier, Tier::Native), "{:?}", p.tier);
}
