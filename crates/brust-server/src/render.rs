//! minijinja render on tokio (spec §4 S7 steps 6-7, S8, S9).
//!
//! Adapted from `brust-core/src/template/jinja.rs` @ d04718f: the environment is
//! owned by the [`Renderer`] and built once from the manifest's templates (no
//! process-global `RwLock`, no dynamic tier, no hot reload). Every environment
//! goes through [`brust_jinja::register`] — autoescape None, the template writes
//! `| e` itself; no second escaper is ever added here.
use std::collections::BTreeMap;

use minijinja::Environment;
use serde_json::Value;

use crate::manifest::{Manifest, Tier};

#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    #[error("unknown template {0}")]
    Unknown(String),
    /// `msg` is minijinja's Display (`… (in <name>:<line>)`) prefixed with
    /// `line <n>: ` so the line number reaches the server log (spec §7).
    #[error("render {name}: {msg}")]
    Render { name: String, msg: String },
}

fn render_err(name: &str, e: &minijinja::Error) -> RenderError {
    let msg = match e.line() {
        Some(n) => format!("line {n}: {e:#}"),
        None => format!("{e:#}"),
    };
    RenderError::Render {
        name: name.to_string(),
        msg,
    }
}

pub struct Renderer {
    env: Environment<'static>,
}

impl Renderer {
    /// Builds the environment (`brust_jinja::register`) and compiles every
    /// template. minijinja parses at add time, so a syntax error is returned
    /// here (boot), naming the template and line.
    pub fn from_templates(templates: &BTreeMap<String, String>) -> Result<Self, RenderError> {
        let mut env = Environment::new();
        brust_jinja::register(&mut env);
        for (id, src) in templates {
            env.add_template_owned(id.clone(), src.clone())
                .map_err(|e| render_err(id, &e))?;
        }
        Ok(Renderer { env })
    }

    pub fn render(&self, name: &str, ctx: &Value) -> Result<String, RenderError> {
        let tmpl = self
            .env
            .get_template(name)
            .map_err(|_| RenderError::Unknown(name.to_string()))?;
        tmpl.render(minijinja::Value::from_serialize(ctx))
            .map_err(|e| render_err(name, &e))
    }

    /// S7 step 7 / S8: leaf-first; each result becomes the parent's `__outlet`.
    /// `ctx` is the merged context; per-component overlays carry that
    /// component's `_idN`. The overlay wins over `ctx`; `ctx` is converted once
    /// for the whole chain and shared (minijinja `Value`s are `Arc`-backed), never
    /// cloned per step.
    pub fn render_chain(
        &self,
        chain: &[String],
        ctx: &Value,
        ids: &dyn Fn(&str) -> Vec<(String, String)>,
    ) -> Result<String, RenderError> {
        let base = minijinja::Value::from_serialize(ctx);
        let mut outlet: Option<String> = None;
        for id in chain.iter().rev() {
            let mut overlay: Vec<(String, minijinja::Value)> = ids(id)
                .into_iter()
                .map(|(k, v)| (k, minijinja::Value::from(v)))
                .collect();
            if let Some(o) = outlet.take() {
                overlay.push(("__outlet".into(), minijinja::Value::from(o)));
            }
            // `context!{ ..a, ..b }` builds a MergeDict: the first spread wins
            // per key, a key missing from both is undefined (Chainable).
            let scope = if overlay.is_empty() {
                base.clone()
            } else {
                minijinja::context! { ..minijinja::Value::from_iter(overlay), ..base.clone() }
            };
            let tmpl = self
                .env
                .get_template(id)
                .map_err(|_| RenderError::Unknown(id.clone()))?;
            outlet = Some(tmpl.render(scope).map_err(|e| render_err(id, &e))?);
        }
        Ok(outlet.unwrap_or_default())
    }
}

/// S9: `<script type="module" src="/_brust/<p>">` for runtime, each `client` of
/// the chain + inlined children (dedup, chain order), then `react` + each react
/// child chunk. No tags when every component in the chain (and its children) is
/// `static`. Inserted before the last `</body>`, else appended.
pub fn inject_assets(mut html: String, chain: &[String], m: &Manifest) -> String {
    let mut chunks: Vec<&str> = Vec::new();
    let mut react: Vec<&str> = Vec::new();
    let mut any_dynamic = false;
    let mut visit = |id: &str| {
        if let Some(c) = m.components.get(id) {
            if c.tier != Tier::Static {
                any_dynamic = true;
            }
            if let Some(cl) = &c.client {
                let bucket = if c.tier == Tier::React {
                    &mut react
                } else {
                    &mut chunks
                };
                if !bucket.contains(&cl.as_str()) {
                    bucket.push(cl);
                }
            }
        }
    };
    for id in chain {
        visit(id);
        if let Some(c) = m.components.get(id) {
            for ch in &c.children {
                visit(&ch.id);
            }
        }
    }
    if !any_dynamic {
        return html;
    }
    let tag = |p: &str| format!("<script type=\"module\" src=\"/_brust/{p}\"></script>");
    let mut tags = tag(&m.assets.runtime);
    for c in &chunks {
        tags.push_str(&tag(c));
    }
    if !react.is_empty() {
        if let Some(r) = &m.assets.react {
            tags.push_str(&tag(r));
        }
        for c in &react {
            tags.push_str(&tag(c));
        }
    }
    match html.rfind("</body>") {
        Some(i) => html.insert_str(i, &tags),
        None => html.push_str(&tags),
    }
    html
}

/// S7 step 6 / F39: `brust-<routeId>-<instance>-<n>` for n in 1..=slots;
/// instance = component id for chain entries, `<childId>_<k>` for static child
/// instances, `<childId>_<k>-<row>` for per-row instances.
pub fn use_ids(route_id: &str, instance: &str, slots: u32) -> Vec<(String, String)> {
    (1..=slots)
        .map(|n| {
            (
                format!("_id{n}"),
                format!("brust-{route_id}-{instance}-{n}"),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn templates(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    // Adapted from template/jinja.rs `jinja_round_trip` (:243): owned env built
    // from a template map instead of a directory + process-global; the reload
    // and BadJson sub-checks have no subject (no hot reload, ctx is a Value).
    // Adds the overlay semantics of `render_chain`.
    #[test]
    fn jinja_round_trip() {
        let r = Renderer::from_templates(&templates(&[
            ("HelloPage", "<div><h1>Hello, {{ name }}</h1></div>"),
            (
                "ListNav",
                "<ul>{% for item in items %}<li>{{ item.label }}</li>{% endfor %}</ul>",
            ),
            (
                "Layout",
                "[{{ _id1 }}|{{ __outlet | safe }}|{{ missing is defined }}|{{ missing.deep.x | e }}|{{ name | e }}]",
            ),
            ("Leaf", "<{{ _id1 }}:{{ name }}:{{ __outlet is defined }}>"),
        ]))
        .expect("templates");

        let out = r.render("HelloPage", &json!({"name": "World"})).unwrap();
        assert_eq!(out, "<div><h1>Hello, World</h1></div>");

        let out = r
            .render(
                "ListNav",
                &json!({"items": [{"label": "A"}, {"label": "B"}]}),
            )
            .unwrap();
        assert_eq!(out, "<ul><li>A</li><li>B</li></ul>");

        match r.render("NotThere", &json!({})) {
            Err(RenderError::Unknown(name)) => assert_eq!(name, "NotThere"),
            other => panic!("expected Unknown, got {other:?}"),
        }
        match r.render_chain(&["NotThere".into()], &json!({}), &|_| Vec::new()) {
            Err(RenderError::Unknown(name)) => assert_eq!(name, "NotThere"),
            other => panic!("expected Unknown, got {other:?}"),
        }

        // Overlay wins over the base ctx (`_id1` is in both), per component;
        // a key missing everywhere is undefined and chains (UndefinedBehavior::Chainable).
        let ctx = json!({"name": "<n>", "_id1": "base"});
        let ids = |id: &str| match id {
            "Layout" => vec![("_id1".to_string(), "L1".to_string())],
            "Leaf" => vec![("_id1".to_string(), "F1".to_string())],
            _ => Vec::new(),
        };
        let out = r
            .render_chain(&["Layout".into(), "Leaf".into()], &ctx, &ids)
            .unwrap();
        assert_eq!(out, "[L1|<F1:<n>:False>|False||&lt;n&gt;]");

        // No overlay: the base ctx is used as-is.
        let out = r
            .render_chain(&["Leaf".into()], &ctx, &|_| Vec::new())
            .unwrap();
        assert_eq!(out, "<base:<n>:False>");
        assert_eq!(r.render_chain(&[], &ctx, &|_| Vec::new()).unwrap(), "");
    }
}
