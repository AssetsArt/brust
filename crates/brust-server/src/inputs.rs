//! Job input evaluation (spec S7 step 5): dotted input paths, `[idx]` rows,
//! projection of the values a job reads, and blake3 canonical job keys.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

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
    pub fn get<'v>(&self, ctx: &'v Value, idx: Option<usize>) -> &'v Value {
        static NULL: Value = Value::Null;
        let mut cur = ctx;
        for seg in &self.0 {
            cur = match seg {
                Seg::Key(k) => cur.get(k).unwrap_or(&NULL),
                Seg::Index(i) => cur.get(*i).unwrap_or(&NULL),
                Seg::Idx => match idx {
                    Some(i) => cur.get(i).unwrap_or(&NULL),
                    None => &NULL,
                },
            };
        }
        cur
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
pub fn project(ctx: &Value, inputs: &[String], idx: Option<usize>) -> Result<Value, String> {
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
    pub fn eval(&self, ctx: &Value, idx: Option<usize>) -> Result<Value, String> {
        if idx.is_none()
            && let Some(s) = &self.first_idx
        {
            return Err(format!(
                "input path {s:?}: [idx] outside a per-row instance"
            ));
        }
        let mut out = Map::new();
        for (p, keys) in &self.kept {
            let (last, prefix) = keys.split_last().expect("parsed path is non-empty");
            let mut node = &mut out;
            for k in prefix {
                // Only intermediate objects we created live at prefix positions:
                // a leaf here would mean a shorter input covers `p`, dropped in `new`.
                if !node.contains_key(k) {
                    node.insert(k.clone(), Value::Object(Map::new()));
                }
                node = node
                    .get_mut(k)
                    .and_then(Value::as_object_mut)
                    .expect("projection prefix is an object");
            }
            node.insert(last.clone(), p.get(ctx, idx).clone());
        }
        Ok(Value::Object(out))
    }
}

/// Child props object from the parent's context through `ChildRecord.props` (`[idx]` = row).
///
/// Builds `{ childProp: Path(parentPath).get(parent_ctx, idx) }`. A `[idx]`
/// parent path with `idx == None` is an `Err`.
pub fn child_props(
    parent_ctx: &Value,
    props: &BTreeMap<String, String>,
    idx: Option<usize>,
) -> Result<Value, String> {
    PropsMap::new(props)?.eval(parent_ctx, idx)
}

/// A `props` map (`{ childProp: parent path }`) parsed once (at boot);
/// [`PropsMap::eval`] is [`child_props`] without the parsing.
#[derive(Debug, Clone)]
pub struct PropsMap(Vec<(String, Path, String)>);

impl PropsMap {
    pub fn new(props: &BTreeMap<String, String>) -> Result<PropsMap, String> {
        props
            .iter()
            .map(|(name, src)| Ok((name.clone(), Path::parse(src)?, src.clone())))
            .collect::<Result<_, String>>()
            .map(PropsMap)
    }

    pub fn eval(&self, parent_ctx: &Value, idx: Option<usize>) -> Result<Value, String> {
        let mut out = Map::new();
        for (name, p, src) in &self.0 {
            if idx.is_none() && p.has_idx() {
                return Err(format!(
                    "child prop {name:?} = {src:?}: [idx] outside a per-row instance"
                ));
            }
            out.insert(name.clone(), p.get(parent_ctx, idx).clone());
        }
        Ok(Value::Object(out))
    }
}

/// Canonical bytes: serde_json with BTreeMap maps (sorted keys), no whitespace.
pub fn canonical(v: &Value) -> Vec<u8> {
    serde_json::to_vec(v).expect("Value serialises")
}

/// blake3 hex of canonical(inputs_value); `component_id`/`job_id` are mixed in as length-prefixed fields so (a,bc) != (ab,c).
///
/// The hashed bytes are `len(cid) cid len(jid) jid len(json) json` (each
/// length a `u32` LE), laid out in one reused per-thread buffer and hashed in
/// one call: a streaming `Hasher::update` per field (or per serde write)
/// costs more than the copy.
pub fn job_key(component_id: &str, job_id: &str, inputs_value: &Value) -> String {
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
        serde_json::to_writer(&mut *buf, inputs_value).expect("Value serialises");
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

    /// The one-buffer `job_key` hashes exactly the length-prefixed fields.
    #[test]
    fn job_key_hashes_length_prefixed_fields() {
        let reference = |cid: &str, jid: &str, v: &Value| {
            let mut h = blake3::Hasher::new();
            for field in [cid.as_bytes(), jid.as_bytes(), &canonical(v)] {
                h.update(&(field.len() as u32).to_le_bytes());
                h.update(field);
            }
            h.finalize().to_hex().to_string()
        };
        let big = json!({"s": "x".repeat(100_000)});
        for (c, j, v) in [
            ("typeBadge_5f5390d7", "j0", json!({"type": "fire"})),
            ("a", "bc", json!(null)),
            ("ab", "c", json!(null)),
            ("", "", json!({})),
            ("c", "j0#3", big.clone()),
            ("c", "j0", json!([1, "é", {"z": 1, "a": [true]}])),
        ] {
            assert_eq!(job_key(c, j, &v), reference(c, j, &v), "{c} {j}");
        }
        assert_ne!(
            job_key("a", "bc", &json!(null)),
            job_key("ab", "c", &json!(null))
        );
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
        let c = json!({"item":{"id":"p1","name":"Mug","price":3},"user":{"n":"x"}});
        let ins = [
            "item.price".to_string(),
            "item.name".into(),
            "user.n".into(),
        ];
        assert_eq!(
            project(&c, &ins, None).unwrap(),
            json!({"item":{"price":3,"name":"Mug"},"user":{"n":"x"}})
        );
    }

    #[test]
    fn project_prefix_input_wins_regardless_of_order() {
        let c = json!({"list":[{"n":1},{"n":2}],"item":{"a":1,"b":2}});
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
            json!({"list":[{"n":1},{"n":2}],"item":{"a":1,"b":2}})
        );
        assert_eq!(
            b.unwrap(),
            json!({"list":[{"n":1},{"n":2}],"item":{"a":1,"b":2}})
        );
    }

    #[test]
    fn project_indexes_become_bracketed_keys() {
        let c = json!({"a":[{"n":1},{"n":2}]});
        assert_eq!(
            project(&c, &["a[0].n".into(), "a[1].n".into()], None).unwrap(),
            json!({"a":{"[0]":{"n":1},"[1]":{"n":2}}})
        );
        // `[idx]` keys by content, not row position.
        let r = json!({"a":[{"n":7},{"n":7}]});
        assert_eq!(
            project(&r, &["a[idx].n".into()], Some(0)).unwrap(),
            project(&r, &["a[idx].n".into()], Some(1)).unwrap()
        );
    }

    #[test]
    fn idx_without_row_is_err() {
        let c = json!({"a":[1]});
        assert!(project(&c, &["a[idx]".into()], None).is_err());
        let props = [("x".to_string(), "a[idx]".to_string())]
            .into_iter()
            .collect();
        assert!(child_props(&c, &props, None).is_err());
        assert_eq!(child_props(&c, &props, Some(0)).unwrap(), json!({"x":1}));
    }

    #[test]
    fn project_and_child_props_propagate_parse_errors() {
        assert!(project(&json!({}), &["a[".into()], None).is_err());
        let props = [("x".to_string(), "".to_string())].into_iter().collect();
        assert!(child_props(&json!({}), &props, None).is_err());
    }
}
