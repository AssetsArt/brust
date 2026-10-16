//! The render tree (M3-P P2/P3): what a worker response is parsed INTO, what the
//! pipeline reads and mutates, and what minijinja renders — one conversion, at
//! the parse. Maps are string-keyed and SORTED (`BTreeMap`, exactly
//! `serde_json::Map`'s order, so `{% for k in obj %}`, `keys`, `entries` and
//! `json_attr` paint the bytes the `serde_json::Value` → `value_of` path painted).
//! Maps, arrays and strings sit behind `Arc`s: `to_value` is a refcount bump, a
//! job-cache value merged into a context is shared, and `Arc::make_mut` makes a
//! write to a shared node a copy, never an alias.
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use minijinja::value::{Enumerator, Object, ObjectRepr, Value};
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, Serializer};

pub type MapInner = BTreeMap<Arc<str>, Node>;

#[derive(Debug, Clone, PartialEq, Default)]
pub enum Node {
    #[default]
    Null,
    Bool(bool),
    Num(serde_json::Number),
    Str(Arc<str>),
    Arr(Arc<CtxArr>),
    Map(Arc<CtxMap>),
}

/// A string-keyed, sorted map: a minijinja `Object` with repr `Map`.
///
/// F318: the second field is the order the keys had in the parsed JSON text, kept ONLY when it differs from the sorted
/// one (`None` for a map that arrived sorted, which is every map built in Rust). The worker writes its objects with
/// `JSON.stringify`, so the text order is JS's own, and it decides what React prints for a style object (a later
/// shorthand overrides an earlier longhand). Lookups, `{% for %}`, `keys` and `entries` stay SORTED (the server's own
/// logic and the byte-compatibility with the `serde_json` path rely on it); only [`CtxMap::each_ordered`] reads the
/// hint: the `json_attr` writer and the style printers. The hint is the keys in text order joined by `\0` (one
/// allocation, no refcounts, so parsing a response whose objects are unsorted stays cheap); an object with a `\0` in a
/// key carries no hint (sorted). A key written after the parse (a map edited in place) is not in
/// it and follows the hinted ones, sorted.
#[derive(Debug, Clone, Default)]
pub struct CtxMap(pub MapInner, pub Option<Box<str>>);

impl PartialEq for CtxMap {
    /// The content, not the text order: two maps with the same entries are equal.
    fn eq(&self, other: &CtxMap) -> bool {
        self.0 == other.0
    }
}

impl CtxMap {
    /// Calls `f` for every entry in the order the JSON text gave (see the type's docs), the sorted order when there is
    /// no hint. No allocation.
    pub fn each_ordered<'a>(&'a self, mut f: impl FnMut(&'a Arc<str>, &'a Node)) {
        let Some(order) = &self.1 else {
            for (k, v) in &self.0 {
                f(k, v);
            }
            return;
        };
        let mut seen = 0;
        for k in order.split('\0') {
            if let Some((k, v)) = self.0.get_key_value(k) {
                f(k, v);
                seen += 1;
            }
        }
        if seen < self.0.len() {
            for (k, v) in &self.0 {
                if !order.split('\0').any(|o| o == &**k) {
                    f(k, v);
                }
            }
        }
    }
}

/// A list: a minijinja `Object` with repr `Seq`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CtxArr(pub Vec<Node>);

impl Node {
    pub fn map(m: MapInner) -> Node {
        Node::Map(Arc::new(CtxMap(m, None)))
    }
    pub fn arr(v: Vec<Node>) -> Node {
        Node::Arr(Arc::new(CtxArr(v)))
    }
    pub fn str(s: &str) -> Node {
        Node::Str(Arc::from(s))
    }
    pub fn get(&self, key: &str) -> Option<&Node> {
        match self {
            Node::Map(m) => m.0.get(key),
            _ => None,
        }
    }
    pub fn index(&self, i: usize) -> Option<&Node> {
        match self {
            Node::Arr(a) => a.0.get(i),
            _ => None,
        }
    }
    pub fn as_map(&self) -> Option<&CtxMap> {
        if let Node::Map(m) = self {
            Some(m)
        } else {
            None
        }
    }
    pub fn as_arr(&self) -> Option<&CtxArr> {
        if let Node::Arr(a) = self {
            Some(a)
        } else {
            None
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        if let Node::Str(s) = self {
            Some(s)
        } else {
            None
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Node::Null)
    }
    pub fn is_map(&self) -> bool {
        matches!(self, Node::Map(_))
    }
    pub fn is_str(&self) -> bool {
        matches!(self, Node::Str(_))
    }
    /// The map for writing: in place while this node is the only owner, a
    /// copy (of this level only) when it is shared — a cached value merged
    /// into a context is never written through.
    pub fn map_mut(&mut self) -> Option<&mut MapInner> {
        match self {
            Node::Map(m) => Some(&mut Arc::make_mut(m).0),
            _ => None,
        }
    }
    /// The list for writing (same copy-on-write rule as [`Node::map_mut`]).
    pub fn arr_mut(&mut self) -> Option<&mut Vec<Node>> {
        match self {
            Node::Arr(a) => Some(&mut Arc::make_mut(a).0),
            _ => None,
        }
    }
    /// The node at `path` (map keys), for writing; every map on the way is
    /// made unique (copy-on-write when shared).
    pub fn get_mut_path(&mut self, path: &[&str]) -> Option<&mut Node> {
        let mut cur = self;
        for k in path {
            cur = cur.map_mut()?.get_mut(*k)?;
        }
        Some(cur)
    }
    /// The minijinja value: the reprs `value_of` produces for the same JSON
    /// (`serialize.rs`: u64 → U64, i64 → I64, f64 → F64, str → String, unit → None).
    pub fn to_value(&self) -> Value {
        match self {
            Node::Null => Value::from(()),
            Node::Bool(b) => Value::from(*b),
            Node::Num(n) => {
                if let Some(u) = n.as_u64() {
                    Value::from(u)
                } else if let Some(i) = n.as_i64() {
                    Value::from(i)
                } else {
                    Value::from(n.as_f64().unwrap_or(f64::NAN))
                }
            }
            Node::Str(s) => Value::from(Arc::clone(s)),
            Node::Arr(a) => Value::from_dyn_object(Arc::clone(a)),
            Node::Map(m) => Value::from_dyn_object(Arc::clone(m)),
        }
    }
    /// `map` minus its `hidden` top-level keys, as a value (O(1); no copy).
    pub fn view(map: &Arc<CtxMap>, hidden: &'static [&'static str]) -> Value {
        Value::from_object(MapView {
            map: Arc::clone(map),
            hidden,
        })
    }
}

impl Object for CtxMap {
    fn repr(self: &Arc<Self>) -> ObjectRepr {
        ObjectRepr::Map
    }
    fn get_value(self: &Arc<Self>, key: &Value) -> Option<Value> {
        self.get_value_by_str(key.as_str()?)
    }
    /// The engine's root-scope and `a.b` lookups come here (no key `Value`).
    fn get_value_by_str(self: &Arc<Self>, key: &str) -> Option<Value> {
        self.0.get(key).map(Node::to_value)
    }
    fn enumerate(self: &Arc<Self>) -> Enumerator {
        Enumerator::Values(self.0.keys().map(|k| Value::from(Arc::clone(k))).collect())
    }
    fn enumerator_len(self: &Arc<Self>) -> Option<usize> {
        Some(self.0.len())
    }
}

impl Object for CtxArr {
    fn repr(self: &Arc<Self>) -> ObjectRepr {
        ObjectRepr::Seq
    }
    fn get_value(self: &Arc<Self>, key: &Value) -> Option<Value> {
        // Mirror minijinja's own Seq objects: a non-index key is None; the
        // engine normalises negative indices before asking.
        self.0.get(key.as_usize()?).map(Node::to_value)
    }
    fn enumerate(self: &Arc<Self>) -> Enumerator {
        Enumerator::Seq(self.0.len())
    }
    fn enumerator_len(self: &Arc<Self>) -> Option<usize> {
        Some(self.0.len())
    }
}

/// A map minus some top-level keys (`_props` = the context minus the server's
/// `__children`/`__own`). Downcast by `json_attr` to write straight from the tree.
#[derive(Debug)]
pub struct MapView {
    pub(crate) map: Arc<CtxMap>,
    pub(crate) hidden: &'static [&'static str],
}

impl MapView {
    fn shown(&self, k: &str) -> bool {
        !self.hidden.contains(&k)
    }
}

impl Object for MapView {
    fn repr(self: &Arc<Self>) -> ObjectRepr {
        ObjectRepr::Map
    }
    fn get_value(self: &Arc<Self>, key: &Value) -> Option<Value> {
        self.get_value_by_str(key.as_str()?)
    }
    fn get_value_by_str(self: &Arc<Self>, key: &str) -> Option<Value> {
        if !self.shown(key) {
            return None;
        }
        self.map.0.get(key).map(Node::to_value)
    }
    fn enumerate(self: &Arc<Self>) -> Enumerator {
        Enumerator::Values(
            self.map
                .0
                .keys()
                .filter(|k| self.shown(k))
                .map(|k| Value::from(Arc::clone(k)))
                .collect(),
        )
    }
    fn enumerator_len(self: &Arc<Self>) -> Option<usize> {
        Some(self.map.0.keys().filter(|k| self.shown(k)).count())
    }
}

// ---- json_attr fast path (byte-identical to the one-pass writer: sorted keys,
// no undefined, serde_json's number text) ----

pub(crate) fn write_node(out: &mut String, n: &Node) {
    use std::fmt::Write as _;
    match n {
        Node::Null => out.push_str("null"),
        Node::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        // serde_json::Number's Display is the serializer's itoa/ryu text (the
        // existing one-pass number arm already relies on it).
        Node::Num(x) => {
            let _ = write!(out, "{x}");
        }
        Node::Str(s) => crate::write_json_attr_str(out, s),
        Node::Arr(a) => write_arr(out, a),
        Node::Map(m) => write_map(out, m, &[]),
    }
}

pub(crate) fn write_arr(out: &mut String, a: &CtxArr) {
    out.push('[');
    for (i, x) in a.0.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_node(out, x);
    }
    out.push(']');
}

pub(crate) fn write_map(out: &mut String, m: &CtxMap, hidden: &[&str]) {
    out.push('{');
    let mut first = true;
    m.each_ordered(|k, v| {
        if hidden.contains(&&**k) {
            return;
        }
        if !first {
            out.push(',');
        }
        first = false;
        crate::write_json_attr_str(out, k);
        out.push(':');
        write_node(out, v);
    });
    out.push('}');
}

// ---- serde ----

impl Serialize for Node {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Node::Null => s.serialize_unit(),
            Node::Bool(b) => s.serialize_bool(*b),
            Node::Num(n) => n.serialize(s),
            Node::Str(x) => s.serialize_str(x),
            Node::Arr(a) => s.collect_seq(a.0.iter()),
            Node::Map(m) => s.collect_map(m.0.iter().map(|(k, v)| (&**k, v))),
        }
    }
}

/// A node serialised in the order its objects had in the JSON text they were parsed from (F318): what a job's inputs
/// need so the worker's `JSON.stringify` and React see the loader's own key order (a style's declaration order decides
/// the cascade). [`Node`]'s own `Serialize` stays SORTED: it is the canonical form job cache keys hash.
pub struct Ordered<'a>(pub &'a Node);

impl Serialize for Ordered<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            Node::Arr(a) => s.collect_seq(a.0.iter().map(Ordered)),
            Node::Map(m) => {
                let mut entries: Vec<(&str, Ordered<'_>)> = Vec::with_capacity(m.0.len());
                m.each_ordered(|k, v| entries.push((&**k, Ordered(v))));
                s.collect_map(entries)
            }
            other => other.serialize(s),
        }
    }
}

/// A map key: one allocation, straight into the `Arc`.
struct Key(Arc<str>);

impl<'de> Deserialize<'de> for Key {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct KeyVisitor;
        impl Visitor<'_> for KeyVisitor {
            type Value = Key;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a string key")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Key, E> {
                Ok(Key(Arc::from(v)))
            }
        }
        d.deserialize_str(KeyVisitor)
    }
}

struct NodeVisitor;

impl<'de> Visitor<'de> for NodeVisitor {
    type Value = Node;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any valid JSON value")
    }
    fn visit_bool<E>(self, v: bool) -> Result<Node, E> {
        Ok(Node::Bool(v))
    }
    fn visit_i64<E>(self, v: i64) -> Result<Node, E> {
        Ok(Node::Num(v.into()))
    }
    fn visit_u64<E>(self, v: u64) -> Result<Node, E> {
        Ok(Node::Num(v.into()))
    }
    fn visit_f64<E>(self, v: f64) -> Result<Node, E> {
        // As serde_json::Value's visitor: a non-finite float is null.
        Ok(serde_json::Number::from_f64(v).map_or(Node::Null, Node::Num))
    }
    fn visit_str<E>(self, v: &str) -> Result<Node, E> {
        Ok(Node::str(v))
    }
    fn visit_string<E>(self, v: String) -> Result<Node, E> {
        Ok(Node::Str(Arc::from(v)))
    }
    fn visit_unit<E>(self) -> Result<Node, E> {
        Ok(Node::Null)
    }
    fn visit_none<E>(self) -> Result<Node, E> {
        Ok(Node::Null)
    }
    fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Node, D::Error> {
        Node::deserialize(d)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Node, A::Error> {
        let mut v = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(4096));
        while let Some(x) = seq.next_element()? {
            v.push(x);
        }
        Ok(Node::arr(v))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Node, A::Error> {
        let mut m = MapInner::new();
        // F318: the text order, recorded only once a key breaks the sorted order (the keys so far were ascending, so
        // they are exactly the map's keys at that point). A repeated key keeps its first place, its last value. The
        // sorted case (a key above the map's last) costs one comparison against the last key, nothing else.
        let mut order: Option<String> = None;
        let mut pushed = 0usize;
        let mut skip = false; // a key holds the separator: no hint for this object
        while let Some((Key(k), v)) = map.next_entry::<Key, Node>()? {
            match &mut order {
                Some(o) => {
                    // a repeated key is pushed too; the end of the object drops the repeats
                    skip |= k.contains('\0');
                    o.push('\0');
                    o.push_str(&k);
                    pushed += 1;
                }
                None => {
                    if let Some((last, _)) = m.last_key_value()
                        && **last >= *k
                        && **last != *k
                    {
                        let mut o = String::with_capacity(64);
                        for (i, key) in m.keys().enumerate() {
                            skip |= key.contains('\0');
                            if i > 0 {
                                o.push('\0');
                            }
                            o.push_str(key);
                        }
                        if !m.contains_key(&k) {
                            skip |= k.contains('\0');
                            o.push('\0');
                            o.push_str(&k);
                        }
                        pushed = m.len() + usize::from(!m.contains_key(&k));
                        order = Some(o);
                    }
                    // (a repeat of the last key keeps the sorted order: its place is the same)
                }
            }
            // Last value wins on a repeated key, as serde_json::Map does.
            m.insert(k, v);
        }
        // Repeats (a key written twice) keep their first place: only an object that repeated pays this.
        if let Some(o) = &mut order
            && pushed != m.len()
        {
            let mut seen = std::collections::HashSet::new();
            *o = o
                .split('\0')
                .filter(|k| seen.insert(*k))
                .collect::<Vec<_>>()
                .join("\0");
        }
        let order = order.filter(|_| !skip).map(String::into_boxed_str);
        Ok(Node::Map(Arc::new(CtxMap(m, order))))
    }
}

impl<'de> Deserialize<'de> for Node {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(NodeVisitor)
    }
}

impl From<serde_json::Value> for Node {
    fn from(v: serde_json::Value) -> Node {
        use serde_json::Value as J;
        match v {
            J::Null => Node::Null,
            J::Bool(b) => Node::Bool(b),
            J::Number(n) => Node::Num(n),
            J::String(s) => Node::Str(Arc::from(s)),
            J::Array(a) => Node::arr(a.into_iter().map(Node::from).collect()),
            J::Object(o) => Node::map(
                o.into_iter()
                    .map(|(k, v)| (Arc::from(k), v.into()))
                    .collect(),
            ),
        }
    }
}

impl From<&Node> for serde_json::Value {
    fn from(n: &Node) -> serde_json::Value {
        use serde_json::Value as J;
        match n {
            Node::Null => J::Null,
            Node::Bool(b) => J::Bool(*b),
            Node::Num(x) => J::Number(x.clone()),
            Node::Str(s) => J::String(s.to_string()),
            Node::Arr(a) => J::Array(a.0.iter().map(J::from).collect()),
            Node::Map(m) => J::Object(
                m.0.iter()
                    .map(|(k, v)| (k.to_string(), J::from(v)))
                    .collect(),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_support::{Rng, gen_json, gen_number_json as gen_number};
    use minijinja::Environment;
    use serde_json::json;

    fn env() -> Environment<'static> {
        let mut env = Environment::new();
        crate::register(&mut env);
        env
    }

    /// The two conversions of the same JSON paint the same bytes for a battery
    /// of template shapes: iteration order, lookups, indexing, filters, equality.
    const BATTERY: &[&str] = &[
        "{% for k in o %}{{ k }}={{ o[k] | json_attr }};{% endfor %}",
        "{% for k, v in o | items %}{{ k }}:{{ v | js_string }},{% endfor %}",
        "{{ o | keys | join(',') }}|{{ (o | entries) | json_attr }}|{{ o | length }}|{{ l | length }}",
        "{{ o | json_attr }}|{{ l | json_attr }}|{{ s | json_attr }}|{{ n | json_attr }}|{{ b | json_attr }}|{{ z | json_attr }}",
        "{{ o.a | e }}|{{ o['a'] | e }}|{{ o.missing.deep | e }}|{{ l[0] | e }}|{{ l[-1] | e }}|{{ l[9] | e }}|{{ o.a.b.c | e }}",
        "{{ s | e }}|{{ s | attr_str }}|{{ s | js_string }}|{{ n | js_string }}|{{ n | attr_str }}|{{ n | e }}|{{ b | js_string }}|{{ z | js_string }}",
        "{% if 'a' in o %}y{% endif %}{% if o %}t{% endif %}{% if l %}t{% endif %}{% if o == o %}eq{% endif %}{% if l | includes(1) %}inc{% endif %}{% if s | includes('x') %}sx{% endif %}",
        "{{ o is defined }}|{{ o.a is defined }}|{{ o.nope is defined }}|{{ (o | keys) | length }}|{{ l | join('-') }}|{{ s | str_slice(1) }}",
        "{{ sty | style_css }}|{{ sty | keys | join }}|{{ o | truthy }}|{{ z | present }}|{{ b | present }}",
        "{% for x in l %}{{ loop.index0 }}:{{ x | json_attr }}/{% endfor %}{% for x in o.l2 %}{{ x.k | e }}{% endfor %}",
    ];

    fn sample_json(r: &mut Rng) -> serde_json::Value {
        // Keys deliberately unsorted; every number form; unicode; nested maps/lists; empty containers.
        json!({
            "zeta": gen_json(r, 3), "alpha": gen_json(r, 3), "Mid": gen_json(r, 2),
            "o": {"b": 2, "a": {"b": {"c": gen_json(r, 1)}}, "A": "<&'\">", "l2": [{"k": "x"}, {"k": gen_json(r, 0)}], "_": null},
            "l": [1, "two", 3.5, null, true, {"z": 1, "a": [1e21, 1e-7, -0.0, 0.1, 18446744073709551615u64, -9223372036854775808i64, 1.0]}],
            "s": "ไทย<é>😀&'\"\u{7f}\u{2028}", "n": gen_number(r), "b": true, "z": null,
            "sty": {"fontSize": 12, "backgroundColor": "red", "zIndex": 2, "bad;": "x", "margin": 0, "color": null}
        })
    }

    #[test]
    fn node_renders_like_value_of_for_every_json_shape() {
        let env = env();
        let mut r = Rng(0x1234_5678_9ABC_DEF1);
        for i in 0..400 {
            let json = sample_json(&mut r);
            let node = Node::from(json.clone());
            for (t, src) in BATTERY.iter().enumerate() {
                let want = env.render_str(src, crate::value_of(&json)).unwrap();
                let got = env.render_str(src, node.to_value()).unwrap();
                assert_eq!(got, want, "#{i} template {t}: {src}\n{json}");
            }
        }
    }

    /// F318: an object parsed from the worker's JSON text keeps the text order for the two printers that React's order
    /// decides (`json_attr` crossing to the client, the style printers); iteration stays sorted.
    #[test]
    fn a_parsed_object_keeps_its_text_order_for_json_and_style_but_iterates_sorted() {
        let n: Node = serde_json::from_str(
            r#"{"style":{"marginTop":5,"margin":0,"color":"red"},"o":{"b":1,"a":2}}"#,
        )
        .unwrap();
        let env = env();
        let ctx = n.to_value();
        // crossing as JSON: the text order
        assert_eq!(
            env.render_str("{{ style | json_attr }}", ctx.clone())
                .unwrap(),
            "{&quot;marginTop&quot;:5,&quot;margin&quot;:0,&quot;color&quot;:&quot;red&quot;}"
        );
        // printed as a style attribute: the longhand first, so `margin: 0` wins as in React
        assert_eq!(
            env.render_str("{{ style | style_attr }}", ctx.clone())
                .unwrap(),
            " style=\"margin-top:5px;margin:0;color:red\""
        );
        assert_eq!(
            env.render_str("{{ style | style_css }}", ctx.clone())
                .unwrap(),
            "margin-top:5px;margin:0;color:red"
        );
        // `{% for %}` and lookups stay sorted; `keys` / `entries` (Object.keys / Object.entries) follow the JS (text) order
        // json_attr sends, so server, client and React iterate alike (F318 F1)
        assert_eq!(
            env.render_str("{% for k in o %}{{ k }}{% endfor %}|{{ style.margin }}|{{ style | keys | join(',') }}|{% for p in style | entries %}{{ p[0] }}={{ p[1] }};{% endfor %}", ctx.clone())
                .unwrap(),
            "ab|0|marginTop,margin,color|marginTop=5;margin=0;color=red;"
        );
        // a spread of a runtime object keeps its order too (F2): obj_assign over a parsed style
        assert_eq!(
            env.render_str(
                "{{ obj_assign(style, obj_lit('position', 'absolute')) | style_attr }}",
                ctx.clone()
            )
            .unwrap(),
            " style=\"margin-top:5px;margin:0;color:red;position:absolute\""
        );
        // a map that arrived sorted has no hint; a repeated key keeps its first place and its last value
        let sorted: Node = serde_json::from_str(r#"{"a":1,"b":2}"#).unwrap();
        assert!(sorted.as_map().unwrap().1.is_none());
        // a repeat of an EARLIER key (not the last): first place, last value, no duplicate in the order
        let dup2: Node = serde_json::from_str(r#"{"a":1,"b":2,"a":3,"c":4}"#).unwrap();
        assert_eq!(
            env.render_str(
                "{{ d | json_attr }}",
                minijinja::context! { d => dup2.to_value() }
            )
            .unwrap(),
            "{&quot;a&quot;:3,&quot;b&quot;:2,&quot;c&quot;:4}"
        );
        // a key holding the separator carries no hint (sorted)
        let nul: Node = serde_json::from_str(r#"{"b\u0000x":1,"a":2}"#).unwrap();
        assert!(nul.as_map().unwrap().1.is_none());
        let dup: Node = serde_json::from_str(r#"{"b":1,"a":2,"b":3}"#).unwrap();
        assert_eq!(
            env.render_str(
                "{{ d | json_attr }}",
                minijinja::context! { d => dup.to_value() }
            )
            .unwrap(),
            "{&quot;b&quot;:3,&quot;a&quot;:2}"
        );
        // a key written after the parse follows the hinted ones
        let mut edited: Node = serde_json::from_str(r#"{"z":1,"m":2}"#).unwrap();
        edited
            .map_mut()
            .unwrap()
            .insert(Arc::from("a"), Node::Num(3.into()));
        assert_eq!(
            env.render_str(
                "{{ d | json_attr }}",
                minijinja::context! { d => edited.to_value() }
            )
            .unwrap(),
            "{&quot;z&quot;:1,&quot;m&quot;:2,&quot;a&quot;:3}"
        );
        // equality is the content, not the order
        let other: Node = serde_json::from_str(r#"{"a":2,"b":1}"#).unwrap();
        let again: Node = serde_json::from_str(r#"{"b":1,"a":2}"#).unwrap();
        assert_eq!(other, again);
    }

    #[test]
    fn maps_iterate_in_serde_json_order_and_lookups_are_string_keyed() {
        let n: Node =
            serde_json::from_str(r#"{"zeta":1,"alpha":{"y":1,"x":2},"Mid":[3,2,1]}"#).unwrap();
        let keys: Vec<&str> = n.as_map().unwrap().0.keys().map(|k| &**k).collect();
        assert_eq!(keys, ["Mid", "alpha", "zeta"]); // byte order, as serde_json::Map
        assert_eq!(
            n.get("alpha").and_then(|a| a.get("x")),
            Some(&Node::Num(2.into()))
        );
        assert_eq!(
            n.get("Mid").and_then(|m| m.index(2)),
            Some(&Node::Num(1.into()))
        );
        assert_eq!(n.get("nope"), None);
        assert_eq!(n.index(0), None, "a map is not indexable");
        let v = n.to_value();
        assert_eq!(v.get_attr("zeta").unwrap(), minijinja::Value::from(1u64));
        assert!(v.get_attr("nope").unwrap().is_undefined());
        assert_eq!(
            v.get_attr("Mid").unwrap().get_item_by_index(0).unwrap(),
            minijinja::Value::from(3u64)
        );
        assert_eq!(v.get_attr("Mid").unwrap().len(), Some(3));
    }

    #[test]
    fn to_value_is_an_arc_bump_and_make_mut_copies_only_when_shared() {
        let mut n: Node = serde_json::from_str(r#"{"a":{"b":[1,2]}}"#).unwrap();
        let Node::Map(root) = &n else { unreachable!() };
        assert_eq!(Arc::strong_count(root), 1);
        let v = n.to_value();
        let Node::Map(root) = &n else { unreachable!() };
        assert_eq!(Arc::strong_count(root), 2, "to_value shares the map");
        drop(v);
        // Unique again: mutation is in place.
        let a_ptr = Arc::as_ptr(match n.get("a") {
            Some(Node::Map(a)) => a,
            _ => unreachable!(),
        });
        n.map_mut().unwrap().insert("c".into(), Node::Null);
        assert_eq!(
            Arc::as_ptr(match n.get("a") {
                Some(Node::Map(a)) => a,
                _ => unreachable!(),
            }),
            a_ptr
        );
        // Shared with a "cache": the shared subtree is copied on write, the cache's copy untouched.
        let cached = n.get("a").cloned().unwrap();
        n.get_mut_path(&["a", "b"])
            .unwrap()
            .arr_mut()
            .unwrap()
            .push(Node::Null);
        assert_eq!(serde_json::Value::from(&cached), json!({"b": [1, 2]}));
        assert_eq!(
            serde_json::Value::from(n.get("a").unwrap()),
            json!({"b": [1, 2, null]})
        );
    }

    #[test]
    fn json_attr_over_node_matches_the_three_pass_reference() {
        let env = env();
        let mut r = Rng(0x9E37_79B9_7F4A_7C15);
        for i in 0..5_000 {
            let json = gen_json(&mut r, 4);
            let node = Node::from(json.clone());
            let via_node = env
                .render_str(
                    "{{ v | json_attr }}",
                    minijinja::context! { v => node.to_value() },
                )
                .unwrap();
            let reference = env
                .render_str(
                    "{{ v | json_attr }}",
                    minijinja::context! { v => crate::value_of(&json) },
                )
                .unwrap();
            assert_eq!(via_node, reference, "#{i}: {json}");
            // The attribute text decodes to the original JSON (as serde_json
            // parses its own text: without `float_roundtrip` its float parse
            // may land one ULP off, on both sides alike).
            let back: serde_json::Value =
                serde_json::from_str(&crate::tests_support::unescape(&via_node)).unwrap();
            let canon: serde_json::Value =
                serde_json::from_str(&serde_json::to_string(&json).unwrap()).unwrap();
            assert_eq!(back, canon);
        }
        // Every C0 control, the JSON and attribute specials, the key path.
        let all: String = (0u8..0x80).map(char::from).collect::<String>() + "é😀\u{2028}";
        let json = json!({ all.clone(): all, "k\"<>&'": [all] });
        assert_eq!(
            env.render_str(
                "{{ v | json_attr }}",
                minijinja::context! { v => Node::from(json.clone()).to_value() }
            )
            .unwrap(),
            env.render_str(
                "{{ v | json_attr }}",
                minijinja::context! { v => crate::value_of(&json) }
            )
            .unwrap()
        );
    }

    #[test]
    fn map_view_hides_top_level_keys_only() {
        let n: Node = serde_json::from_str(
            r#"{"__own":{"p":1},"__children":{},"name":"<a>","nested":{"__own":2}}"#,
        )
        .unwrap();
        let Node::Map(m) = &n else { unreachable!() };
        let v = Node::view(m, &["__own", "__children"]);
        let env = env();
        let out = env.render_str(
            "{{ v | json_attr }}|{{ v.__own is defined }}|{{ v.name | e }}|{{ v | length }}|{% for k in v %}{{ k }},{% endfor %}|{{ 'name' in v }}|{{ '__own' in v }}",
            minijinja::context! { v => v },
        ).unwrap();
        assert_eq!(
            out,
            "{&quot;name&quot;:&quot;&lt;a&gt;&quot;,&quot;nested&quot;:{&quot;__own&quot;:2}}|False|&lt;a&gt;|2|name,nested,|True|False"
        );
    }

    #[test]
    fn serde_round_trip_and_json_conversions_are_lossless() {
        let text = r#"{"a":[1,-2,3.5,1e21,1e-7,0.1,true,false,null,"s",{"b":{}},[]],"n":18446744073709551615,"m":-9223372036854775808}"#;
        let node: Node = serde_json::from_str(text).unwrap();
        let json: serde_json::Value = serde_json::from_str(text).unwrap();
        assert_eq!(
            serde_json::to_string(&node).unwrap(),
            serde_json::to_string(&json).unwrap()
        );
        assert_eq!(Node::from(json.clone()), node);
        assert_eq!(serde_json::Value::from(&node), json);
        // A repeated key keeps its last value, as serde_json::Map does.
        let n: Node = serde_json::from_str(r#"{"a":1,"a":2}"#).unwrap();
        assert_eq!(n.get("a"), Some(&Node::Num(2.into())));
    }
}
