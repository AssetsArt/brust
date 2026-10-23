//! F288 §3 (ruling Q1, Detoro 2026-10-23): a module function called with an element value (`getElementRef(child)`) is
//! evaluated as written, over React 19's PRODUCTION element shape (`react-jsx-runtime.production.js` `jsxProd`):
//! `{ $$typeof, type, key, ref: props.ref ?? null, props }`, every field a data property. No function or package name
//! is keyed: the statements and expressions below are the whole language, and anything else fails closed (the caller
//! keeps its `element-value` refusal).
//!
//! Statements: `let` / `const` of one identifier, `if` / `else`, blocks, `return`, an assignment to a local.
//! Expressions: literals, `undefined`, identifiers (parameters and locals), member reads (optional too), `!`,
//! `&&` / `||` / `??`, `"k" in v`, and `Object.getOwnPropertyDescriptor(o, "k")`. A value the fold cannot know (the
//! element's ref, an expression of the call site) is symbolic: a truth test of it is refused, except under `&&` / `||` /
//! `??`, whose value is then printed as that expression over the operands.
use crate::ir::{BinOp, Literal, RawExpr, RawKind};
use bun_ast as js_ast;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;
use std::collections::HashMap;

/// The element a fold reads: its `props.ref` (`None`: the element has no `ref` prop), and whether its props may hold
/// keys brust does not know (a spread among them).
pub struct ElementShape {
    pub props_ref: Option<RawExpr>,
    pub open_props: bool,
}

#[derive(Clone, Debug)]
enum V {
    Undef,
    Null,
    Bool(bool),
    Str(String),
    Num(f64),
    /// A plain data object: its known fields, and whether it may hold others.
    Rec(Vec<(String, V)>, bool),
    /// A data-property descriptor of a value.
    Desc(Box<V>),
    /// A value known only as an expression of the call site.
    Sym(RawExpr),
    /// The global `Object` and its `getOwnPropertyDescriptor`.
    Object,
    GetOwnPropertyDescriptor,
}

impl V {
    /// `Some(truthy)` when known.
    fn truthy(&self) -> Option<bool> {
        Some(match self {
            V::Undef | V::Null => false,
            V::Bool(b) => *b,
            V::Str(s) => !s.is_empty(),
            V::Num(n) => *n != 0.0 && !n.is_nan(),
            V::Rec(..) | V::Desc(_) | V::Object | V::GetOwnPropertyDescriptor => true,
            V::Sym(_) => return None,
        })
    }

    fn nullish(&self) -> Option<bool> {
        match self {
            V::Undef | V::Null => Some(true),
            V::Sym(_) => None,
            _ => Some(false),
        }
    }

    fn to_raw(&self, loc: u32) -> Result<RawExpr, String> {
        let lit = |l| RawExpr {
            loc,
            kind: RawKind::Lit(l),
        };
        Ok(match self {
            V::Undef => lit(Literal::Undefined),
            V::Null => lit(Literal::Null),
            V::Bool(b) => lit(Literal::Bool(*b)),
            V::Str(s) => lit(Literal::Str(s.clone())),
            V::Num(n) => lit(Literal::Num(*n)),
            V::Sym(e) => e.clone(),
            _ => return Err("the function returns an object, which brust has no value for".into()),
        })
    }
}

/// The record React 19 production builds for an element with these props.
fn element(shape: &ElementShape, loc: u32) -> V {
    let props_ref = shape.props_ref.clone().map(V::Sym);
    let mut props = Vec::new();
    if let Some(r) = &props_ref {
        props.push(("ref".to_string(), r.clone()));
    }
    // `ref: props.ref ?? null`
    let ref_ = match &shape.props_ref {
        Some(r) => V::Sym(RawExpr {
            loc,
            kind: RawKind::Binary {
                op: BinOp::Nullish,
                left: Box::new(r.clone()),
                right: Box::new(RawExpr {
                    loc,
                    kind: RawKind::Lit(Literal::Null),
                }),
            },
        }),
        None => V::Null,
    };
    V::Rec(
        vec![
            ("ref".into(), ref_),
            ("props".into(), V::Rec(props, shape.open_props)),
        ],
        // `$$typeof`, `type`, `key`: present, not read by any production here
        true,
    )
}

/// Evaluates the module function `name` of `ast`, called with one argument: the element `shape`.
pub fn eval_element_fn(
    ast: &js_ast::Ast<'_>,
    name: &str,
    shape: &ElementShape,
    loc: u32,
) -> Result<RawExpr, String> {
    let f = crate::analyze::component::module_fn(ast, name)
        .ok_or_else(|| format!("`{name}` is not a function declaration of the module"))?;
    if f.flags.contains(js_ast::flags::Function::IsAsync)
        || f.flags.contains(js_ast::flags::Function::IsGenerator)
    {
        return Err(format!("`{name}` is async or a generator"));
    }
    let [param] = f.args.slice() else {
        return Err(format!("`{name}` does not take exactly one parameter"));
    };
    let js_ast::binding::Data::BIdentifier(p) = &param.binding.data else {
        return Err(format!("`{name}` destructures its parameter"));
    };
    if param.default.is_some() {
        return Err(format!("`{name}` has a parameter default"));
    }
    let mut ev = Eval {
        ast,
        env: HashMap::new(),
        steps: 0,
        loc,
    };
    ev.env.insert(p.r#ref.inner_index(), element(shape, loc));
    match ev.stmts(f.body.stmts.slice())? {
        Flow::Return(v) => v.to_raw(loc),
        Flow::Next => Ok(V::Undef.to_raw(loc)?),
    }
}

enum Flow {
    Next,
    Return(V),
}

struct Eval<'a, 'b> {
    ast: &'a js_ast::Ast<'b>,
    env: HashMap<u32, V>,
    steps: u32,
    loc: u32,
}

impl Eval<'_, '_> {
    fn step(&mut self) -> Result<(), String> {
        self.steps += 1;
        if self.steps > 10_000 {
            return Err("the function takes too many steps to fold".into());
        }
        Ok(())
    }

    /// The name of `r` when it is a global (bound nowhere in the module: a local `Object` is not the global).
    fn global_name(&self, r: js_ast::Ref) -> Option<String> {
        self.ast
            .symbols
            .as_slice()
            .get(r.inner_index() as usize)
            .filter(|s| s.kind == js_ast::symbol::Kind::Unbound)
            .map(|s| String::from_utf8_lossy(s.original_name.slice()).into_owned())
    }

    fn stmts(&mut self, ss: &[js_ast::Stmt]) -> Result<Flow, String> {
        for s in ss {
            if let Flow::Return(v) = self.stmt(s)? {
                return Ok(Flow::Return(v));
            }
        }
        Ok(Flow::Next)
    }

    fn stmt(&mut self, s: &js_ast::Stmt) -> Result<Flow, String> {
        self.step()?;
        match &s.data {
            S::SReturn(r) => Ok(Flow::Return(match &r.value {
                Some(v) => self.expr(v)?,
                None => V::Undef,
            })),
            S::SBlock(b) => self.stmts(b.stmts.slice()),
            S::SIf(i) => {
                let t = self.expr(&i.test)?;
                match t.truthy() {
                    Some(true) => self.stmt(&i.yes),
                    Some(false) => match &i.no {
                        Some(n) => self.stmt(n),
                        None => Ok(Flow::Next),
                    },
                    None => Err("an `if` tests a value only the call site knows".into()),
                }
            }
            S::SLocal(l) => {
                for d in l.decls.iter() {
                    let js_ast::binding::Data::BIdentifier(id) = &d.binding.data else {
                        return Err("a destructuring declaration".into());
                    };
                    let v = match &d.value {
                        Some(v) => self.expr(v)?,
                        None => V::Undef,
                    };
                    self.env.insert(id.r#ref.inner_index(), v);
                }
                Ok(Flow::Next)
            }
            S::SExpr(e) => match &e.value.data {
                E::EBinary(b) if matches!(b.op, js_ast::OpCode::BinAssign) => {
                    let E::EIdentifier(id) = &b.left.data else {
                        return Err("an assignment to something other than a local".into());
                    };
                    let k = id.ref_.inner_index();
                    if !self.env.contains_key(&k) {
                        return Err("an assignment to a name outside the function".into());
                    }
                    let v = self.expr(&b.right)?;
                    self.env.insert(k, v);
                    Ok(Flow::Next)
                }
                _ => Err("an expression statement".into()),
            },
            S::STypeScript(_) | S::SEmpty(_) | S::SDirective(_) | S::SComment(_) => Ok(Flow::Next),
            _ => Err("a statement outside the folded subset".into()),
        }
    }

    fn expr(&mut self, e: &js_ast::Expr) -> Result<V, String> {
        self.step()?;
        Ok(match &e.data {
            E::EUndefined(_) => V::Undef,
            E::ENull(_) => V::Null,
            E::EBoolean(b) => V::Bool(b.value),
            E::EString(s) => V::Str(crate::analyze::expr::estring(s)),
            E::ENumber(n) => V::Num(n.value()),
            E::EIdentifier(id) => match self.env.get(&id.ref_.inner_index()) {
                Some(v) => v.clone(),
                None => match self.global_name(id.ref_).as_deref() {
                    Some("undefined") => V::Undef,
                    Some("Object") => V::Object,
                    _ => return Err("a name outside the function".into()),
                },
            },
            E::EDot(d) => {
                let t = self.expr(&d.target)?;
                let optional = d.optional_chain.is_some();
                let k = String::from_utf8_lossy(d.name.slice()).into_owned();
                self.member(t, &k, optional)?
            }
            E::EUnary(u) if matches!(u.op, js_ast::OpCode::UnNot) => {
                let v = self.expr(&u.value)?;
                V::Bool(
                    !v.truthy()
                        .ok_or("`!` of a value only the call site knows")?,
                )
            }
            E::EBinary(b) => match b.op {
                js_ast::OpCode::BinLogicalAnd
                | js_ast::OpCode::BinLogicalOr
                | js_ast::OpCode::BinNullishCoalescing => {
                    let l = self.expr(&b.left)?;
                    let decided = match b.op {
                        js_ast::OpCode::BinLogicalAnd => l.truthy().map(|t| !t),
                        js_ast::OpCode::BinLogicalOr => l.truthy(),
                        _ => l.nullish().map(|n| !n),
                    };
                    match decided {
                        // the left operand is the value
                        Some(true) => l,
                        Some(false) => self.expr(&b.right)?,
                        None => {
                            let r = self.expr(&b.right)?;
                            let op = match b.op {
                                js_ast::OpCode::BinLogicalAnd => BinOp::And,
                                js_ast::OpCode::BinLogicalOr => BinOp::Or,
                                _ => BinOp::Nullish,
                            };
                            V::Sym(RawExpr {
                                loc: self.loc,
                                kind: RawKind::Binary {
                                    op,
                                    left: Box::new(l.to_raw(self.loc)?),
                                    right: Box::new(r.to_raw(self.loc)?),
                                },
                            })
                        }
                    }
                }
                js_ast::OpCode::BinIn => {
                    let k = match self.expr(&b.left)? {
                        V::Str(s) => s,
                        _ => return Err("`in` with a key that is not a string".into()),
                    };
                    match self.expr(&b.right)? {
                        V::Rec(fields, open) => {
                            if fields.iter().any(|(f, _)| *f == k) {
                                V::Bool(true)
                            } else if open {
                                return Err(
                                    "`in` on an object whose keys brust does not know".into()
                                );
                            } else {
                                V::Bool(false)
                            }
                        }
                        V::Desc(_) => V::Bool(matches!(
                            k.as_str(),
                            "value" | "writable" | "enumerable" | "configurable"
                        )),
                        _ => return Err("`in` on a value that is not a known object".into()),
                    }
                }
                _ => return Err("an operator outside the folded subset".into()),
            },
            E::ECall(c) => {
                let callee = self.expr(&c.target)?;
                if !matches!(callee, V::GetOwnPropertyDescriptor) {
                    return Err("a call outside the folded subset".into());
                }
                let [o, k] = c.args.as_slice() else {
                    return Err(
                        "`Object.getOwnPropertyDescriptor` with other than two arguments".into(),
                    );
                };
                let o = self.expr(o)?;
                let V::Str(k) = self.expr(k)? else {
                    return Err("a property descriptor of a key that is not a string".into());
                };
                match o {
                    V::Rec(fields, open) => {
                        match fields.into_iter().find(|(f, _)| *f == k) {
                            Some((_, v)) => V::Desc(Box::new(v)),
                            None if open => {
                                return Err("a property descriptor on an object whose keys brust does not know".into());
                            }
                            None => V::Undef,
                        }
                    }
                    _ => {
                        return Err(
                            "a property descriptor of a value that is not a known object".into(),
                        );
                    }
                }
            }
            _ => return Err("an expression outside the folded subset".into()),
        })
    }

    fn member(&mut self, t: V, k: &str, optional: bool) -> Result<V, String> {
        Ok(match t {
            V::Undef | V::Null if optional => V::Undef,
            V::Undef | V::Null => {
                return Err("a member of `undefined` or `null` (React would throw)".into());
            }
            V::Rec(fields, open) => match fields.into_iter().find(|(f, _)| f == k) {
                Some((_, v)) => v,
                None if open => {
                    return Err(format!(
                        "`.{k}` of an object whose keys brust does not know"
                    ));
                }
                None => V::Undef,
            },
            V::Desc(v) => match k {
                "value" => *v,
                "writable" | "enumerable" | "configurable" => V::Bool(true),
                // a data property has no accessors
                "get" | "set" => V::Undef,
                _ => V::Undef,
            },
            V::Object if k == "getOwnPropertyDescriptor" => V::GetOwnPropertyDescriptor,
            _ => return Err(format!("`.{k}` of a value outside the folded subset")),
        })
    }
}
