//! F233 / F247 / F257: every name the chunk or the job declares on its own comes from one allocator seeded with the
//! component's names, so a component binding named like one (`signal`, `props`, `__text`, `_c1`, …) is renamed
//! around, never refused: the component stays native and its chunk and job load.
mod lower_common;
use brust_compiler::analyze::component::AnalyzeOptions;
use brust_compiler::lower::names::{Names, taken};
use brust_compiler::lower::render_debug::render;
use brust_compiler::lower::{Artifacts, DEFAULT_RUNTIME_IMPORT, LowerCtx, lower as lower_ir};
use brust_compiler::parse::run_on_compiler_thread;
use brust_compiler::pipeline::compile_tree;
use lower_common::{bun, lower, repo};

/// Every name the chunk generates itself.
const NAMES: &[&str] = &[
    "signal",
    "computed",
    "untracked",
    "defineBehavior",
    "props",
    "__el",
    "__effect",
    "__onCleanup",
    "__ref",
    "__text",
    "__attr",
    "__attrs",
    "__attro",
    "__css",
    "__unitless",
    "__bool",
    "__args",
    "_c1",
    "_l1",
    "_k1",
    "_p1",
];

/// A component that makes the chunk print every generated name (each paint helper, a list, an effect with deps, a
/// ref, a `useId`, a linked child), with `NAME` bound by the component in the role `role`.
fn component(name: &str, role: &str) -> String {
    let (decl, read, click) = match role {
        "state" => (
            format!("const [{name}, setV] = useState(0)"),
            format!("{name}"),
            format!("() => setV({name} + 1)"),
        ),
        "derived" => (
            format!("const {name} = n * 2"),
            format!("{name}"),
            "() => setN(n + 1)".to_string(),
        ),
        "handler" => (
            format!("const {name} = () => setN(n + 1)"),
            "n".to_string(),
            name.to_string(),
        ),
        "ref" => (
            format!("const {name} = useRef(null)"),
            "n".to_string(),
            "() => setN(n + 1)".to_string(),
        ),
        _ => unreachable!(),
    };
    let ref_attr = if role == "ref" {
        format!(" ref={{{name}}}")
    } else {
        String::new()
    };
    format!(
        "import {{ useState, useRef, useEffect, useId }} from 'react'
import Counter from './Counter'
export default function T({{ title }}: any) {{
  const [n, setN] = useState(0)
  {decl}
  const id = useId()
  useEffect(() => {{ document.title = String(n) }}, [n])
  return (
    <div id={{id}}>
      <b data-testid=\"b\" onClick={{{click}}}{ref_attr} title={{title + n}} style={{{{ width: n }}}} aria-label={{n > 1}} download={{n > 2}} hidden={{n > 3}}>{{{read}}}</b>
      <ul>{{[1, 2].map((i) => <li key={{i}}>{{i + n}}</li>)}}</ul>
      <Counter n={{n}} onReset={{() => setN(0)}} />
    </div>
  )
}}
"
    )
}

fn parses(file_name: &str, code: &str) -> Result<(), String> {
    let Some(bun) = bun() else {
        eprintln!("warning: bun not on PATH; skipping the syntax check");
        return Ok(());
    };
    let dir = std::env::temp_dir().join(format!("brustc-generated-names-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(file_name);
    std::fs::write(&file, code).unwrap();
    let out = std::process::Command::new(bun)
        .args(["build", "--no-bundle"])
        .arg(&file)
        .output()
        .unwrap();
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

fn words(line: &str) -> Vec<&str> {
    line.split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '$'))
        .filter(|w| !w.is_empty())
        .collect()
}

/// The chunk binds `name` once (the component's own binding): no import, context destructure target, helper or member
/// takes it.
fn binds_once(name: &str, chunk: &str) -> Result<(), String> {
    let mut decls = 0;
    for line in chunk.lines() {
        let t = line.trim_start();
        if t.starts_with("import {") {
            // `signal as signal1` keeps the imported name, but the local is another.
            let locals: Vec<&str> = t["import {".len()..]
                .split('}')
                .next()
                .unwrap_or("")
                .split(',')
                .map(|s| s.rsplit(" as ").next().unwrap_or("").trim())
                .collect();
            if locals.contains(&name) {
                return Err(format!("the runtime import binds `{name}`: {t}"));
            }
        }
        if t.starts_with("export default defineBehavior")
            || t.contains("(({ el: ")
            || t.contains("({ el: ")
        {
            let ctx = t
                .split("({ ")
                .nth(1)
                .unwrap_or("")
                .split(" })")
                .next()
                .unwrap_or("");
            for part in ctx.split(", ") {
                let local = part.rsplit(": ").next().unwrap_or("");
                if local == name {
                    return Err(format!("the behaviour context binds `{name}`: {t}"));
                }
            }
        }
        if let Some(rest) = t.strip_prefix("const ")
            && words(rest).first() == Some(&name)
        {
            decls += 1;
        }
    }
    if decls == 1 {
        Ok(())
    } else {
        Err(format!("`const {name}` is declared {decls} times"))
    }
}

/// Each generated name taken by a state, a derived value, a handler and a ref: the component stays native, its chunk
/// parses and binds the name once (the component's), and the template reads the same members the chunk exports.
#[test]
fn a_component_binding_named_like_a_generated_name_is_renamed_around() {
    let mut failures = Vec::new();
    for name in NAMES {
        for role in ["state", "derived", "handler", "ref"] {
            let a = lower(&component(name, role));
            let Some(c) = a.client_js.clone() else {
                failures.push(format!("{name} as {role}: no chunk (jinja: {})", a.jinja));
                continue;
            };
            if let Err(e) = parses(&format!("{}-{role}.js", name.trim_start_matches('_')), &c) {
                failures.push(format!("{name} as {role}: chunk does not parse\n{e}\n{c}"));
                continue;
            }
            if let Err(e) = binds_once(name, &c) {
                failures.push(format!("{name} as {role}: {e}\n{c}"));
            }
            // Every member a directive of this component names is one the chunk returns (the inlined `<Counter>`
            // host's own directives are its chunk's; `x-props-bind` on it is this one's).
            let own = a
                .jinja
                .splitn(3, "x-data=")
                .take(2)
                .collect::<Vec<_>>()
                .join("x-data=");
            let ret = c
                .lines()
                .find(|l| l.trim_start().starts_with("return { "))
                .unwrap_or("")
                .to_string();
            for d in [
                "x-text=\"",
                "x-on-click=\"",
                "x-props-bind=\"",
                "x-bind-title=\"",
            ] {
                let text = if d == "x-props-bind=\"" {
                    &a.jinja
                } else {
                    &own
                };
                for part in text.split(d).skip(1) {
                    let m = part.split(['"', ':']).next().unwrap_or("");
                    if !words(&ret).contains(&m) {
                        failures.push(format!(
                            "{name} as {role}: the template names `{m}`, the chunk returns {ret}"
                        ));
                    }
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

/// The chunk's own names keep their spelling when the component does not spell them (the goldens are unchanged), and
/// a component that calls its parameter `props` keeps the context's `props` (the prop locals are not seeds).
#[test]
fn generated_names_keep_their_spelling_unless_taken() {
    let c = lower(
        "import { useState } from 'react'\nexport default function T(props: any) { const [n, setN] = useState(0); return <b onClick={() => { setN(n + 1); props.onPick?.(n) }}>{props.title}{n}</b> }",
    )
    .client_js
    .unwrap();
    assert!(
        c.contains("import { signal, computed, defineBehavior } from"),
        "{c}"
    );
    assert!(
        c.contains("({ el: __el, props, effect: __effect, onCleanup: __onCleanup, ref: __ref })"),
        "{c}"
    );
    assert!(c.contains("__text(props().title)"), "{c}");

    // Taken: the import is aliased, and every use reads the alias.
    let c = lower(
        "import { useState } from 'react'\nexport default function T() { const [signal, setS] = useState(0); const computed = signal + 1; return <b onClick={() => setS(signal + 1)}>{computed}</b> }",
    )
    .client_js
    .unwrap();
    assert!(
        c.contains("import { signal as signal1, computed as computed1, defineBehavior } from"),
        "{c}"
    );
    assert!(c.contains("const signal = signal1(0)"), "{c}");
    assert!(
        c.contains("const computed = computed1(() => signal() + 1)"),
        "{c}"
    );
}

/// A structured arrow parameter named `props` beside a prop read in its body: the context's `props` is renamed, so the
/// prop read is not captured by the parameter.
#[test]
fn an_arrow_parameter_named_props_does_not_capture_a_prop_read() {
    let c = lower(
        "import { useState } from 'react'\nexport default function T({ a, ...props }: any) { const [n, setN] = useState(0); const f = (props: number) => a + props + n; return <b onClick={() => setN(n + 1)}>{f(1)}</b> }",
    )
    .client_js
    .unwrap();
    assert!(c.contains("props: props1"), "{c}");
    assert!(c.contains("(props) => props1().a + props + n()"), "{c}");
    parses("arrow-props.js", &c).unwrap();
}

/// R34.124: a specialised clone's shared factory exports `behavior`; a module binding of that name moves the factory's.
#[test]
fn a_module_binding_named_behavior_moves_the_shared_factory() {
    let src = "import { useState } from 'react'\nconst behavior = 'x'\nexport default function T() { const [n, setN] = useState(0); return <b onClick={() => setN(n + behavior.length)}>{n}</b> }";
    let s = src.to_string();
    let mut ir = run_on_compiler_thread(move || {
        compile_tree(
            "tests/fixtures/parent-counter/T.tsx",
            Some(s.into_bytes()),
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap()
        .remove(0)
        .ir
        .as_ref()
        .clone()
    });
    ir.specialised = true;
    let none = |_: &str| None;
    let no = |_: &str| false;
    let a: Artifacts = lower_ir(
        &ir,
        &LowerCtx {
            resolve: &none,
            runtime_import: DEFAULT_RUNTIME_IMPORT,
            linked: &no,
        },
    )
    .unwrap();
    let (_, code) = &a.client_modules[0];
    assert!(code.contains("const behavior = \"x\";"), "{code}");
    assert!(code.contains("const behavior1 = ({ el: __el"), "{code}");
    assert!(
        code.ends_with("export { behavior1 as behavior }\n"),
        "{code}"
    );
    parses("factory.js", code).unwrap();
}

/// F257 (Mellow, context-lowering-3 round 1 N1): a body local spelled like a prop the job reads off a plain `props`
/// parameter. The job destructured the prop under its key next to the local's `const`, a SyntaxError (and with `let`
/// a TDZ read of the local); it destructures it under another name now, and the local reads that.
#[test]
fn f257_a_body_local_named_like_a_prop_read_off_the_parameter() {
    for (label, src) in [
        (
            "Object.assign",
            "import { useState } from 'react'\nexport default function D(props: any) {\n  const [n, setN] = useState(0)\n  const style = Object.assign({}, props.style, { color: 'red' })\n  return <div style={style} onClick={() => setN(n + 1)}>{n}</div>\n}\n",
        ),
        (
            "object spread",
            "import { useState } from 'react'\nexport default function B(props: any) {\n  const [n, setN] = useState(0)\n  const style = { ...props.style, color: 'red' }\n  return <div style={style} onClick={() => setN(n + 1)}>{n}</div>\n}\n",
        ),
    ] {
        let a = lower(src);
        let Some(job) = a.server_ts else { continue };
        parses(&format!("f257-{}.ts", label.replace(' ', "-")), &job)
            .unwrap_or_else(|e| panic!("{label}: the job does not parse\n{e}\n{job}"));
        let decls = job
            .lines()
            .filter(|l| {
                let w = words(l);
                w.first() == Some(&"const") && w.contains(&"style") && !l.contains("style:")
            })
            .count();
        assert!(decls <= 1, "{label}: `style` bound twice\n{job}");
        if job.contains("props.style") || job.contains("style1") {
            assert!(!job.contains("const { style } = props"), "{label}:\n{job}");
        }
    }
    let job = lower(
        "import { useState } from 'react'\nexport default function D(props: any) {\n  const [n, setN] = useState(0)\n  const style = Object.assign({}, props.style, { color: 'red' })\n  return <div style={style} onClick={() => setN(n + 1)}>{n}</div>\n}\n",
    )
    .server_ts
    .unwrap();
    assert!(job.contains("  const { style: style1 } = props\n"), "{job}");
    assert!(
        job.contains("Object.assign({}, style1, { color: \"red\" })"),
        "{job}"
    );
}

/// The job's parameter is renamed when the component binds `props` itself, and the reads go through the new name.
#[test]
fn the_job_parameter_avoids_a_state_named_props() {
    let job = lower(
        "import { useState } from 'react'\nexport default function D(p: any) {\n  const [props, setProps] = useState(0)\n  const s = Object.assign({}, p.style, { n: props })\n  return <div style={s} onClick={() => setProps(props + 1)}>{props}</div>\n}\n",
    )
    .server_ts
    .unwrap();
    assert!(
        job.contains("export function precompute(props1: any)"),
        "{job}"
    );
    assert!(job.contains("const { style } = props1"), "{job}");
    assert!(job.contains("const props = 0"), "{job}");
    parses("job-props.ts", &job).unwrap();
}

/// A template variable the printer names (`_dN` for a derived value) skips a prop of that name: the prop painted the
/// derived value before.
#[test]
fn a_template_variable_skips_a_prop_of_its_name() {
    let a = lower(
        "import { useState } from 'react'\nexport default function J({ _d1, rows }: any) { const [n, setN] = useState(0); const x = rows.length + 1; return <p onClick={() => setN(n + 1)}>{_d1}|{x}|{n}</p> }",
    );
    let props = serde_json::json!({ "_d1": "D", "rows": ["a", "b"] });
    let html = render(&a.jinja, &props, &serde_json::json!({}), &[]).unwrap();
    assert!(
        html.contains(">D</span>|<span x-text=\"_c2\">3</span>"),
        "{}\n{html}",
        a.jinja
    );
}

/// The allocator: whole words, numbered families, and the seed's skip rules.
#[test]
fn the_allocator() {
    let mut n = Names::new(
        &["signal".to_string(), "__f0".to_string()]
            .into_iter()
            .collect(),
    );
    assert_eq!(n.fresh("signal"), "signal1");
    assert_eq!(n.fresh("signal"), "signal2");
    assert_eq!(n.fresh("computed"), "computed");
    assert_eq!(n.fresh("computed"), "computed1");
    assert_eq!(n.fresh_family("__f"), "__f1");
    assert_eq!(n.fresh_family("__fj"), "__fj");

    let s = "import { useState } from 'react'\nexport default function T({ title: heading, ...rest }: any) { const [n, setN] = useState(0); const label = 'signal'; return <b onClick={() => { const __text = 1; setN(n + __text) }}>{heading}{label}{n}</b> }";
    let s = s.to_string();
    let ir = run_on_compiler_thread(move || {
        compile_tree(
            "tests/fixtures/parent-counter/T.tsx",
            Some(s.into_bytes()),
            &AnalyzeOptions {
                root: repo(),
                ..Default::default()
            },
            DEFAULT_RUNTIME_IMPORT,
        )
        .unwrap()
        .remove(0)
        .ir
        .as_ref()
        .clone()
    });
    let t = taken(&ir);
    for name in ["n", "setN", "label"] {
        assert!(t.contains(name), "{name}: {t:?}");
    }
    // A string literal, a prop key, a prop local, and a name declared inside verbatim code are not seeds.
    for name in ["signal", "title", "heading", "rest", "__text"] {
        assert!(!t.contains(name), "{name}: {t:?}");
    }
}
