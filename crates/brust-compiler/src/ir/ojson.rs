//! JSON with object keys in the ORDER THEY WERE WRITTEN (F282). `serde_json::Value` keeps an object in a `BTreeMap`
//! (sorted by key; the `preserve_order` feature would change that for every crate that links `serde_json`, which is the
//! whole build), so a props object that crosses as JSON lost its source order: a style's declarations, where a later
//! shorthand overrides an earlier longhand (`marginTop: 5, margin: 0`), came out sorted and printed another style than
//! React. This type is the local fix: the IR carries it where a literal crosses to the manifest and the worker, writes
//! it in insertion order, and reads it back in the order of the text.
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Number, Value};
use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum OJson {
    Null,
    Bool(bool),
    Num(Number),
    Str(String),
    Arr(Vec<OJson>),
    /// Keys in source order; a repeated key is one entry, in its first place with its last value.
    Obj(Vec<(String, OJson)>),
}

impl OJson {
    /// The plain `serde_json` value (its objects sorted by key, as `serde_json` keeps them).
    pub fn to_value(&self) -> Value {
        match self {
            OJson::Null => Value::Null,
            OJson::Bool(b) => Value::Bool(*b),
            OJson::Num(n) => Value::Number(n.clone()),
            OJson::Str(s) => Value::String(s.clone()),
            OJson::Arr(a) => Value::Array(a.iter().map(OJson::to_value).collect()),
            OJson::Obj(o) => {
                Value::Object(o.iter().map(|(k, v)| (k.clone(), v.to_value())).collect())
            }
        }
    }

    /// An object from `(key, value)` entries: a repeated key keeps its first place and its last value, as JS does, and
    /// the keys enumerate in JS's own-property order: array-index keys ascending first (`{"10":…,"2":…}` is `2`, `10`),
    /// then the others as they were first set (F321).
    pub fn object(entries: impl IntoIterator<Item = (String, OJson)>) -> OJson {
        let mut out: Vec<(String, OJson)> = Vec::new();
        for (k, v) in entries {
            match out.iter_mut().find(|(o, _)| *o == k) {
                Some(slot) => slot.1 = v,
                None => out.push((k, v)),
            }
        }
        // (stable: the other keys keep their insertion order)
        out.sort_by_key(|(k, _)| array_index(k).map_or((1, 0), |n| (0, n)));
        OJson::Obj(out)
    }
}

/// The canonical array index a property key names (`"0"`, `"7"`, up to `2^32 - 2`), which JS enumerates first, ascending.
fn array_index(k: &str) -> Option<u64> {
    if k.is_empty()
        || k.len() > 10
        || !k.bytes().all(|b| b.is_ascii_digit())
        || (k.len() > 1 && k.starts_with('0'))
    {
        return None;
    }
    k.parse::<u64>().ok().filter(|n| *n < u32::MAX as u64)
}

/// A `serde_json::Value` as an ordered one: its objects keep the order the `Value` iterates (sorted).
impl From<Value> for OJson {
    fn from(v: Value) -> OJson {
        match v {
            Value::Null => OJson::Null,
            Value::Bool(b) => OJson::Bool(b),
            Value::Number(n) => OJson::Num(n),
            Value::String(s) => OJson::Str(s),
            Value::Array(a) => OJson::Arr(a.into_iter().map(OJson::from).collect()),
            Value::Object(o) => {
                OJson::Obj(o.into_iter().map(|(k, v)| (k, OJson::from(v))).collect())
            }
        }
    }
}

/// The read API of `serde_json::Value` the tests (and the manifest checks) use.
static NULL: OJson = OJson::Null;

impl OJson {
    pub fn get(&self, key: &str) -> Option<&OJson> {
        match self {
            OJson::Obj(o) => o.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Vec<OJson>> {
        match self {
            OJson::Arr(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            OJson::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn is_array(&self) -> bool {
        matches!(self, OJson::Arr(_))
    }
}

impl std::ops::Index<&str> for OJson {
    type Output = OJson;
    fn index(&self, key: &str) -> &OJson {
        self.get(key).unwrap_or(&NULL)
    }
}

impl std::ops::Index<usize> for OJson {
    type Output = OJson;
    fn index(&self, i: usize) -> &OJson {
        match self {
            OJson::Arr(a) => a.get(i).unwrap_or(&NULL),
            _ => &NULL,
        }
    }
}

impl fmt::Display for OJson {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&serde_json::to_string(self).map_err(|_| fmt::Error)?)
    }
}

/// An ordered value equals the plain one with the same content (order aside): what the tests compare against `json!`.
impl PartialEq<Value> for OJson {
    fn eq(&self, other: &Value) -> bool {
        self.to_value() == *other
    }
}

impl PartialEq<&str> for OJson {
    fn eq(&self, other: &&str) -> bool {
        matches!(self, OJson::Str(s) if s == other)
    }
}

impl Serialize for OJson {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            OJson::Null => s.serialize_unit(),
            OJson::Bool(b) => s.serialize_bool(*b),
            OJson::Num(n) => n.serialize(s),
            OJson::Str(x) => s.serialize_str(x),
            OJson::Arr(a) => {
                let mut seq = s.serialize_seq(Some(a.len()))?;
                for x in a {
                    seq.serialize_element(x)?;
                }
                seq.end()
            }
            OJson::Obj(o) => {
                let mut map = s.serialize_map(Some(o.len()))?;
                for (k, v) in o {
                    map.serialize_entry(k, v)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for OJson {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<OJson, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = OJson;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_unit<E>(self) -> Result<OJson, E> {
                Ok(OJson::Null)
            }
            fn visit_none<E>(self) -> Result<OJson, E> {
                Ok(OJson::Null)
            }
            fn visit_bool<E>(self, b: bool) -> Result<OJson, E> {
                Ok(OJson::Bool(b))
            }
            fn visit_i64<E>(self, n: i64) -> Result<OJson, E> {
                Ok(OJson::Num(n.into()))
            }
            fn visit_u64<E>(self, n: u64) -> Result<OJson, E> {
                Ok(OJson::Num(n.into()))
            }
            fn visit_f64<E: de::Error>(self, n: f64) -> Result<OJson, E> {
                Number::from_f64(n)
                    .map(OJson::Num)
                    .ok_or_else(|| E::custom("a non-finite number"))
            }
            fn visit_str<E>(self, s: &str) -> Result<OJson, E> {
                Ok(OJson::Str(s.to_string()))
            }
            fn visit_string<E>(self, s: String) -> Result<OJson, E> {
                Ok(OJson::Str(s))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<OJson, A::Error> {
                let mut out = Vec::new();
                while let Some(x) = a.next_element()? {
                    out.push(x);
                }
                Ok(OJson::Arr(out))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<OJson, A::Error> {
                let mut out = Vec::new();
                while let Some((k, v)) = a.next_entry::<String, OJson>()? {
                    out.push((k, v));
                }
                Ok(OJson::object(out))
            }
        }
        d.deserialize_any(V)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The JS array-index rule, as one table shared (by value) with `ir/ojson.rs` / `filters/spread.rs` (F321).
    const INDEX_KEYS: &[(&str, bool)] = &[
        ("0", true),
        ("7", true),
        ("10", true),
        ("4294967294", true),
        ("4294967295", false),
        ("01", false),
        ("-1", false),
        ("1.5", false),
        ("", false),
        ("a", false),
        ("12345678901", false),
    ];

    #[test]
    fn the_array_index_rule_matches_js() {
        for (k, want) in INDEX_KEYS {
            assert_eq!(array_index(k).is_some(), *want, "{k:?}");
        }
    }

    #[test]
    fn an_object_is_written_and_read_in_source_order() {
        let o = OJson::object([
            ("marginTop".to_string(), OJson::Num(5.into())),
            ("margin".to_string(), OJson::Num(0.into())),
            ("color".to_string(), OJson::Str("red".into())),
        ]);
        let text = serde_json::to_string(&o).unwrap();
        assert_eq!(text, r#"{"marginTop":5,"margin":0,"color":"red"}"#);
        // the text read back keeps its order (a `serde_json::Value` would sort it)
        let back: OJson = serde_json::from_str(&text).unwrap();
        assert_eq!(back, o);
        assert_eq!(
            serde_json::to_string(&o.to_value()).unwrap(),
            r#"{"color":"red","margin":0,"marginTop":5}"#
        );
    }

    #[test]
    fn integer_like_keys_come_first_and_ascending_as_in_js() {
        let o = OJson::object(
            ["b", "10", "a", "2", "01", "-1", "1"].map(|k| (k.to_string(), OJson::Null)),
        );
        assert_eq!(
            serde_json::to_string(&o).unwrap(),
            r#"{"1":null,"2":null,"10":null,"b":null,"a":null,"01":null,"-1":null}"#
        );
    }

    #[test]
    fn a_repeated_key_keeps_its_first_place_and_its_last_value() {
        let o = OJson::object([
            ("b".to_string(), OJson::Num(1.into())),
            ("a".to_string(), OJson::Num(2.into())),
            ("b".to_string(), OJson::Num(3.into())),
        ]);
        assert_eq!(serde_json::to_string(&o).unwrap(), r#"{"b":3,"a":2}"#);
    }

    #[test]
    fn every_json_shape_round_trips() {
        let text = r#"{"z":[1,2.5,"x",null,true,{"y":{"b":1,"a":[]}}],"a":-3}"#;
        let o: OJson = serde_json::from_str(text).unwrap();
        assert_eq!(serde_json::to_string(&o).unwrap(), text);
    }
}
