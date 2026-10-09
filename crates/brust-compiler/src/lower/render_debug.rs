//! `brustc --render`: a DEBUG helper that renders a component's template with
//! the `brust-jinja` environment, from sample props and the precompute job's
//! output (`slots`). The real server does this in M2; nothing on a production
//! path may call it.
use serde_json::Value;

/// Renders `jinja` with `props` (also under `_props`, as the server passes
/// them), the job output `slots` merged over them, and a placeholder for each
/// React-island output in `ssr_outputs`.
pub fn render(
    jinja: &str,
    props: &Value,
    slots: &Value,
    ssr_outputs: &[String],
) -> Result<String, String> {
    let mut ctx = props.as_object().cloned().unwrap_or_default();
    ctx.insert("_props".into(), props.clone());
    for (k, v) in slots.as_object().cloned().unwrap_or_default() {
        ctx.insert(k, v);
    }
    for o in ssr_outputs {
        ctx.insert(o.clone(), Value::String("<i data-ssr></i>".into()));
    }
    let mut env = minijinja::Environment::new();
    brust_jinja::register(&mut env);
    env.render_str(jinja, brust_jinja::value_of(&ctx))
        .map_err(|e| format!("{e:#}"))
}
