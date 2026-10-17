//! F383: an object literal's computed key that is itself a literal (`['--x']`, `` [`--x`] `` with no substitution, `[1]`)
//! is the same key as the written one. Radix CollapsibleContent's `style={{ [`--radix-...-height` as any]: ..., ...props.style }}`
//! was a per-request job over the whole props, so a wrapper spreading into it was refused as spread-fed (F164). A key
//! with a substitution, or a computed `__proto__` (an own property, unlike the written one), keeps today's reading.
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::ir::*;
use brust_compiler::lower::DEFAULT_RUNTIME_IMPORT;
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use std::path::PathBuf;

/// Per compiled component: (id, tier, job count, diagnostic rules).
type Row = (String, Tier, usize, Vec<String>);

fn tree(path: &str, src: Option<&str>) -> Vec<Row> {
    let (path, src) = (path.to_string(), src.map(|s| s.as_bytes().to_vec()));
    run_on_compiler_thread(move || {
        compile_tree(
            &path,
            src,
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap()
        .iter()
        .map(|l| {
            (
                l.ir.id.clone(),
                l.ir.tier.clone(),
                l.ir.jobs.len(),
                l.ir.diagnostics.iter().map(|d| d.rule.clone()).collect(),
            )
        })
        .collect()
    })
}

fn one(style: &str) -> Row {
    let src = format!(
        "import {{ useState }} from 'react'\nexport default function C(props: any) {{ const [h, setH] = useState(1); return <div onClick={{() => setH(h + 5)}} style={{{style}}}>x</div> }}"
    );
    tree("crates/brust-compiler/tests/fixtures/S.tsx", Some(&src)).remove(0)
}

#[test]
fn literal_computed_keys_are_plain_keys() {
    for style in [
        "{ ['--a' as any]: h ? h + 'px' : undefined }",
        "{ [`--a`]: h ? `${h}px` : undefined }",
        "{ [`--a` as any]: h ? `${h}px` : undefined, ['--b' as any]: 'x', ...props.style }",
        "{ [1]: h }",
    ] {
        let (_, tier, jobs, _) = one(style);
        assert_eq!(jobs, 0, "{style}");
        assert!(matches!(tier, Tier::Native), "{style}: {tier:?}");
    }
}

#[test]
fn other_computed_keys_keep_todays_reading() {
    for style in ["{ [`--a${h}`]: 1 }", "{ ['__proto__']: { color: 'red' } }"] {
        let (_, _, jobs, _) = one(style);
        assert!(jobs > 0, "{style}: still a per-request value");
    }
}

#[test]
fn a_wrapper_spreading_into_the_styled_child_is_no_longer_spread_fed() {
    let t = tree(
        "packages/brust/test/fixtures/style-keys/StylePage.tsx",
        None,
    );
    for (id, tier, _, rules) in &t {
        assert!(
            matches!(tier, Tier::Static | Tier::Native),
            "{id}: {tier:?}"
        );
        assert!(
            !rules.iter().any(|r| r == "spread-props"),
            "{id}: {rules:?}"
        );
    }
}
