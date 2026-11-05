//! F515: the rows of a list whose source never changes on the client (a module const nothing writes, a literal, a fixed
//! prop, a row of such a list) are the server's for good. A read of their bindings with nothing else reactive in it is
//! decided on the server: a conditional on a row value prints only its matching arm per row, even when the row is an
//! `x-for` row for another read (`s.count` below). A list over state, a module `let` that is reassigned or a const that
//! is written stays a client list whose row conditionals print both copies. Served: tests/server/if-chain.chromium.test.ts (38 cases × 36 rows of a module const).
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::Tier;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

struct Page {
    jinja: String,
}

/// `body` compiled as a page in tests/fixtures/store-read (`cart` from its cart.ts), native.
fn page(body: &str) -> Page {
    let src = format!(
        "import {{ useState }} from 'react'\nimport {{ useStore }} from 'brust/store/react'\nimport {{ cart }} from './cart'\n{body}"
    );
    let s = src.clone();
    let (tier, jinja) = run_on_compiler_thread(move || {
        let tree = compile_tree(
            "tests/fixtures/store-read/F.tsx",
            Some(s.into_bytes()),
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap();
        (tree[0].ir.tier.clone(), tree[0].artifacts.jinja.clone())
    });
    assert!(matches!(tier, Tier::Native), "{tier:?}\n{src}");
    Page { jinja }
}

fn render(jinja: &str, count: i64) -> String {
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    let ctx = serde_json::json!({ "_props": {}, "__store": { "cart": { "count": count } } });
    env.render_str(jinja, brust_jinja::value_of(ctx)).unwrap()
}

/// The `<b>` texts of each `<a>` row: (visible ones, every `<b>` the row holds).
fn rows(html: &str) -> Vec<(Vec<String>, usize)> {
    html.split("<a ")
        .skip(1)
        .map(|row| {
            let row = &row[..row.find("</a>").unwrap()];
            let all: Vec<&str> = row
                .split("<b")
                .skip(1)
                .filter(|r| r.starts_with([' ', '>']))
                .collect();
            let seen = all
                .iter()
                .filter(|r| !r[..r.find('>').unwrap()].split(' ').any(|a| a == "hidden"))
                .map(|r| {
                    let body = &r[r.find('>').unwrap() + 1..];
                    body[..body.find('<').unwrap()].to_string()
                })
                .collect();
            (seen, all.len())
        })
        .collect()
}

const ROW: &str = "<a key={it.key} data-on={s.count > 0 && it.key === 'k1' ? '1' : '0'}>\
                   {it.key === 'k0' ? <b>0</b> : it.key === 'k1' ? <b>1</b> : <b>z</b>}</a>";

fn one_arm_per_row(p: &Page) {
    // The row is still a client row (it reads the store), but its conditional is the server's.
    assert!(p.jinja.contains("x-for="), "{}", p.jinja);
    assert!(!p.jinja.contains("x-if="), "{}", p.jinja);
    let html = render(&p.jinja, 1);
    assert_eq!(
        rows(&html),
        vec![
            (vec!["0".into()], 1),
            (vec!["1".into()], 1),
            (vec!["z".into()], 1)
        ],
        "{html}\n{}",
        p.jinja
    );
}

fn both_copies(p: &Page) {
    assert!(p.jinja.contains("x-if=\"_c"), "{}", p.jinja);
}

#[test]
fn rows_of_a_module_const_print_one_arm_each() {
    one_arm_per_row(&page(&format!(
        "const ITEMS = [{{ key: 'k0' }}, {{ key: 'k1' }}, {{ key: 'k2' }}]\n\
         export default function F() {{ const s = useStore(cart)\n\
         return <nav>{{ITEMS.map((it) => {ROW})}}</nav> }}"
    )));
}

#[test]
fn rows_of_a_literal_print_one_arm_each() {
    one_arm_per_row(&page(&format!(
        "export default function F() {{ const s = useStore(cart)\n\
         return <nav>{{[{{ key: 'k0' }}, {{ key: 'k1' }}, {{ key: 'k2' }}].map((it) => {ROW})}}</nav> }}"
    )));
}

#[test]
fn rows_of_rows_of_a_module_const_print_one_arm_each() {
    one_arm_per_row(&page(&format!(
        "const GROUPS = [{{ name: 'g0', items: [{{ key: 'k0' }}, {{ key: 'k1' }}] }}, {{ name: 'g1', items: [{{ key: 'k2' }}] }}]\n\
         export default function F() {{ const s = useStore(cart)\n\
         return <nav>{{GROUPS.map((g) => <section key={{g.name}}>{{g.items.map((it) => {ROW})}}</section>)}}</nav> }}"
    )));
}

#[test]
fn rows_of_state_stay_client_rows() {
    both_copies(&page(&format!(
        "const ITEMS = [{{ key: 'k0' }}, {{ key: 'k1' }}, {{ key: 'k2' }}]\n\
         export default function F() {{ const s = useStore(cart); const [xs, setXs] = useState(ITEMS)\n\
         return <nav><button onClick={{() => setXs([])}}>clear</button>{{xs.map((it) => {ROW})}}</nav> }}"
    )));
}

#[test]
fn rows_of_a_reassigned_module_let_stay_client_rows() {
    both_copies(&page(&format!(
        "let ITEMS = [{{ key: 'k0' }}, {{ key: 'k1' }}, {{ key: 'k2' }}]\n\
         export function reset() {{ ITEMS = [] }}\n\
         export default function F() {{ const s = useStore(cart)\n\
         return <nav>{{ITEMS.map((it) => {ROW})}}</nav> }}"
    )));
}

#[test]
fn rows_of_a_written_module_const_stay_client_rows() {
    both_copies(&page(&format!(
        "const ITEMS = [{{ key: 'k0' }}, {{ key: 'k1' }}, {{ key: 'k2' }}]\n\
         export function add() {{ ITEMS.push({{ key: 'k3' }}) }}\n\
         export default function F() {{ const s = useStore(cart)\n\
         return <nav>{{ITEMS.map((it) => {ROW})}}</nav> }}"
    )));
}

#[test]
fn a_fixed_list_inside_a_client_row_stays_a_client_list() {
    // New outer rows are built on the client from the blank template, where nothing is server-decided.
    both_copies(&page(&format!(
        "const ITEMS = [{{ key: 'k0' }}, {{ key: 'k1' }}, {{ key: 'k2' }}]\n\
         export default function F() {{ const s = useStore(cart); const [gs, setGs] = useState(['g0'])\n\
         return <nav><button onClick={{() => setGs([...gs, 'g'])}}>add</button>\
         {{gs.map((g) => <section key={{g}}>{{ITEMS.map((it) => {ROW})}}</section>)}}</nav> }}"
    )));
}
