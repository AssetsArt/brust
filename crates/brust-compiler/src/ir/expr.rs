//! Expressions as the analyzer reads them (`RawExpr`) and as later stages place
//! them (`Expr`). Plain Rust: this module never names Bun types (spec §9).
use serde::{Deserialize, Serialize};

/// What an identifier refers to, decided from its symbol and import record,
/// never from its spelling.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum IdentKind {
    Prop,
    Local,
    State,
    Setter,
    Import { source: String, imported: String },
    Global,
    LoopBinding,
    Unknown,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum Literal {
    Str(String),
    Num(f64),
    Bool(bool),
    Null,
    Undefined,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Eq,
    Ne,
    StrictEq,
    StrictNe,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
    Nullish,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnOp {
    Not,
    Neg,
    Pos,
    Typeof,
}

/// One expression with the byte offset of its start in the source.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct RawExpr {
    pub loc: u32,
    pub kind: RawKind,
}

/// Carries every production of the §6.2 grammar losslessly; anything else is
/// `Opaque` with the printed JS and the reason it was not read structurally.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum RawKind {
    Lit(Literal),
    Ident {
        name: String,
        kind: IdentKind,
    },
    Member {
        target: Box<RawExpr>,
        name: String,
        optional: bool,
    },
    Index {
        target: Box<RawExpr>,
        index: Box<RawExpr>,
    },
    /// `callee` is an `Ident` or a `Member`.
    Call {
        callee: Box<RawExpr>,
        args: Vec<RawExpr>,
    },
    Binary {
        op: BinOp,
        left: Box<RawExpr>,
        right: Box<RawExpr>,
    },
    Unary {
        op: UnOp,
        value: Box<RawExpr>,
    },
    Cond {
        test: Box<RawExpr>,
        yes: Box<RawExpr>,
        no: Box<RawExpr>,
    },
    Template {
        head: String,
        parts: Vec<(RawExpr, String)>,
    },
    Array(Vec<RawExpr>),
    Object(Vec<(String, RawExpr)>),
    Arrow {
        params: Vec<String>,
        body: ArrowBody,
        captures: Vec<(String, IdentKind)>,
    },
    /// JSX in expression position (map bodies, ternary arms).
    Jsx(Box<crate::ir::template::Node>),
    /// Anything else; `source` is the printed JS. `captures` are the
    /// identifiers it reads that it does not declare (like `Arrow`), so deps and
    /// job inputs stay exact. `why == "contains-jsx"` marks JSX built outside the
    /// template (a handler or effect body).
    Opaque {
        source: String,
        why: String,
        captures: Vec<(String, IdentKind)>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum ArrowBody {
    Expr(Box<RawExpr>),
    Block { source: String, captures_only: bool },
}

/// Placement of a value (spec §5.1). M1b-1 produces only `Raw`; M1b-2 places.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum Expr {
    Raw(RawExpr),
    Server(ServerExpr),
    /// A first-paint value the precompute job computes in Bun. `inputs` are
    /// sorted dotted prop paths. `state_dependent`: the job evaluates it with the
    /// state seeds and the client recomputes `js`. `per_item`: the loop binding
    /// when it sits in a `For` body (the job returns an array aligned with the list).
    Precomputed {
        slot: String,
        js: String,
        /// The same value printed for the client chunk (`props().x`, `n()`);
        /// `Some` iff `state_dependent` (the client recomputes it).
        client_js: Option<String>,
        inputs: Vec<String>,
        state_dependent: bool,
        per_item: Option<String>,
    },
    ClientOnly {
        js: String,
    },
}

/// A `RawExpr` proven inside the §6.2 grammar (M1b-2 narrows).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ServerExpr(pub RawExpr);

/// Where printed JS runs: the precompute job (props destructured, state seeds
/// as plain values) or the client chunk (`props()`, signals called).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsCtx {
    Server,
    Client,
}

impl RawExpr {
    /// JS for the precompute job ([`JsCtx::Server`]).
    pub fn to_js(&self) -> String {
        self.to_js_in(JsCtx::Server)
    }

    /// JS for `ctx`. `Block` arrow bodies and `Opaque` sources are printed
    /// verbatim (their identifiers keep their source names).
    pub fn to_js_in(&self, ctx: JsCtx) -> String {
        self.to_js_with(ctx, &|_, _| None)
    }

    /// [`Self::to_js_in`] with an identifier override: `names(name, kind)`
    /// returning `Some(js)` prints that instead (a derived computed `total()`,
    /// a renamed seed). Applies to structured expressions only.
    pub fn to_js_with(&self, ctx: JsCtx, names: JsNames<'_>) -> String {
        let mut out = String::new();
        print(self, ctx, names, &mut out);
        out
    }
}

/// Identifier override for [`RawExpr::to_js_with`].
pub type JsNames<'a> = &'a dyn Fn(&str, &IdentKind) -> Option<String>;

const P_SEQ: u8 = 1;
const P_ASSIGN: u8 = 2;
const P_COND: u8 = 3;
const P_UNARY: u8 = 15;
const P_CALL: u8 = 18;
const P_PRIMARY: u8 = 20;

fn bin_prec(op: BinOp) -> u8 {
    match op {
        BinOp::Nullish | BinOp::Or => 4,
        BinOp::And => 5,
        BinOp::Eq | BinOp::Ne | BinOp::StrictEq | BinOp::StrictNe => 9,
        BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => 10,
        BinOp::Add | BinOp::Sub => 12,
        BinOp::Mul | BinOp::Div | BinOp::Rem => 13,
    }
}

pub fn bin_str(op: BinOp) -> &'static str {
    match op {
        BinOp::Add => "+",
        BinOp::Sub => "-",
        BinOp::Mul => "*",
        BinOp::Div => "/",
        BinOp::Rem => "%",
        BinOp::Eq => "==",
        BinOp::Ne => "!=",
        BinOp::StrictEq => "===",
        BinOp::StrictNe => "!==",
        BinOp::Lt => "<",
        BinOp::Le => "<=",
        BinOp::Gt => ">",
        BinOp::Ge => ">=",
        BinOp::And => "&&",
        BinOp::Or => "||",
        BinOp::Nullish => "??",
    }
}

fn prec(e: &RawExpr) -> u8 {
    match &e.kind {
        RawKind::Lit(Literal::Num(n)) if *n < 0.0 => P_UNARY,
        RawKind::Lit(_)
        | RawKind::Ident { .. }
        | RawKind::Template { .. }
        | RawKind::Array(_)
        | RawKind::Object(_)
        | RawKind::Jsx(_) => P_PRIMARY,
        RawKind::Member { .. } | RawKind::Index { .. } | RawKind::Call { .. } => P_CALL,
        RawKind::Unary { .. } => P_UNARY,
        RawKind::Binary { op, .. } => bin_prec(*op),
        RawKind::Cond { .. } => P_COND,
        RawKind::Arrow { .. } => P_ASSIGN,
        RawKind::Opaque { .. } => P_SEQ,
    }
}

fn wrapped(e: &RawExpr, ctx: JsCtx, names: JsNames<'_>, required: u8, out: &mut String) {
    if prec(e) < required {
        out.push('(');
        print(e, ctx, names, out);
        out.push(')');
    } else {
        print(e, ctx, names, out);
    }
}

pub fn js_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

pub fn js_number(n: f64) -> String {
    if n.is_nan() {
        "NaN".into()
    } else if n.is_infinite() {
        if n > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn is_js_ident(s: &str) -> bool {
    let mut cs = s.chars();
    cs.next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && cs.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

fn template_chunk(s: &str, out: &mut String) {
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => out.push_str("\\\\"),
            '`' => out.push_str("\\`"),
            '$' if chars.peek() == Some(&'{') => out.push_str("\\$"),
            c => out.push(c),
        }
    }
}

fn print(e: &RawExpr, ctx: JsCtx, names: JsNames<'_>, out: &mut String) {
    match &e.kind {
        RawKind::Lit(l) => out.push_str(&match l {
            Literal::Str(s) => js_string(s),
            Literal::Num(n) => js_number(*n),
            Literal::Bool(b) => b.to_string(),
            Literal::Null => "null".into(),
            Literal::Undefined => "undefined".into(),
        }),
        RawKind::Ident { name, kind } if names(name, kind).is_some() => {
            out.push_str(&names(name, kind).unwrap_or_default())
        }
        RawKind::Ident { name, kind } => match (kind, ctx) {
            (IdentKind::Prop, JsCtx::Server) if name == "*" => out.push_str("props"),
            (IdentKind::Prop, JsCtx::Client) if name == "*" => out.push_str("props()"),
            (IdentKind::Prop, JsCtx::Client) => {
                out.push_str("props()");
                if is_js_ident(name) {
                    out.push('.');
                    out.push_str(name);
                } else {
                    out.push('[');
                    out.push_str(&js_string(name));
                    out.push(']');
                }
            }
            (IdentKind::State, JsCtx::Client) => {
                out.push_str(name);
                out.push_str("()");
            }
            _ => out.push_str(name),
        },
        RawKind::Member {
            target,
            name,
            optional,
        } => {
            let num = matches!(target.kind, RawKind::Lit(Literal::Num(_)));
            if num {
                out.push('(');
                print(target, ctx, names, out);
                out.push(')');
            } else {
                wrapped(target, ctx, names, P_CALL, out);
            }
            out.push_str(if *optional { "?." } else { "." });
            out.push_str(name);
        }
        RawKind::Index { target, index } => {
            wrapped(target, ctx, names, P_CALL, out);
            out.push('[');
            print(index, ctx, names, out);
            out.push(']');
        }
        RawKind::Call { callee, args } => {
            wrapped(callee, ctx, names, P_CALL, out);
            out.push('(');
            list(args, ctx, names, out);
            out.push(')');
        }
        RawKind::Binary { op, left, right } => {
            let p = bin_prec(*op);
            bin_side(*op, left, ctx, names, p, out);
            out.push(' ');
            out.push_str(bin_str(*op));
            out.push(' ');
            bin_side(*op, right, ctx, names, p + 1, out);
        }
        RawKind::Unary { op, value } => {
            out.push_str(match op {
                UnOp::Not => "!",
                UnOp::Neg => "-",
                UnOp::Pos => "+",
                UnOp::Typeof => "typeof ",
            });
            // `- -a`, never `--a`.
            let nested = matches!(value.kind, RawKind::Unary { .. })
                || matches!(value.kind, RawKind::Lit(Literal::Num(n)) if n < 0.0);
            if nested {
                out.push('(');
                print(value, ctx, names, out);
                out.push(')');
            } else {
                wrapped(value, ctx, names, P_UNARY, out);
            }
        }
        RawKind::Cond { test, yes, no } => {
            wrapped(test, ctx, names, P_COND + 1, out);
            out.push_str(" ? ");
            wrapped(yes, ctx, names, P_ASSIGN, out);
            out.push_str(" : ");
            wrapped(no, ctx, names, P_ASSIGN, out);
        }
        RawKind::Template { head, parts } => {
            out.push('`');
            template_chunk(head, out);
            for (p, tail) in parts {
                out.push_str("${");
                print(p, ctx, names, out);
                out.push('}');
                template_chunk(tail, out);
            }
            out.push('`');
        }
        RawKind::Array(items) => {
            out.push('[');
            list(items, ctx, names, out);
            out.push(']');
        }
        RawKind::Object(props) => {
            out.push('{');
            for (i, (k, v)) in props.iter().enumerate() {
                out.push_str(if i == 0 { " " } else { ", " });
                if is_js_ident(k) {
                    out.push_str(k);
                } else {
                    out.push_str(&js_string(k));
                }
                out.push_str(": ");
                wrapped(v, ctx, names, P_ASSIGN, out);
            }
            out.push_str(if props.is_empty() { "}" } else { " }" });
        }
        RawKind::Arrow { params, body, .. } => match body {
            ArrowBody::Expr(b) => {
                out.push('(');
                out.push_str(&params.join(", "));
                out.push_str(") => ");
                if matches!(b.kind, RawKind::Object(_)) {
                    out.push('(');
                    print(b, ctx, names, out);
                    out.push(')');
                } else {
                    wrapped(b, ctx, names, P_ASSIGN, out);
                }
            }
            ArrowBody::Block { source, .. } => out.push_str(source),
        },
        // Never printed into a job or chunk: placement and the tier pass keep
        // JSX out of printed code (see the M1b-2 plan, ruling 1).
        RawKind::Jsx(_) => out.push_str("undefined /* jsx */"),
        RawKind::Opaque { source, .. } => out.push_str(source),
    }
}

fn bin_side(
    op: BinOp,
    side: &RawExpr,
    ctx: JsCtx,
    names: JsNames<'_>,
    required: u8,
    out: &mut String,
) {
    // `??` cannot mix with `&&` / `||` without parentheses.
    let mixes = |o: BinOp| matches!(o, BinOp::And | BinOp::Or | BinOp::Nullish);
    if let RawKind::Binary { op: inner, .. } = &side.kind
        && mixes(op)
        && mixes(*inner)
        && ((op == BinOp::Nullish) != (*inner == BinOp::Nullish))
    {
        out.push('(');
        print(side, ctx, names, out);
        out.push(')');
        return;
    }
    wrapped(side, ctx, names, required, out);
}

fn list(items: &[RawExpr], ctx: JsCtx, names: JsNames<'_>, out: &mut String) {
    for (i, a) in items.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        wrapped(a, ctx, names, P_ASSIGN, out);
    }
}
