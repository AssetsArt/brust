//! minijinja render on tokio (spec §4 S7 steps 6-7, S8, S9).
//!
//! Adapted from `brust-core/src/template/jinja.rs` @ d04718f: the environment is
//! owned by the [`Renderer`] and built once from the manifest's templates (no
//! process-global `RwLock`, no dynamic tier, no hot reload). Every environment
//! goes through [`brust_jinja::register`] — autoescape None, the template writes
//! `| e` itself; no second escaper is ever added here.
use std::collections::BTreeMap;
use std::sync::Arc;

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

/// minijinja's builtin `safe` (`Value::from_safe_string(v.to_string())`,
/// the argument taken as a `String`), except that an already-safe string
/// (`__outlet`) is returned as-is instead of copied twice — the value is the
/// same. With `AutoEscape::None` the safe mark never changes a painted byte.
fn safe_filter(
    state: &minijinja::State,
    v: minijinja::Value,
) -> Result<minijinja::Value, minijinja::Error> {
    use minijinja::value::ArgType;
    if v.is_safe() {
        return Ok(v);
    }
    let (s, _) = String::from_state_and_value(Some(state), Some(&v))?;
    Ok(minijinja::Value::from_safe_string(s))
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
        // One parse at boot: no loader is installed, and auto-reload stays
        // off so a template never re-parses (the M3 dev server owns reload).
        env.set_auto_reload(false);
        brust_jinja::register(&mut env);
        env.add_filter("safe", safe_filter);
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
        tmpl.render(brust_jinja::value_of(ctx))
            .map_err(|e| render_err(name, &e))
    }

    /// S7 step 7 / S8: leaf-first; each result becomes the parent's `__outlet`.
    /// `base` is the merged context (converted once per request and shared —
    /// minijinja `Value`s are `Arc`-backed); `overlay(id)` returns the layers
    /// only that component sees (its `_idN`, its own child-instance slots and
    /// job results, `_props`). Each component renders under one [`Scope`]
    /// object over `base` (M3-P P3): no per-component map is built.
    pub fn render_chain_overlay(
        &self,
        chain: &[String],
        base: &minijinja::Value,
        overlay: &dyn Fn(&str) -> Overlay,
    ) -> Result<String, RenderError> {
        let mut outlet: Option<String> = None;
        for id in chain.iter().rev() {
            let scope = minijinja::Value::from_object(Scope {
                outlet: outlet.take().map(minijinja::Value::from_safe_string),
                overlay: overlay(id),
                base: base.clone(),
            });
            let tmpl = self
                .env
                .get_template(id)
                .map_err(|_| RenderError::Unknown(id.clone()))?;
            outlet = Some(tmpl.render(scope).map_err(|e| render_err(id, &e))?);
        }
        Ok(outlet.unwrap_or_default())
    }

    /// [`Self::render_chain_value`] over a JSON context. Only tests use it;
    /// the pipeline calls [`Self::render_chain_overlay`].
    pub fn render_chain(
        &self,
        chain: &[String],
        ctx: &Value,
        overlay: &dyn Fn(&str) -> Vec<(String, minijinja::Value)>,
    ) -> Result<String, RenderError> {
        self.render_chain_value(chain, &brust_jinja::value_of(ctx), overlay)
    }

    /// [`Self::render_chain_overlay`] with only ad-hoc `(key, value)` pairs per
    /// component (a later pair wins over an earlier one). Only tests use it.
    pub fn render_chain_value(
        &self,
        chain: &[String],
        base: &minijinja::Value,
        overlay: &dyn Fn(&str) -> Vec<(String, minijinja::Value)>,
    ) -> Result<String, RenderError> {
        self.render_chain_overlay(chain, base, &|id| Overlay {
            pairs: overlay(id),
            ..Default::default()
        })
    }
}

/// What one chain component sees over the base context.
#[derive(Debug, Default)]
pub struct Overlay {
    /// Looked up after `maps`, last pair first (`_idN` useId slots; a test's ad-hoc pairs).
    pub pairs: Vec<(String, minijinja::Value)>,
    /// Map-valued layers (`ctx["__children"][id]`, `ctx["__own"][id]`), looked up LAST ONE FIRST.
    pub maps: Vec<minijinja::Value>,
    /// `_props` — beats everything but `__outlet`.
    pub props: Option<minijinja::Value>,
}

/// One chain component's scope: the overlay layers over the base context,
/// as ONE object (M3-P P3) — no `from_pairs` map and no `MergeDict` per
/// component. Lookup order is what `context!{ ..from_pairs(overlay), ..base }`
/// gave (a later pair overwrote an earlier one): `__outlet`, `_props`, the maps
/// last-first (own, children), the pairs last-first (ids), the base. An
/// undefined hit falls through, as `MergeDict` skips it. Root lookups reach
/// `get_value_by_str` directly (no key `Value`).
#[derive(Debug)]
struct Scope {
    outlet: Option<minijinja::Value>,
    overlay: Overlay,
    base: minijinja::Value,
}

fn defined(v: Result<minijinja::Value, minijinja::Error>) -> Option<minijinja::Value> {
    v.ok().filter(|v| !v.is_undefined())
}

impl minijinja::value::Object for Scope {
    fn get_value(self: &Arc<Self>, key: &minijinja::Value) -> Option<minijinja::Value> {
        self.get_value_by_str(key.as_str()?)
    }

    fn get_value_by_str(self: &Arc<Self>, key: &str) -> Option<minijinja::Value> {
        if key == "__outlet"
            && let Some(o) = &self.outlet
        {
            return Some(o.clone());
        }
        if key == "_props"
            && let Some(p) = &self.overlay.props
        {
            return Some(p.clone());
        }
        for m in self.overlay.maps.iter().rev() {
            if let Some(v) = defined(m.get_attr(key)) {
                return Some(v);
            }
        }
        // The pairs were one map before P3: the last pair for `key` is the
        // entry; an undefined entry falls through to the base, as before.
        if let Some((_, v)) = self.overlay.pairs.iter().rev().find(|(k, _)| k == key)
            && !v.is_undefined()
        {
            return Some(v.clone());
        }
        defined(self.base.get_attr(key))
    }

    fn enumerate(self: &Arc<Self>) -> minijinja::value::Enumerator {
        // The union of the layers' keys, sorted (MergeDict: map-kind layers only).
        let mut keys = std::collections::BTreeSet::new();
        for m in self.overlay.maps.iter().chain(std::iter::once(&self.base)) {
            if m.kind() == minijinja::value::ValueKind::Map
                && let Ok(it) = m.try_iter()
            {
                keys.extend(it);
            }
        }
        keys.extend(
            self.overlay
                .pairs
                .iter()
                .map(|(k, _)| minijinja::Value::from(k.as_str())),
        );
        if self.overlay.props.is_some() {
            keys.insert(minijinja::Value::from("_props"));
        }
        if self.outlet.is_some() {
            keys.insert(minijinja::Value::from("__outlet"));
        }
        minijinja::value::Enumerator::Iter(Box::new(keys.into_iter()))
    }
}

/// S9: `<script type="module" src="/_brust/<p>">` for runtime, each `client` of
/// the chain + job targets + inlined children (dedup, chain order), then
/// `react` + each react chunk. No tags when every component in the chain (and its children) is
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
            // React children are not child records: their ssr jobs sit in
            // this component's `jobs[]` and name them as `target`.
            for t in c.jobs.iter().filter_map(|j| j.target.as_deref()) {
                visit(t);
            }
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

/// S7 step 6 / F39: context keys `_id0`..`_id{slots-1}` (0-based, lead ruling
/// on challenge a76cefb2) carry `brust-<routeId>-<instance>-<n>` for n in 1..=slots;
/// instance = component id for chain entries, `<parentId>.<childId>_<k>` for
/// static child instances, `<parentId>.<childId>_<k>-<row>` for per-row
/// instances. Ids are opaque: stable and unique per route is the contract.
pub fn use_ids(route_id: &str, instance: &str, slots: u32) -> Vec<(String, String)> {
    (1..=slots)
        .map(|n| {
            (
                format!("_id{}", n - 1),
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

    /// The `safe` override paints what minijinja's builtin does, for every
    /// kind of operand, and passes an already-safe `__outlet` through.
    #[test]
    fn safe_filter_paints_like_the_builtin() {
        let src = "{{ s | safe }}|{{ n | safe }}|{{ f | safe }}|{{ z | safe }}|{{ b | safe }}|\
                   {{ missing | safe }}|{{ missing.deep | safe }}|{{ l | safe }}|{{ m | safe }}|\
                   {{ (s | safe) | length }}|{{ __outlet | safe }}|{{ (__outlet | safe) | e }}";
        let ctx = json!({"s": "<b>&", "n": 7, "f": 1.5, "z": null, "b": true,
                         "l": [1, "<a>"], "m": {"k": "v"}});
        let ours = Renderer::from_templates(&templates(&[("T", src)])).unwrap();
        let mut builtin = Environment::new();
        brust_jinja::register(&mut builtin);
        builtin.add_template("T", src).unwrap();
        let want = builtin
            .get_template("T")
            .unwrap()
            .render(minijinja::context! {
                __outlet => minijinja::Value::from("<i>x</i>"),
                ..brust_jinja::value_of(&ctx)
            })
            .unwrap();
        let got = ours
            .render_chain(&["T".into()], &ctx, &|_| {
                vec![(
                    "__outlet".into(),
                    minijinja::Value::from_safe_string("<i>x</i>".into()),
                )]
            })
            .unwrap();
        assert_eq!(got, want);
        assert!(got.contains("<b>&|7|1.5|None|True|||"), "{got}");
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
            "Layout" => vec![("_id1".to_string(), minijinja::Value::from("L1"))],
            "Leaf" => vec![("_id1".to_string(), minijinja::Value::from("F1"))],
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

    /// The Scope answers exactly what `context!{ ..from_pairs(overlay), ..base }` answered:
    /// __outlet > _props > own > children > ids > base, undefined skipped, union enumerated.
    #[test]
    fn scope_lookup_order_matches_the_merge_dict() {
        let r = Renderer::from_templates(&templates(&[(
            "T",
            "{{ __outlet | safe }}|{{ _props.x }}|{{ k }}|{{ _id0 }}|{{ only_base }}|{{ gone is defined }}|{% for n in self %}{{ n }},{% endfor %}",
        )]))
        .unwrap();
        let base = minijinja::context! { k => "base", _id0 => "base-id", only_base => "ob", _props => "base-props", x => 1 };
        let children = minijinja::context! { k => "children", gone => minijinja::Value::UNDEFINED };
        let own = minijinja::context! { k => "own" };
        let overlay = Overlay {
            pairs: vec![
                ("_id0".into(), minijinja::Value::from("id")),
                ("k".into(), minijinja::Value::from("ids")),
            ],
            maps: vec![children.clone(), own.clone()],
            props: Some(minijinja::context! { x => 2 }),
        };
        let got = r
            .render_chain_overlay(&["T".into()], &base, &|_| Overlay {
                pairs: overlay.pairs.clone(),
                maps: overlay.maps.clone(),
                props: overlay.props.clone(),
            })
            .unwrap();
        // Reference: the former shape, built the way render_chain_value built it.
        let mut pairs = overlay.pairs.clone();
        for m in [&children, &own] {
            for k in m.try_iter().unwrap() {
                pairs.push((k.to_string(), m.get_item(&k).unwrap()));
            }
        }
        pairs.push(("_props".into(), overlay.props.clone().unwrap()));
        let pairs_ref = pairs.clone();
        let want = minijinja::context! { ..minijinja::Value::from_pairs(pairs), ..base.clone() };
        let want = r.env.get_template("T").unwrap().render(want).unwrap();
        assert_eq!(got, want);
        // minijinja paints a bare bool as `False`; `self` is not the root scope
        // in minijinja 3.0 (the loop paints nothing), so enumeration is pinned
        // below through `try_iter` on the scope object itself.
        assert_eq!(got, "|2|own|id|ob|False|");
        let scope = minijinja::Value::from_object(Scope {
            outlet: Some(minijinja::Value::from_safe_string("o".into())),
            overlay: Overlay {
                pairs: overlay.pairs.clone(),
                maps: overlay.maps.clone(),
                props: overlay.props.clone(),
            },
            base: base.clone(),
        });
        let mut pairs = pairs_ref.clone();
        pairs.push((
            "__outlet".into(),
            minijinja::Value::from_safe_string("o".into()),
        ));
        let merged = minijinja::context! { ..minijinja::Value::from_pairs(pairs), ..base.clone() };
        let keys = |v: &minijinja::Value| {
            v.try_iter()
                .unwrap()
                .map(|k| k.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(keys(&scope), keys(&merged));
        assert_eq!(
            keys(&scope),
            ["__outlet", "_id0", "_props", "gone", "k", "only_base", "x"]
        );
    }

    /// A scope sees the context as it was when the scope was built: a later
    /// make_mut write to the Node tree copies, it does not reach the view.
    #[test]
    fn scope_sees_the_context_as_rendered_not_as_later_mutated() {
        use brust_jinja::ctx::Node;
        let r = Renderer::from_templates(&templates(&[("T", "{{ a.b }}")])).unwrap();
        let mut ctx: Node = serde_json::from_str(r#"{"a":{"b":1}}"#).unwrap();
        let base = ctx.to_value();
        ctx.get_mut_path(&["a"])
            .unwrap()
            .map_mut()
            .unwrap()
            .insert("b".into(), Node::Num(2.into()));
        assert_eq!(
            r.render_chain_overlay(&["T".into()], &base, &|_| Overlay::default())
                .unwrap(),
            "1"
        );
        assert_eq!(
            r.render_chain_overlay(&["T".into()], &ctx.to_value(), &|_| Overlay::default())
                .unwrap(),
            "2"
        );
    }
}
