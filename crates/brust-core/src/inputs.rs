//! Job input evaluation (spec S7 step 5): dotted input paths, `[idx]` rows,
//! projection of the values a job reads, and blake3 canonical job keys.

use std::collections::BTreeMap;
use std::sync::{Arc, LazyLock};

use brust_jinja::ctx::{MapInner, Node};
use minijinja::{Environment, Expression, Value};

/// One segment of an input path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seg {
    /// Object key (`a` in `a.b`).
    Key(String),
    /// Literal array index (`[0]`).
    Index(usize),
    /// The current per-row index (`[idx]`).
    Idx,
}

/// Dotted path with optional `[<n>]`/`[idx]` segments: `a.b`, `a[0].b`, `list[idx].name`. A leading `props.` is stripped.
///
/// Invariant: a parsed `Path` is non-empty and starts with a `Seg::Key`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Path(Vec<Seg>);

impl Path {
    /// Parse an input path. Rejects an empty path, an empty dotted segment
    /// (`a..b`, `.a`, `a.`, `a.[0]`), a leading index (`[0].a`), an unclosed
    /// `[`, a non-numeric index, and text after `]` that is not another `[`.
    pub fn parse(s: &str) -> Result<Path, String> {
        let orig = s;
        let s = s.strip_prefix("props.").unwrap_or(s);
        let mut segs = Vec::new();
        for part in s.split('.') {
            let (head, rest) = match part.find('[') {
                Some(i) => (&part[..i], &part[i..]),
                None => (part, ""),
            };
            if head.is_empty() {
                return Err(format!("input path {orig:?}: empty segment"));
            }
            segs.push(Seg::Key(head.to_string()));
            let mut rest = rest;
            while !rest.is_empty() {
                let Some(r) = rest.strip_prefix('[') else {
                    return Err(format!(
                        "input path {orig:?}: unexpected {rest:?} after ']'"
                    ));
                };
                let Some(end) = r.find(']') else {
                    return Err(format!("input path {orig:?}: unclosed '['"));
                };
                segs.push(match &r[..end] {
                    "idx" => Seg::Idx,
                    n => Seg::Index(
                        n.parse()
                            .map_err(|_| format!("input path {orig:?}: bad index {n:?}"))?,
                    ),
                });
                rest = &r[end + 1..];
            }
        }
        Ok(Path(segs))
    }

    /// The root key (first segment). Agrees with `manifest::input_root` for
    /// every path `parse` accepts. Returns `""` only for a `Path` that could
    /// not come from `parse` (empty or index-first), never panics.
    pub fn root(&self) -> &str {
        match self.0.first() {
            Some(Seg::Key(k)) => k,
            _ => "",
        }
    }

    /// The segments, root first.
    pub fn segs(&self) -> &[Seg] {
        &self.0
    }

    /// Read the value at this path. `Null` when absent, or for `[idx]` without a row.
    pub fn get<'v>(&self, ctx: &'v Node, idx: Option<usize>) -> &'v Node {
        static NULL: Node = Node::Null;
        let mut cur = ctx;
        for seg in &self.0 {
            cur = match seg {
                Seg::Key(k) => cur.get(k).unwrap_or(&NULL),
                Seg::Index(i) => cur.index(*i).unwrap_or(&NULL),
                Seg::Idx => match idx {
                    Some(i) => cur.index(i).unwrap_or(&NULL),
                    None => &NULL,
                },
            };
        }
        cur
    }

    /// The value at this path, `None` when a segment is absent (JS `undefined`), or for `[idx]` without a row.
    pub fn find<'v>(&self, ctx: &'v Node, idx: Option<usize>) -> Option<&'v Node> {
        let mut cur = ctx;
        for seg in &self.0 {
            cur = match seg {
                Seg::Key(k) => cur.get(k)?,
                Seg::Index(i) => cur.index(*i)?,
                Seg::Idx => cur.index(idx?)?,
            };
        }
        Some(cur)
    }

    /// Whether everything but the last segment resolves in `ctx` (a missing leaf, not a missing object on the way).
    pub fn parent_exists(&self, ctx: &Node, idx: Option<usize>) -> bool {
        match self.0.split_last() {
            None | Some((_, [])) => true,
            Some((_, parent)) => Path(parent.to_vec()).find(ctx, idx).is_some(),
        }
    }

    fn has_idx(&self) -> bool {
        self.0.contains(&Seg::Idx)
    }
}

/// Key a segment occupies in a projection. Index segments become bracketed
/// keys (`"[0]"`, `"[idx]"`) which no `Seg::Key` can spell (parse splits on
/// `[`), so `a[0]` and `a.0` never share a slot.
fn proj_key(seg: &Seg) -> String {
    match seg {
        Seg::Key(k) => k.clone(),
        Seg::Index(i) => format!("[{i}]"),
        Seg::Idx => "[idx]".to_string(),
    }
}

/// The object a job receives: every `inputs` path materialised at its own position (`{"item":{"price":3}}` for `item.price`).
///
/// Materialisation is objects only: an index segment becomes the key `"[n]"`
/// (`"[idx]"` for the row segment — content-only, so equal rows at different
/// positions project identically). Inputs sharing a prefix merge into one
/// nested object. When one input is a prefix of another (`item` and
/// `item.price`), the shorter one's whole value is kept and the longer one is
/// redundant — the result is independent of input order. An `[idx]` input
/// with `idx == None` is an `Err`.
pub fn project(ctx: &Node, inputs: &[String], idx: Option<usize>) -> Result<Node, String> {
    Projection::new(inputs)?.eval(ctx, idx)
}

/// A job's `inputs` prepared once (at boot): parsed, the redundant ones
/// (covered by a shorter or an equal earlier input) dropped, each kept path's
/// projection keys built. [`Projection::eval`] is [`project`] without the parsing.
#[derive(Debug, Clone)]
pub struct Projection {
    /// `(path, its projection keys)` of every input not covered by another.
    kept: Vec<(Path, Vec<String>)>,
    /// The first `[idx]` input, for the "outside a per-row instance" error.
    first_idx: Option<String>,
}

impl Projection {
    pub fn new(inputs: &[String]) -> Result<Projection, String> {
        let paths = inputs
            .iter()
            .map(|s| Path::parse(s))
            .collect::<Result<Vec<_>, _>>()?;
        let first_idx = paths
            .iter()
            .zip(inputs)
            .find(|(p, _)| p.has_idx())
            .map(|(_, s)| s.clone());
        let mut kept = Vec::new();
        for (i, p) in paths.iter().enumerate() {
            let covered = paths.iter().enumerate().any(|(j, q)| {
                j != i
                    && q.0.len() <= p.0.len()
                    && p.0.starts_with(&q.0)
                    && (q.0.len() < p.0.len() || j < i)
            });
            if !covered {
                kept.push((p.clone(), p.0.iter().map(proj_key).collect()));
            }
        }
        Ok(Projection { kept, first_idx })
    }

    /// The projection of `ctx` (`idx` = the current row).
    pub fn eval(&self, ctx: &Node, idx: Option<usize>) -> Result<Node, String> {
        if idx.is_none()
            && let Some(s) = &self.first_idx
        {
            return Err(format!(
                "input path {s:?}: [idx] outside a per-row instance"
            ));
        }
        let mut out = MapInner::new();
        for (p, keys) in &self.kept {
            // F149/F151 (review F1): a value the context lacks is never `null` in the job (JS `undefined`, as React
            // passes an omitted prop; `cva` reads an explicit `null` as "no variant" and skips its default). A missing
            // leaf is left unset under the objects that hold it (`config: {}` keeps `config.variant` undefined); a
            // missing object on the way makes the whole input absent (`config` undefined), at any depth, index
            // segments included. A present `null` stays `null`. Store reads in a job are optional (`?.` / `?? {}`).
            let value = p.find(ctx, idx);
            if value.is_none() && !p.parent_exists(ctx, idx) {
                continue;
            }
            let (last, prefix) = keys.split_last().expect("parsed path is non-empty");
            let mut node = &mut out;
            for k in prefix {
                // Only intermediate objects we created live at prefix positions:
                // a leaf here would mean a shorter input covers `p`, dropped in `new`.
                let slot = node
                    .entry(Arc::from(k.as_str()))
                    .or_insert_with(|| Node::map(MapInner::new()));
                node = slot.map_mut().expect("projection prefix is an object");
            }
            // An Arc bump for a map/array/string: the context's value is shared.
            if let Some(v) = value {
                node.insert(Arc::from(last.as_str()), v.clone());
            }
        }
        Ok(Node::map(out))
    }
}

/// Child props object from the parent's context through `ChildRecord.props` (`[idx]` = row).
///
/// Builds `{ childProp: Path(parentPath).get(parent_ctx, idx) }`. A `[idx]`
/// parent path with `idx == None` is an `Err`.
pub fn child_props(
    parent_ctx: &Node,
    props: &BTreeMap<String, String>,
    idx: Option<usize>,
) -> Result<Node, String> {
    PropsMap::new(props)?.eval(parent_ctx, idx)
}

/// The list a per-row child repeats over (`ChildRecord.instances`): a parent-context path, or
/// a constant list the manifest carries (`per-row-literal` + `rows`, F142 R34.43).
#[derive(Debug, Clone)]
pub enum Rows {
    Path(Path),
    Literal(Node),
}

impl Rows {
    fn list<'v>(&'v self, ctx: &'v Node) -> &'v Node {
        match self {
            Rows::Path(p) => p.get(ctx, None),
            Rows::Literal(n) => n,
        }
    }

    /// How many rows the list has in `ctx` (0 when it is not an array).
    pub fn count(&self, ctx: &Node) -> usize {
        self.list(ctx).as_arr().map_or(0, |a| a.0.len())
    }

    /// Row `i` of the list (`null` past the end).
    pub fn row(&self, ctx: &Node, i: usize) -> Node {
        self.list(ctx).index(i).cloned().unwrap_or(Node::Null)
    }
}

/// A `props` map (`{ childProp: parent path }`) parsed once (at boot);
/// [`PropsMap::eval`] is [`child_props`] without the parsing. A child record adds
/// constant props and jinja expressions ([`PropsMap::child`], F105).
#[derive(Debug, Clone)]
pub struct PropsMap {
    props: Vec<(String, Bound)>,
    /// A per-row child's list: the row item an expression reads as `__row`.
    rows: Option<Rows>,
}

#[derive(Debug, Clone)]
enum Bound {
    /// A parent path and its source text (for errors).
    Path(Path, String),
    Lit(Node),
    Expr(Arc<Expression<'static, 'static>>, String),
}

/// The environment child-prop expressions compile in: the render's filters and undefined rules.
static EXPR_ENV: LazyLock<Environment<'static>> = LazyLock::new(|| {
    let mut env = Environment::new();
    brust_jinja::register(&mut env);
    env
});

/// Compiles a child-prop expression (`ChildRecord.exprs`); the error is minijinja's message.
pub fn compile_expr(src: &str) -> Result<Expression<'static, 'static>, String> {
    EXPR_ENV
        .compile_expression_owned(src.to_string())
        .map_err(|e| e.to_string())
}

impl PropsMap {
    pub fn new(props: &BTreeMap<String, String>) -> Result<PropsMap, String> {
        PropsMap::child(props, &BTreeMap::new(), &BTreeMap::new(), None)
    }

    /// A child record's bindings: paths, literals and expressions (`rows` = its per-row list).
    pub fn child(
        props: &BTreeMap<String, String>,
        literals: &BTreeMap<String, Node>,
        exprs: &BTreeMap<String, String>,
        rows: Option<Rows>,
    ) -> Result<PropsMap, String> {
        let mut out = Vec::with_capacity(props.len() + literals.len() + exprs.len());
        for (name, src) in props {
            out.push((name.clone(), Bound::Path(Path::parse(src)?, src.clone())));
        }
        for (name, v) in literals {
            out.push((name.clone(), Bound::Lit(v.clone())));
        }
        for (name, src) in exprs {
            let e = compile_expr(src).map_err(|e| format!("child prop {name:?} = {src:?}: {e}"))?;
            out.push((name.clone(), Bound::Expr(Arc::new(e), src.clone())));
        }
        Ok(PropsMap { props: out, rows })
    }

    pub fn eval(&self, parent_ctx: &Node, idx: Option<usize>) -> Result<Node, String> {
        let mut out = MapInner::new();
        let mut scope = None;
        for (name, b) in &self.props {
            let v = match b {
                Bound::Path(p, src) => {
                    if idx.is_none() && p.has_idx() {
                        return Err(format!(
                            "child prop {name:?} = {src:?}: [idx] outside a per-row instance"
                        ));
                    }
                    // F149/F151: a parent path the context lacks is a prop the child does not get (JS
                    // `undefined`, as React passes it), never `null`.
                    match p.find(parent_ctx, idx) {
                        Some(v) => v.clone(),
                        None => continue,
                    }
                }
                Bound::Lit(n) => n.clone(),
                Bound::Expr(e, src) => {
                    let scope = scope.get_or_insert_with(|| self.scope(parent_ctx, idx));
                    let v = e
                        .eval(scope.clone())
                        .map_err(|err| format!("child prop {name:?} = {src:?}: {err}"))?;
                    // An undefined value is a prop the child does not get (JS `undefined`).
                    if v.is_undefined() {
                        continue;
                    }
                    let json = serde_json::to_value(&v)
                        .map_err(|err| format!("child prop {name:?} = {src:?}: {err}"))?;
                    Node::from(json)
                }
            };
            out.insert(Arc::from(name.as_str()), v);
        }
        Ok(Node::map(out))
    }

    /// What an expression reads: `__props` (the parent context), and per row `__row`/`__idx`.
    fn scope(&self, parent_ctx: &Node, idx: Option<usize>) -> Value {
        let mut vars = vec![("__props", parent_ctx.to_value())];
        if let (Some(list), Some(i)) = (&self.rows, idx) {
            let row = list.row(parent_ctx, i);
            vars.push(("__row", row.to_value()));
            vars.push(("__idx", Value::from(i)));
        }
        Value::from_pairs(vars)
    }
}

/// Canonical bytes: serde_json with BTreeMap maps (sorted keys), no whitespace.
pub fn canonical(v: &Node) -> Vec<u8> {
    serde_json::to_vec(v).expect("Node serialises")
}

/// blake3 hex of canonical(inputs_value); `component_id`/`job_id` are mixed in as length-prefixed fields so (a,bc) != (ab,c).
///
/// The hashed bytes are `len(cid) cid len(jid) jid len(json) json` (each
/// length a `u32` LE), laid out in one reused per-thread buffer and hashed in
/// one call: a streaming `Hasher::update` per field (or per serde write)
/// costs more than the copy.
pub fn job_key(component_id: &str, job_id: &str, inputs_value: &Node) -> String {
    thread_local! {
        static BUF: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
    }
    BUF.with_borrow_mut(|buf| {
        buf.clear();
        for field in [component_id.as_bytes(), job_id.as_bytes()] {
            buf.extend_from_slice(&(field.len() as u32).to_le_bytes());
            buf.extend_from_slice(field);
        }
        let at = buf.len();
        buf.extend_from_slice(&[0; 4]);
        serde_json::to_writer(&mut *buf, inputs_value).expect("Node serialises");
        let n = (buf.len() - at - 4) as u32;
        buf[at..at + 4].copy_from_slice(&n.to_le_bytes());
        let key = blake3::hash(buf).to_hex().to_string();
        if buf.capacity() > 64 * 1024 {
            *buf = Vec::new();
        }
        key
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn n(v: serde_json::Value) -> Node {
        Node::from(v)
    }

    /// The one-buffer `job_key` hashes exactly the length-prefixed fields.
    #[test]
    fn job_key_hashes_length_prefixed_fields() {
        let reference = |cid: &str, jid: &str, v: &Node| {
            let mut h = blake3::Hasher::new();
            for field in [cid.as_bytes(), jid.as_bytes(), &canonical(v)] {
                h.update(&(field.len() as u32).to_le_bytes());
                h.update(field);
            }
            h.finalize().to_hex().to_string()
        };
        let big = n(json!({"s": "x".repeat(100_000)}));
        for (c, j, v) in [
            ("typeBadge_5f5390d7", "j0", n(json!({"type": "fire"}))),
            ("a", "bc", Node::Null),
            ("ab", "c", Node::Null),
            ("", "", n(json!({}))),
            ("c", "j0#3", big.clone()),
            ("c", "j0", n(json!([1, "é", {"z": 1, "a": [true]}]))),
        ] {
            assert_eq!(job_key(c, j, &v), reference(c, j, &v), "{c} {j}");
        }
        assert_ne!(
            job_key("a", "bc", &Node::Null),
            job_key("ab", "c", &Node::Null)
        );
    }

    /// The key is a function of the JSON text, whichever tree carries it.
    #[test]
    fn job_key_over_node_equals_job_key_over_serde_json() {
        let reference = |cid: &str, jid: &str, v: &serde_json::Value| {
            let mut h = blake3::Hasher::new();
            for field in [
                cid.as_bytes(),
                jid.as_bytes(),
                &serde_json::to_vec(v).unwrap(),
            ] {
                h.update(&(field.len() as u32).to_le_bytes());
                h.update(field);
            }
            h.finalize().to_hex().to_string()
        };
        for v in [
            json!({"z": 1, "a": [1.5, "é", null, {"y": true, "b": 18446744073709551615u64}]}),
            json!(null),
            json!("s"),
            json!(-7),
        ] {
            assert_eq!(
                job_key("c", "j0", &Node::from(v.clone())),
                reference("c", "j0", &v),
                "{v}"
            );
        }
    }

    #[test]
    fn parse_rejects_empty_and_malformed_paths() {
        for bad in [
            "", "props.", ".a", "a.", "a..b", "a.[0]", "[0].a", "a[0", "a[x]", "a[0]b",
        ] {
            assert!(Path::parse(bad).is_err(), "{bad:?} should be rejected");
        }
        let e = Path::parse("a[0").unwrap_err();
        assert!(e.contains("unclosed"), "{e}");
    }

    #[test]
    fn root_agrees_with_manifest_input_root() {
        for ok in [
            "item",
            "item.price",
            "props.item.price",
            "list[idx].name",
            "a[0][1].b",
            "props",
        ] {
            let p = Path::parse(ok).unwrap();
            assert_eq!(p.root(), crate::manifest::input_root(ok), "{ok:?}");
        }
        assert_eq!(Path(vec![]).root(), "");
        assert_eq!(Path(vec![Seg::Idx]).root(), "");
    }

    #[test]
    fn project_merges_shared_prefix() {
        let c = n(json!({"item":{"id":"p1","name":"Mug","price":3},"user":{"n":"x"}}));
        let ins = [
            "item.price".to_string(),
            "item.name".into(),
            "user.n".into(),
        ];
        assert_eq!(
            project(&c, &ins, None).unwrap(),
            n(json!({"item":{"price":3,"name":"Mug"},"user":{"n":"x"}}))
        );
    }

    #[test]
    fn project_prefix_input_wins_regardless_of_order() {
        let c = n(json!({"list":[{"n":1},{"n":2}],"item":{"a":1,"b":2}}));
        let a = project(
            &c,
            &[
                "list[0].n".into(),
                "list".into(),
                "item".into(),
                "item.a".into(),
            ],
            None,
        );
        let b = project(
            &c,
            &[
                "item.a".into(),
                "list".into(),
                "item".into(),
                "list[0].n".into(),
            ],
            None,
        );
        assert_eq!(
            a.unwrap(),
            n(json!({"list":[{"n":1},{"n":2}],"item":{"a":1,"b":2}}))
        );
        assert_eq!(
            b.unwrap(),
            n(json!({"list":[{"n":1},{"n":2}],"item":{"a":1,"b":2}}))
        );
    }

    #[test]
    fn project_indexes_become_bracketed_keys() {
        let c = n(json!({"a":[{"n":1},{"n":2}]}));
        assert_eq!(
            project(&c, &["a[0].n".into(), "a[1].n".into()], None).unwrap(),
            n(json!({"a":{"[0]":{"n":1},"[1]":{"n":2}}}))
        );
        // `[idx]` keys by content, not row position.
        let r = n(json!({"a":[{"n":7},{"n":7}]}));
        assert_eq!(
            project(&r, &["a[idx].n".into()], Some(0)).unwrap(),
            project(&r, &["a[idx].n".into()], Some(1)).unwrap()
        );
    }

    #[test]
    fn idx_without_row_is_err() {
        let c = n(json!({"a":[1]}));
        assert!(project(&c, &["a[idx]".into()], None).is_err());
        let props = [("x".to_string(), "a[idx]".to_string())]
            .into_iter()
            .collect();
        assert!(child_props(&c, &props, None).is_err());
        assert_eq!(child_props(&c, &props, Some(0)).unwrap(), n(json!({"x":1})));
    }

    #[test]
    fn a_missing_input_stays_absent_and_an_explicit_null_stays_null() {
        // F149/F151 (review F1): nothing the context lacks reaches the job as `null`.
        let ctx =
            n(json!({"a": 1, "n": null, "o": {}, "cfg": {"v": null}, "rows": [{"x": 1}, {}]}));
        let inputs: Vec<String> = [
            "a",         // present
            "n",         // present null stays null
            "gone",      // missing root: absent
            "o.x",       // missing leaf: the object is kept, the leaf unset
            "deep.y",    // missing object on the way: the input is absent
            "cfg.v",     // present null leaf
            "rows[1].x", // missing leaf under an index
            "rows[5].x", // missing index on the way: absent
        ]
        .map(String::from)
        .into();
        assert_eq!(
            project(&ctx, &inputs, None).unwrap(),
            n(json!({"a": 1, "n": null, "o": {}, "cfg": {"v": null}, "rows": {"[1]": {}}}))
        );
        // A child prop bound to a parent path the context lacks is not passed either.
        let props = [("x", "a"), ("y", "gone"), ("z", "n")]
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .into_iter()
            .collect();
        assert_eq!(
            child_props(&ctx, &props, None).unwrap(),
            n(json!({"x": 1, "z": null}))
        );
    }

    #[test]
    fn project_and_child_props_propagate_parse_errors() {
        assert!(project(&n(json!({})), &["a[".into()], None).is_err());
        let props = [("x".to_string(), "".to_string())].into_iter().collect();
        assert!(child_props(&n(json!({})), &props, None).is_err());
    }

    fn map<V: Clone + Into<W>, W>(kv: &[(&str, V)]) -> BTreeMap<String, W> {
        kv.iter()
            .map(|(k, v)| (k.to_string(), v.clone().into()))
            .collect()
    }

    #[test]
    fn child_literals_and_exprs_join_the_props() {
        let ctx = n(json!({"src": "a\nb", "n": 2, "items": [{"code": "x"}, {"code": "y"}]}));
        let pm = PropsMap::child(
            &map(&[("n", "n")]),
            &map(&[("lang", n(json!("ts"))), ("opts", n(json!({"wrap": true})))]),
            &map(&[("code", "(__props.src ~ \"!\")"), ("gone", "__undefined")]),
            None,
        )
        .unwrap();
        assert_eq!(
            pm.eval(&ctx, None).unwrap(),
            n(json!({"n": 2, "lang": "ts", "opts": {"wrap": true}, "code": "a\nb!"}))
        );
        // Per row: `__row` is the row item, `__idx` its index.
        let pm = PropsMap::child(
            &BTreeMap::new(),
            &BTreeMap::new(),
            &map(&[("label", "(__row.code | upper) ~ (__idx | js_string)")]),
            Some(Rows::Path(Path::parse("items").unwrap())),
        )
        .unwrap();
        assert_eq!(pm.eval(&ctx, Some(1)).unwrap(), n(json!({"label": "Y1"})));
        // A constant list the manifest carries (F142 R34.43): rows from the literal, not the context.
        let pm = PropsMap::child(
            &BTreeMap::new(),
            &BTreeMap::new(),
            &map(&[("label", "(__row.code | upper) ~ (__idx | js_string)")]),
            Some(Rows::Literal(n(json!([{"code": "p"}, {"code": "q"}])))),
        )
        .unwrap();
        assert_eq!(pm.eval(&ctx, Some(1)).unwrap(), n(json!({"label": "Q1"})));
        let rows = Rows::Literal(n(json!([1, 2, 3])));
        assert_eq!(rows.count(&ctx), 3);
        assert_eq!(rows.row(&ctx, 5), Node::Null);
        // Distinct literals project to distinct inputs, so distinct job keys (R3.1).
        let a = PropsMap::child(
            &BTreeMap::new(),
            &map(&[("code", json!("a"))]),
            &BTreeMap::new(),
            None,
        )
        .unwrap()
        .eval(&ctx, None)
        .unwrap();
        let b = PropsMap::child(
            &BTreeMap::new(),
            &map(&[("code", json!("b"))]),
            &BTreeMap::new(),
            None,
        )
        .unwrap()
        .eval(&ctx, None)
        .unwrap();
        assert_ne!(job_key("c", "j0", &a), job_key("c", "j0", &b));
    }

    #[test]
    fn a_bad_child_expr_fails_at_construction() {
        let e = PropsMap::child(
            &BTreeMap::new(),
            &BTreeMap::new(),
            &map(&[("x", "(")]),
            None,
        );
        assert!(e.unwrap_err().contains("child prop \"x\""));
    }
}
