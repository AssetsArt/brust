//! F511: a reactive `if / else if / … / else` run (a `switch` with a return per case, an early-return chain, nested
//! ternaries in the else position) lowers to sibling branches, each printed once: the template and the work grow
//! linearly with the run. Before, each else nested the rest of the run inside both the visible and the hidden copy of the
//! previous arm (2^n: a 38-case store-driven switch never finished building). Nesting that still doubles (a reactive
//! conditional inside an arm, a reactive list row) is held to a work budget (`TWICE_BUDGET`, bytes of visible + hidden
//! copies per component): past it the build stops with `reactive-if-depth` instead of printing 2^depth copies.
//! F515: a test on a row of a fixed list (a module const) is server-decided, so a run can start or end with one: the
//! prefix stays a plain server `if`, a later one is the run's trailing else. Served: tests/server/if-chain.chromium.test.ts.
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

/// A stateful page (tests/fixtures/guarded-slot/money.ts for `fmt`) that renders `chain` once per row of its `items`
/// prop. The page has state, so its props reach the client (`x-props`) and the rows are an `x-for`: a test on the row
/// (`it.sale`) is reactive like the test on the state `n`, and joins the same run.
fn rows_page(chain: &str, n: i64) -> Page {
    let src = format!(
        "import {{ useState }} from 'react'\nimport {{ fmt }} from './money'\n\
         export default function F(props: {{ items: {{ id: string; sale: boolean; price: number }}[] }}) {{\n\
         const [n, setN] = useState({n})\n\
         return <div><button onClick={{() => setN(n + 1)}}>+</button>\
         <ul>{{props.items.map((it) => <li key={{it.id}}>{{{chain}}}</li>)}}</ul></div> }}"
    );
    let s = src.clone();
    let p = run_on_compiler_thread(move || {
        compile_tree(
            "tests/fixtures/guarded-slot/F.tsx",
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
    // The rows are a client list, so the row test is a member of the run (`x-if="_cN:it"`), not a plain server `if`.
    assert!(p.jinja.contains("<li x-for="), "{}", p.jinja);
    assert!(
        !p.jinja.contains("{% if (it.sale) | truthy %}<"),
        "{}",
        p.jinja
    );
    p
}

/// Per `<li>` row: (the arms a user sees as `tag:text`, how many arms the row holds).
fn rows(html: &str) -> Vec<(Vec<String>, usize)> {
    html.split("<li")
        .skip(1)
        .map(|row| {
            let row = &row[..row.find("</li>").unwrap()];
            let arms = ["<b ", "<b>", "<em ", "<em>"]
                .iter()
                .map(|t| row.matches(t).count())
                .sum();
            let mut seen: Vec<String> = visible(row, "b")
                .into_iter()
                .map(|t| format!("b:{t}"))
                .collect();
            seen.extend(visible(row, "em").into_iter().map(|_| "em".to_string()));
            (seen, arms)
        })
        .collect()
}

fn items() -> serde_json::Value {
    serde_json::json!({ "items": [
        { "id": "a", "sale": true, "price": 2 },
        { "id": "b", "sale": false, "price": 3 },
    ] })
}

#[test]
fn a_row_test_first_in_the_chain_joins_the_run() {
    let p = rows_page(
        "it.sale ? <em>{fmt(it.price)}</em> : n === 0 ? <b>0</b> : n === 1 ? <b>1</b> : <b>z</b>",
        1,
    );
    // One flat run of 4 arms in every row (linear): row `a` (on sale) shows the price, row `b` the state arm `1`.
    let html = render(&p.jinja, items());
    assert_eq!(
        rows(&html),
        vec![(vec!["em".to_string()], 4), (vec!["b:1".to_string()], 4)],
        "{html}\n{}",
        p.jinja
    );
    assert!(p.jinja.contains("<em x-if=\"_c1:it\">"), "{}", p.jinja);
}

#[test]
fn a_row_test_after_the_state_tests_joins_the_run() {
    let chain =
        "n === 0 ? <b>0</b> : n === 1 ? <b>1</b> : it.sale ? <em>{fmt(it.price)}</em> : <b>z</b>";
    // No state test holds: the row test picks the price in row `a`, the trailing else `z` in row `b`.
    let p = rows_page(chain, 5);
    let html = render(&p.jinja, items());
    assert_eq!(
        rows(&html),
        vec![(vec!["em".to_string()], 4), (vec!["b:z".to_string()], 4)],
        "{html}\n{}",
        p.jinja
    );
    // An earlier state test wins over the row test, as in JS.
    let p = rows_page(chain, 0);
    let html = render(&p.jinja, items());
    assert_eq!(
        rows(&html),
        vec![(vec!["b:0".to_string()], 4), (vec!["b:0".to_string()], 4)],
        "{html}\n{}",
        p.jinja
    );
}

/// A store-reading page (tests/fixtures/store-read/cart.ts) rendering `chain` in each row of a module const: the row
/// value `m` never changes on the client (F515), the store does.
fn fixed_rows(chain: &str) -> Page {
    let src = format!(
        "import {{ useStore }} from 'brust/store/react'\nimport {{ cart }} from './cart'\n\
         const MODES = ['x', 'y']\n\
         export default function F() {{ const s = useStore(cart)\n\
         return <main>{{MODES.map((m) => <p key={{m}} data-c={{s.count}}>{{{chain}}}</p>)}}</main> }}"
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
    // The row test is a plain server `if` (no `x-if=\"_cN:m\"` member of `m`).
    assert!(!p.jinja.contains(":m\""), "{}", p.jinja);
    p
}

/// Per `<p>` row: (the `<b>` texts a user sees, how many `<b>` the row holds).
fn p_rows(html: &str) -> Vec<(Vec<String>, usize)> {
    html.split("<p ")
        .skip(1)
        .map(|row| {
            let row = &row[..row.find("</p>").unwrap()];
            (
                visible(row, "b"),
                row.matches("<b ").count() + row.matches("<b>").count(),
            )
        })
        .collect()
}

fn count(n: i64) -> serde_json::Value {
    serde_json::json!({ "__store": { "cart": { "count": n } } })
}

#[test]
fn a_fixed_row_test_before_the_run_stays_a_plain_if() {
    let p = fixed_rows(
        "m === 'x' ? <b>x</b> : s.count === 0 ? <b>0</b> : s.count === 1 ? <b>1</b> : <b>z</b>",
    );
    // Row `x`: the prefix holds on the server, nothing of the run is printed. Row `y`: the run, each arm once.
    let html = render(&p.jinja, count(1));
    assert_eq!(
        p_rows(&html),
        vec![(vec!["x".to_string()], 1), (vec!["1".to_string()], 3)],
        "{html}\n{}",
        p.jinja
    );
    assert_eq!(p_rows(&render(&p.jinja, count(7)))[1].0, vec!["z"]);
    // Only the run's 3 arms have members, each once visible + once hidden.
    assert_eq!(p.jinja.matches("x-if=").count(), 6, "{}", p.jinja);
}

#[test]
fn a_fixed_row_test_after_the_run_is_its_trailing_else() {
    let p = fixed_rows(
        "s.count === 0 ? <b>0</b> : s.count === 1 ? <b>1</b> : m === 'x' ? <b>x</b> : <b>z</b>",
    );
    // The trailing else holds the server-decided test: `x` in row `x`, `z` in row `y`, one of them per row.
    let html = render(&p.jinja, count(5));
    assert_eq!(
        p_rows(&html),
        vec![(vec!["x".to_string()], 3), (vec!["z".to_string()], 3)],
        "{html}\n{}",
        p.jinja
    );
    let html = render(&p.jinja, count(0));
    assert_eq!(p_rows(&html)[0].0, vec!["0"], "{html}");
    assert_eq!(p_rows(&html)[1].0, vec!["0"], "{html}");
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
