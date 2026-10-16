//! The constant folder (shadcn S1, R34.49): an interpreter for a closed subset of expressions, run on
//! the IR at compile time. It never runs user code: every production is spelled out here, and
//! anything else is `Err(construct)`, which the caller turns into a fail-closed message that names
//! the construct (so the next widening is data-driven).
//!
//! The subset: literals, templates, `+ - * / %`, unary `- + !`, comparisons, `&& || ??`, `?:`,
//! member and index reads on folded objects and arrays (`item.title`, `a[0]`, `a.length`, `s.length`),
//! array and object literals, `Array.from({ length: N })` (optionally with a callback), and
//! `.map(cb)` on a folded array where `cb` is an arrow with an expression body. Names resolve to
//! the callback parameters the folder bound, then to a module `const` (folded in turn, memoised,
//! cycle-safe). Numbers print as JS prints them or the fold fails.
use super::expr::{ArrowBody, BinOp, IdentKind, Literal, RawExpr, RawKind, UnOp};
use serde_json::Value;
use std::collections::HashMap;

/// Most elements `Array.from({ length })` makes.
pub const MAX_FROM_LENGTH: f64 = 10_000.0;
/// Most expression nodes one fold session evaluates (a compile-time bound, not a language limit).
pub const MAX_STEPS: u32 = 200_000;
/// Deepest module-const chain and expression nesting one fold follows.
const MAX_DEPTH: u32 = 64;

/// A folded value. `Undef` exists so a `.map` callback can bind `_` and a missing member can read as
/// JS reads it; it is not JSON, so [`V::to_json`] refuses it.
#[derive(Debug, Clone, PartialEq)]
pub enum V {
    Undef,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<V>),
    Obj(Vec<(String, V)>),
}

impl V {
    /// The JSON value, `None` when any part is `undefined` or a non-finite number.
    pub fn to_json(&self) -> Option<Value> {
        Some(match self {
            V::Undef => return None,
            V::Null => Value::Null,
            V::Bool(b) => Value::Bool(*b),
            V::Num(n) => num_json(*n)?,
            V::Str(s) => Value::String(s.clone()),
            V::Arr(a) => Value::Array(a.iter().map(V::to_json).collect::<Option<_>>()?),
            V::Obj(o) => {
                let mut m = serde_json::Map::new();
                for (k, v) in o {
                    m.insert(k.clone(), v.to_json()?);
                }
                Value::Object(m)
            }
        })
    }

    /// [`V::to_json`], objects in source order (F282); `None` in the same cases.
    pub fn to_ojson(&self) -> Option<crate::ir::OJson> {
        use crate::ir::OJson;
        Some(match self {
            V::Undef => return None,
            V::Null => OJson::Null,
            V::Bool(b) => OJson::Bool(*b),
            V::Num(n) => OJson::from(num_json(*n)?),
            V::Str(s) => OJson::Str(s.clone()),
            V::Arr(a) => OJson::Arr(a.iter().map(V::to_ojson).collect::<Option<_>>()?),
            V::Obj(o) => OJson::object(
                o.iter()
                    .map(|(k, v)| Some((k.clone(), v.to_ojson()?)))
                    .collect::<Option<Vec<_>>>()?,
            ),
        })
    }

    /// The value as a JS literal, key order kept (F149: a folded `cva(...)` config re-emitted for
    /// build evaluation); `None` when any part is `undefined` or a number JS would print otherwise.
    pub fn to_js(&self) -> Option<String> {
        Some(match self {
            V::Undef => return None,
            V::Null => "null".into(),
            V::Bool(b) => b.to_string(),
            V::Num(n) => js_num_str(*n)?,
            V::Str(s) => crate::ir::expr::js_string(s),
            V::Arr(a) => format!(
                "[{}]",
                a.iter()
                    .map(V::to_js)
                    .collect::<Option<Vec<_>>>()?
                    .join(", ")
            ),
            V::Obj(o) => format!(
                "{{ {} }}",
                o.iter()
                    .map(|(k, v)| Some(format!(
                        "{}: {}",
                        crate::ir::expr::js_string(k),
                        v.to_js()?
                    )))
                    .collect::<Option<Vec<_>>>()?
                    .join(", ")
            ),
        })
    }

    /// JS truthiness.
    pub fn truthy(&self) -> bool {
        match self {
            V::Undef | V::Null => false,
            V::Bool(b) => *b,
            V::Num(n) => *n != 0.0 && !n.is_nan(),
            V::Str(s) => !s.is_empty(),
            V::Arr(_) | V::Obj(_) => true,
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            V::Undef => "undefined",
            V::Null => "null",
            V::Bool(_) => "a boolean",
            V::Num(_) => "a number",
            V::Str(_) => "a string",
            V::Arr(_) => "an array",
            V::Obj(_) => "an object",
        }
    }

    /// JS `String(v)` for the primitives (templates, `+`); `None` for arrays and objects.
    fn to_js_string(&self) -> Option<String> {
        Some(match self {
            V::Undef => "undefined".into(),
            V::Null => "null".into(),
            V::Bool(b) => b.to_string(),
            V::Num(n) => js_num_str(*n)?,
            V::Str(s) => s.clone(),
            V::Arr(_) | V::Obj(_) => return None,
        })
    }
}

/// A number as JSON: an integer when it is one, `None` when it is not finite.
pub fn num_json(n: f64) -> Option<Value> {
    if n.fract() == 0.0 && n.abs() < 9e15 {
        Some(Value::from(n as i64))
    } else {
        serde_json::Number::from_f64(n).map(Value::Number)
    }
}

/// `Number::toString` for the range where Rust's shortest round-trip form is JS's: integers below
/// 1e21 and decimals in [1e-6, 1e21). `None` outside (and for NaN / Infinity).
fn js_num_str(n: f64) -> Option<String> {
    if n == 0.0 {
        return Some("0".into());
    }
    let a = n.abs();
    if !n.is_finite() || !(1e-6..1e21).contains(&a) {
        return None;
    }
    if n.fract() == 0.0 && a < 1e15 {
        return Some(format!("{}", n as i64));
    }
    // Rust never uses an exponent for `{}` on f64.
    Some(format!("{n}"))
}

/// One fold session: callback parameters, module consts, and the evaluation budget.
pub struct FoldEnv<'a> {
    binds: Vec<(String, V)>,
    consts: &'a dyn Fn(&str) -> Option<RawExpr>,
    memo: HashMap<String, Result<V, String>>,
    stack: Vec<String>,
    steps: u32,
    depth: u32,
}

impl<'a> FoldEnv<'a> {
    pub fn new(consts: &'a dyn Fn(&str) -> Option<RawExpr>) -> Self {
        FoldEnv {
            binds: Vec::new(),
            consts,
            memo: HashMap::new(),
            stack: Vec::new(),
            steps: 0,
            depth: 0,
        }
    }

    /// A session with no module consts (`json_literal`).
    pub fn empty() -> FoldEnv<'static> {
        FoldEnv::new(&|_| None)
    }

    pub fn bind(&mut self, name: &str, v: V) {
        self.binds.push((name.to_string(), v));
    }

    pub fn unbind(&mut self, n: usize) {
        let keep = self.binds.len().saturating_sub(n);
        self.binds.truncate(keep);
    }

    pub fn fold(&mut self, e: &RawExpr) -> Result<V, String> {
        self.steps += 1;
        if self.steps > MAX_STEPS {
            return Err("a constant too large to fold".into());
        }
        if self.depth >= MAX_DEPTH {
            return Err("an expression nested too deeply to fold".into());
        }
        self.depth += 1;
        let out = self.fold_inner(e);
        self.depth -= 1;
        out
    }

    fn fold_inner(&mut self, e: &RawExpr) -> Result<V, String> {
        match &e.kind {
            RawKind::Lit(l) => Ok(match l {
                Literal::Str(s) => V::Str(s.clone()),
                Literal::Num(n) => V::Num(*n),
                Literal::Bool(b) => V::Bool(*b),
                Literal::Null => V::Null,
                Literal::Undefined => V::Undef,
            }),
            RawKind::Ident { name, kind } => self.ident(name, kind),
            RawKind::Member {
                target,
                name,
                optional,
            } => {
                let t = self.fold(target)?;
                member(&t, name, *optional)
            }
            RawKind::Index { target, index } => {
                let t = self.fold(target)?;
                let i = self.fold(index)?;
                match (&t, &i) {
                    (V::Arr(a), V::Num(n)) => Ok(if *n >= 0.0 && n.fract() == 0.0 {
                        a.get(*n as usize).cloned().unwrap_or(V::Undef)
                    } else {
                        V::Undef
                    }),
                    (V::Obj(_), V::Str(k)) => member(&t, k, false),
                    _ => Err(format!("an index of {} by {}", t.kind(), i.kind())),
                }
            }
            RawKind::Unary { op, value } => {
                let v = self.fold(value)?;
                match (op, &v) {
                    (UnOp::Not, _) => Ok(V::Bool(!v.truthy())),
                    (UnOp::Neg, V::Num(n)) => Ok(V::Num(-n)),
                    (UnOp::Pos, V::Num(n)) => Ok(V::Num(*n)),
                    (UnOp::Neg | UnOp::Pos, _) => Err(format!("unary `-`/`+` of {}", v.kind())),
                    (UnOp::Typeof, _) => Err("`typeof`".into()),
                }
            }
            RawKind::Binary { op, left, right } => self.binary(*op, left, right),
            RawKind::Cond { test, yes, no } => {
                if self.fold(test)?.truthy() {
                    self.fold(yes)
                } else {
                    self.fold(no)
                }
            }
            RawKind::Template { head, parts } => {
                let mut s = head.clone();
                for (p, tail) in parts {
                    let v = self.fold(p)?;
                    s.push_str(
                        &v.to_js_string()
                            .ok_or_else(|| format!("{} in a template", v.kind()))?,
                    );
                    s.push_str(tail);
                }
                Ok(V::Str(s))
            }
            RawKind::Array(items) => items
                .iter()
                .map(|i| self.fold(i))
                .collect::<Result<_, _>>()
                .map(V::Arr),
            RawKind::Object(fields) => {
                let mut out: Vec<(String, V)> = Vec::with_capacity(fields.len());
                for (k, v) in fields {
                    let v = self.fold(v)?;
                    match out.iter_mut().find(|(n, _)| n == k) {
                        Some(slot) => slot.1 = v,
                        None => out.push((k.clone(), v)),
                    }
                }
                Ok(V::Obj(out))
            }
            RawKind::Call { callee, args } => self.call(callee, args),
            RawKind::Arrow { .. } => Err("a function".into()),
            RawKind::Jsx(_) => Err("JSX".into()),
            RawKind::Opaque { why, .. } => {
                Err(format!("an expression the reader keeps opaque ({why})"))
            }
        }
    }

    fn ident(&mut self, name: &str, kind: &IdentKind) -> Result<V, String> {
        if let Some((_, v)) = self.binds.iter().rev().find(|(n, _)| n == name) {
            return Ok(v.clone());
        }
        match kind {
            IdentKind::Local => self.module_const(name),
            IdentKind::Global => match name {
                "undefined" => Ok(V::Undef),
                "NaN" => Ok(V::Num(f64::NAN)),
                "Infinity" => Ok(V::Num(f64::INFINITY)),
                _ => Err(format!("the global `{name}`")),
            },
            IdentKind::Prop => Err(format!("the prop `{name}`")),
            IdentKind::State | IdentKind::Setter => Err(format!("state `{name}`")),
            IdentKind::Store { .. } => Err(format!("the store value `{name}`")),
            IdentKind::Import { .. } => Err(format!("the import `{name}`")),
            IdentKind::LoopBinding | IdentKind::Unknown => {
                Err(format!("`{name}`, which is not a constant"))
            }
        }
    }

    fn module_const(&mut self, name: &str) -> Result<V, String> {
        if let Some(r) = self.memo.get(name) {
            return r.clone();
        }
        if self.stack.iter().any(|s| s == name) {
            return Err(format!("`{name}`, which refers to itself"));
        }
        let Some(init) = (self.consts)(name) else {
            return Err(format!("`{name}`, which is not a module constant"));
        };
        // A const's initializer cannot see the callback parameters of the place that reads it.
        let saved = std::mem::take(&mut self.binds);
        self.stack.push(name.to_string());
        let r = self.fold(&init).map_err(|why| format!("`{name}` ({why})"));
        self.stack.pop();
        self.binds = saved;
        self.memo.insert(name.to_string(), r.clone());
        r
    }

    fn binary(&mut self, op: BinOp, l: &RawExpr, r: &RawExpr) -> Result<V, String> {
        // `&&` `||` `??` evaluate the right side only when JS does.
        match op {
            BinOp::And => {
                let a = self.fold(l)?;
                return if a.truthy() { self.fold(r) } else { Ok(a) };
            }
            BinOp::Or => {
                let a = self.fold(l)?;
                return if a.truthy() { Ok(a) } else { self.fold(r) };
            }
            BinOp::Nullish => {
                let a = self.fold(l)?;
                return if matches!(a, V::Undef | V::Null) {
                    self.fold(r)
                } else {
                    Ok(a)
                };
            }
            _ => {}
        }
        let a = self.fold(l)?;
        let b = self.fold(r)?;
        match (op, &a, &b) {
            (BinOp::Add, V::Num(x), V::Num(y)) => Ok(V::Num(x + y)),
            (BinOp::Add, V::Str(_) | V::Num(_), V::Str(_) | V::Num(_)) => {
                let (x, y) = (a.to_js_string(), b.to_js_string());
                match (x, y) {
                    (Some(x), Some(y)) => Ok(V::Str(x + &y)),
                    _ => Err("a number the compiler cannot print as JS does".into()),
                }
            }
            (BinOp::Sub, V::Num(x), V::Num(y)) => Ok(V::Num(x - y)),
            (BinOp::Mul, V::Num(x), V::Num(y)) => Ok(V::Num(x * y)),
            (BinOp::Div, V::Num(x), V::Num(y)) => Ok(V::Num(x / y)),
            (BinOp::Rem, V::Num(x), V::Num(y)) => Ok(V::Num(x % y)),
            (BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge, V::Num(x), V::Num(y)) => {
                Ok(V::Bool(match op {
                    BinOp::Lt => x < y,
                    BinOp::Le => x <= y,
                    BinOp::Gt => x > y,
                    _ => x >= y,
                }))
            }
            (BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge, V::Str(x), V::Str(y)) => {
                // JS compares UTF-16 code units.
                let ord = x.encode_utf16().cmp(y.encode_utf16());
                Ok(V::Bool(match op {
                    BinOp::Lt => ord.is_lt(),
                    BinOp::Le => ord.is_le(),
                    BinOp::Gt => ord.is_gt(),
                    _ => ord.is_ge(),
                }))
            }
            (BinOp::Eq | BinOp::StrictEq | BinOp::Ne | BinOp::StrictNe, ..) => {
                let eq = match (&a, &b) {
                    (V::Num(x), V::Num(y)) => x == y,
                    (V::Str(x), V::Str(y)) => x == y,
                    (V::Bool(x), V::Bool(y)) => x == y,
                    (V::Null | V::Undef, V::Null | V::Undef) => {
                        // `null === undefined` is false, `null == undefined` is true.
                        matches!(op, BinOp::Eq | BinOp::Ne)
                            || std::mem::discriminant(&a) == std::mem::discriminant(&b)
                    }
                    (V::Arr(_) | V::Obj(_), _) | (_, V::Arr(_) | V::Obj(_)) => {
                        return Err("an equality test on an array or object".into());
                    }
                    _ if matches!(op, BinOp::StrictEq | BinOp::StrictNe) => false,
                    _ => {
                        return Err(format!(
                            "a loose `==` between {} and {}",
                            a.kind(),
                            b.kind()
                        ));
                    }
                };
                Ok(V::Bool(eq == matches!(op, BinOp::Eq | BinOp::StrictEq)))
            }
            _ => Err(format!(
                "`{}` between {} and {}",
                super::expr::bin_str(op),
                a.kind(),
                b.kind()
            )),
        }
    }

    fn call(&mut self, callee: &RawExpr, args: &[RawExpr]) -> Result<V, String> {
        let RawKind::Member {
            target,
            name,
            optional: false,
        } = &callee.kind
        else {
            return Err(format!("a call to `{}`", callee.to_js()));
        };
        match (&target.kind, name.as_str()) {
            (
                RawKind::Ident {
                    name: g,
                    kind: IdentKind::Global,
                },
                "from",
            ) if g == "Array" => self.array_from(args),
            // Pure string methods of no argument (R34.105: a library spells a name `' useX '.trim().toString()` so a
            // bundler cannot read it). A string only: `toString` of a number or an array has other meanings.
            (_, m @ ("trim" | "toString")) if args.is_empty() => {
                let t = self.fold(target)?;
                let V::Str(s) = t else {
                    return Err(format!("`.{m}()` on {}", t.kind()));
                };
                Ok(V::Str(if m == "trim" {
                    s.trim_matches(is_js_space).to_string()
                } else {
                    s
                }))
            }
            (_, "map") => {
                let t = self.fold(target)?;
                let V::Arr(items) = t else {
                    return Err(format!("`.map` on {}", t.kind()));
                };
                let [cb] = args else {
                    return Err("`.map` with other than one argument".into());
                };
                self.map(items, cb)
            }
            _ => Err(format!("a call to `{}`", callee.to_js())),
        }
    }

    fn array_from(&mut self, args: &[RawExpr]) -> Result<V, String> {
        let (spec, cb) = match args {
            [s] => (s, None),
            [s, cb] => (s, Some(cb)),
            _ => return Err("`Array.from` with other arguments".into()),
        };
        let RawKind::Object(fields) = &spec.kind else {
            return Err("`Array.from` of something other than `{ length: N }`".into());
        };
        let [(k, len)] = fields.as_slice() else {
            return Err("`Array.from` of something other than `{ length: N }`".into());
        };
        if k != "length" {
            return Err("`Array.from` of something other than `{ length: N }`".into());
        }
        let V::Num(n) = self.fold(len)? else {
            return Err("`Array.from` needs a constant numeric length".into());
        };
        if n.is_nan() || n < 0.0 || n.fract() != 0.0 || n > MAX_FROM_LENGTH {
            return Err(format!(
                "`Array.from` with a length that is not an integer from 0 to {}",
                MAX_FROM_LENGTH as u32
            ));
        }
        let holes = vec![V::Undef; n as usize];
        match cb {
            None => Ok(V::Arr(holes)),
            Some(cb) => self.map(holes, cb),
        }
    }

    /// `items.map(cb)` with `cb` an arrow of 1–3 plain parameters and an expression body.
    fn map(&mut self, items: Vec<V>, cb: &RawExpr) -> Result<V, String> {
        let RawKind::Arrow { params, body, .. } = &cb.kind else {
            return Err("a `.map` callback that is not an arrow function".into());
        };
        let ArrowBody::Expr(body) = body else {
            return Err("a `.map` callback with a block body".into());
        };
        if params.len() > 3 {
            return Err("a `.map` callback with more than three parameters".into());
        }
        let whole = V::Arr(items.clone());
        let mut out = Vec::with_capacity(items.len());
        for (i, it) in items.into_iter().enumerate() {
            let mut n = 0;
            for (p, v) in params.iter().zip([it, V::Num(i as f64), whole.clone()]) {
                self.bind(p, v);
                n += 1;
            }
            let r = self.fold(body);
            self.unbind(n);
            out.push(r?);
        }
        Ok(V::Arr(out))
    }
}

/// ECMAScript `WhiteSpace` and `LineTerminator` (what `String.prototype.trim` strips), which is not Rust's
/// `char::is_whitespace`: U+FEFF is in, U+0085 is out.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'
            | '\u{A}'
            | '\u{B}'
            | '\u{C}'
            | '\u{D}'
            | '\u{20}'
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// Own members of `Object.prototype` a missing key must not be read as.
const PROTO_NAMES: &[&str] = &[
    "constructor",
    "__proto__",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

fn member(t: &V, name: &str, optional: bool) -> Result<V, String> {
    match t {
        V::Undef | V::Null if optional => Ok(V::Undef),
        V::Undef | V::Null => Err(format!("`.{name}` of {}", t.kind())),
        V::Arr(a) if name == "length" => Ok(V::Num(a.len() as f64)),
        V::Str(s) if name == "length" => Ok(V::Num(s.encode_utf16().count() as f64)),
        V::Obj(o) => match o.iter().find(|(k, _)| k == name) {
            Some((_, v)) => Ok(v.clone()),
            None if PROTO_NAMES.contains(&name) => Err(format!("`.{name}` of an object")),
            None => Ok(V::Undef),
        },
        _ => Err(format!("`.{name}` of {}", t.kind())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(kind: RawKind) -> RawExpr {
        RawExpr { loc: 0, kind }
    }
    fn num(n: f64) -> RawExpr {
        e(RawKind::Lit(Literal::Num(n)))
    }
    fn st(s: &str) -> RawExpr {
        e(RawKind::Lit(Literal::Str(s.into())))
    }
    fn bin(op: BinOp, l: RawExpr, r: RawExpr) -> RawExpr {
        e(RawKind::Binary {
            op,
            left: Box::new(l),
            right: Box::new(r),
        })
    }
    fn global(n: &str) -> RawExpr {
        e(RawKind::Ident {
            name: n.into(),
            kind: IdentKind::Global,
        })
    }
    fn member(t: RawExpr, n: &str) -> RawExpr {
        e(RawKind::Member {
            target: Box::new(t),
            name: n.into(),
            optional: false,
        })
    }
    fn call(callee: RawExpr, args: Vec<RawExpr>) -> RawExpr {
        e(RawKind::Call {
            callee: Box::new(callee),
            args,
        })
    }
    fn fold(x: &RawExpr) -> Result<V, String> {
        FoldEnv::empty().fold(x)
    }

    #[test]
    fn numbers_follow_js_arithmetic_and_printing() {
        let sum = bin(BinOp::Add, num(0.1), num(0.2));
        assert_eq!(fold(&sum), Ok(V::Num(0.1 + 0.2)));
        let t = e(RawKind::Template {
            head: "v".into(),
            parts: vec![(sum, "".into())],
        });
        assert_eq!(fold(&t), Ok(V::Str("v0.30000000000000004".into())));
        assert_eq!(
            fold(&bin(BinOp::Add, st("a"), num(1.0))),
            Ok(V::Str("a1".into()))
        );
        assert_eq!(
            fold(&bin(BinOp::Rem, num(-7.0), num(3.0))),
            Ok(V::Num(-1.0))
        );
        // Division by zero is a number JS prints as Infinity; JSON cannot hold it.
        let inf = fold(&bin(BinOp::Div, num(1.0), num(0.0))).unwrap();
        assert_eq!(inf.to_json(), None);
        // `-0` prints as 0.
        assert_eq!(V::Num(-0.0).to_json(), Some(json_num(0)));
        // A number outside the exact-printing range does not concatenate.
        assert!(fold(&bin(BinOp::Add, st("a"), num(1e21))).is_err());
    }

    fn json_num(n: i64) -> Value {
        Value::from(n)
    }

    #[test]
    fn trim_and_to_string_fold_on_strings_only() {
        let call = |t: RawExpr, m: &str| call(member(t, m), vec![]);
        // JS whitespace, not Rust's: U+FEFF is trimmed, U+0085 is not.
        assert_eq!(
            fold(&call(call(st(" \u{FEFF}\t useX \n"), "trim"), "toString")),
            Ok(V::Str("useX".into()))
        );
        assert_eq!(
            fold(&call(st("\u{85}x"), "trim")),
            Ok(V::Str("\u{85}x".into()))
        );
        // Not a string, or with an argument (`(255).toString(16)`): refused.
        assert!(fold(&call(num(255.0), "toString")).is_err());
        assert!(fold(&call(e(RawKind::Array(vec![])), "trim")).is_err());
        assert!(fold(&self::call(member(st("a"), "toString"), vec![num(2.0)])).is_err());
    }

    #[test]
    fn missing_members_and_indexes_read_as_undefined() {
        let arr = e(RawKind::Array(vec![num(1.0)]));
        let idx = |i: f64| {
            e(RawKind::Index {
                target: Box::new(arr.clone()),
                index: Box::new(num(i)),
            })
        };
        assert_eq!(fold(&idx(0.0)), Ok(V::Num(1.0)));
        assert_eq!(fold(&idx(5.0)), Ok(V::Undef));
        assert_eq!(fold(&idx(-1.0)), Ok(V::Undef));
        let obj = e(RawKind::Object(vec![("a".into(), num(1.0))]));
        assert_eq!(fold(&member(obj.clone(), "b")), Ok(V::Undef));
        // A member that is an `Object.prototype` function is not undefined: fail closed.
        assert!(fold(&member(obj, "toString")).is_err());
        assert!(fold(&member(e(RawKind::Lit(Literal::Null)), "a")).is_err());
        assert_eq!(fold(&member(st("héllo"), "length")), Ok(V::Num(5.0)));
        // UTF-16 length: an astral character counts twice.
        assert_eq!(fold(&member(st("😀"), "length")), Ok(V::Num(2.0)));
    }

    #[test]
    fn logic_short_circuits_and_returns_operands() {
        let boom = global("window");
        assert_eq!(
            fold(&bin(BinOp::Or, st("x"), boom.clone())),
            Ok(V::Str("x".into()))
        );
        assert_eq!(
            fold(&bin(BinOp::And, num(0.0), boom.clone())),
            Ok(V::Num(0.0))
        );
        assert!(fold(&bin(BinOp::And, num(1.0), boom)).is_err());
        assert_eq!(
            fold(&bin(
                BinOp::Nullish,
                e(RawKind::Lit(Literal::Null)),
                num(2.0)
            )),
            Ok(V::Num(2.0))
        );
        assert_eq!(
            fold(&bin(BinOp::StrictEq, st("a"), st("a"))),
            Ok(V::Bool(true))
        );
        // Objects compare by identity in JS: the folder does not guess.
        let o = e(RawKind::Object(vec![]));
        assert!(fold(&bin(BinOp::StrictEq, o.clone(), o)).is_err());
    }

    #[test]
    fn only_array_from_and_map_are_calls() {
        let from = |n: f64| {
            call(
                member(global("Array"), "from"),
                vec![e(RawKind::Object(vec![("length".into(), num(n))]))],
            )
        };
        assert_eq!(fold(&from(2.0)), Ok(V::Arr(vec![V::Undef, V::Undef])));
        assert!(fold(&from(10_001.0)).is_err());
        assert!(fold(&from(-1.0)).is_err());
        assert!(fold(&from(1.5)).is_err());
        let other = call(member(global("Object"), "keys"), vec![]);
        assert!(fold(&other).unwrap_err().contains("Object.keys"));
        let join = call(member(e(RawKind::Array(vec![])), "join"), vec![]);
        assert!(fold(&join).is_err());
    }

    #[test]
    fn module_consts_resolve_once_cycles_and_unknown_names_fail() {
        let a = |n: &str| {
            e(RawKind::Ident {
                name: n.into(),
                kind: IdentKind::Local,
            })
        };
        let consts = |n: &str| match n {
            "a" => Some(bin(BinOp::Add, num(1.0), a("b"))),
            "b" => Some(num(2.0)),
            "x" => Some(a("y")),
            "y" => Some(a("x")),
            _ => None,
        };
        let mut env = FoldEnv::new(&consts);
        assert_eq!(env.fold(&a("a")), Ok(V::Num(3.0)));
        assert!(env.fold(&a("x")).unwrap_err().contains("refers to itself"));
        assert!(
            env.fold(&a("nope"))
                .unwrap_err()
                .contains("not a module constant")
        );
    }

    #[test]
    fn a_huge_fold_stops_at_the_step_budget() {
        // 10 000 elements mapped three times is far over what one island may need.
        let big = call(
            member(global("Array"), "from"),
            vec![e(RawKind::Object(vec![("length".into(), num(10_000.0))]))],
        );
        let mapped = |src: RawExpr| {
            call(
                member(src, "map"),
                vec![e(RawKind::Arrow {
                    params: vec!["_".into()],
                    body: ArrowBody::Expr(Box::new(bin(BinOp::Add, num(1.0), num(2.0)))),
                    captures: vec![],
                })],
            )
        };
        let mut x = big;
        for _ in 0..12 {
            x = mapped(x);
        }
        assert!(fold(&x).unwrap_err().contains("too large"));
    }

    #[test]
    fn json_literal_keeps_its_old_answers() {
        assert_eq!(num(3.0).json_literal(), Some(json_num(3)));
        assert_eq!(
            bin(BinOp::Div, num(16.0), num(9.0))
                .json_literal()
                .map(|v| v.is_number()),
            Some(true)
        );
        assert_eq!(e(RawKind::Lit(Literal::Undefined)).json_literal(), None);
        assert_eq!(global("x").json_literal(), None);
    }
}
