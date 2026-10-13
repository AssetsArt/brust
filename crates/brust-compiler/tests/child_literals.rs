//! F105: an inlined child with a precompute job gets constant props as `literals` and §6.2
//! expressions over the parent's props (and the row) as `exprs` the server evaluates.
use brust_compiler::analyze::component::{AnalyzeOptions, analyze_source};
use brust_compiler::ir::{ComponentIR, InstanceRecord, Tier};
use brust_compiler::parse::run_on_compiler_thread;
use serde_json::json;
use std::path::PathBuf;

const CHILD: &str = "export default function Code({ code, lang }: any) { return <pre data-lang={lang}>{code.split('\\n').filter((l: any) => l.length > 0).length}</pre> }";

fn analyze(parent: &str) -> ComponentIR {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("brust-chl-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("Code.tsx"), CHILD).unwrap();
    let path = dir.join("T.tsx").to_string_lossy().into_owned();
    let src = parent.to_string();
    run_on_compiler_thread(move || {
        analyze_source(
            &path,
            src.into_bytes(),
            &AnalyzeOptions {
                root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."),
                ..Default::default()
            },
        )
        .unwrap()
    })
}

fn instances(parent: &str) -> Vec<InstanceRecord> {
    let ir = analyze(parent);
    assert!(!matches!(ir.tier, Tier::React { .. }), "{:?}", ir.tier);
    ir.instances
}

#[test]
fn literal_props_are_recorded_per_instance() {
    let inst = instances(
        "import Code from './Code'\nexport default function T() { return <div><Code code=\"a\" lang=\"ts\" /><Code code={'b\\nc'} lang={`js`} /></div> }",
    );
    assert_eq!(inst.len(), 2, "{inst:?}");
    assert_eq!(inst[0].literals["code"], json!("a"));
    assert_eq!(inst[0].literals["lang"], json!("ts"));
    assert_eq!(inst[1].literals["code"], json!("b\nc"));
    assert_eq!(inst[1].literals["lang"], json!("js"));
    assert!(
        inst.iter()
            .all(|i| i.props.is_empty() && i.exprs.is_empty()),
        "{inst:?}"
    );
}

#[test]
fn expressions_over_props_and_the_row_are_recorded_as_jinja() {
    let inst = instances(
        "import Code from './Code'\nexport default function T({ src, files }: any) { return <div><Code code={`// ${src}`} lang=\"ts\" />{files.map((f: any, i: number) => <Code key={f.name} code={f.body.trim()} lang={f.lang ?? 'txt'} />)}</div> }",
    );
    assert_eq!(inst.len(), 2, "{inst:?}");
    assert_eq!(
        inst[0].exprs["code"],
        "(\"// \" ~ (__props.src | js_string) ~ \"\")"
    );
    assert_eq!(inst[1].loops, vec![Some("files".to_string())]);
    assert_eq!(inst[1].exprs["code"], "(__row.body | trim)");
    assert_eq!(
        inst[1].exprs["lang"],
        "(__row.lang if __row.lang is defined and __row.lang is not none else \"txt\")"
    );
    // A plain path stays a path.
    let inst = instances(
        "import Code from './Code'\nexport default function T({ src }: any) { return <Code code={src} lang=\"ts\" /> }",
    );
    assert_eq!(inst[0].props["code"], Some("src".to_string()));
}

#[test]
fn outside_the_subset_stays_unbound() {
    // A local, a call outside the printer's table: no path, literal or expression.
    let inst = instances(
        "import Code from './Code'\nexport default function T({ src }: any) { const s = src.repeat(2); return <div><Code code={s} lang=\"ts\" /><Code code={src.padStart(4)} lang=\"ts\" /></div> }",
    );
    for i in &inst {
        assert_eq!(i.props.get("code"), Some(&None), "{i:?}");
        assert!(i.exprs.is_empty(), "{i:?}");
    }
    // The whole props object is not a value the server hands a child; a member of it is.
    let inst = instances(
        "import Code from './Code'\nexport default function T(props: any) { return <div><Code code={props} lang=\"ts\" /><Code code={props.src + '!'} lang=\"ts\" /></div> }",
    );
    assert_eq!(inst[0].props.get("code"), Some(&None), "{:?}", inst[0]);
    assert_eq!(
        inst[1].exprs["code"], "((__props.src | js_string) ~ \"!\")",
        "{:?}",
        inst[1]
    );
}
