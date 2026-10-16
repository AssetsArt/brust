//! F285: the proof that a `useReducer` reducer is a pure function of (state, action). `useReducer` is lowered to a
//! state cell and a dispatch that applies the reducer inside the setter's updater (`setS((p) => reducer(p, a))`), which
//! is React's meaning only when running the reducer has no effect of its own (React may call it twice, or eagerly).
//! The proof reads the function's own AST:
//!
//! * statements: `return`, `const` declarations, `if`, blocks, `switch` and its `break`s; nothing else (no loop,
//!   `try`, `throw`, assignment statement, class, `await`, `yield`);
//! * expressions: literals, identifiers, member and index reads, operators other than assignment, `++`, `--`,
//!   `delete`, conditionals, untagged templates, array and object literals (spreads included), calls to a global
//!   conversion (`String`, `Number`, `Boolean`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`), to `Math` (but
//!   `random`) and to a method that does not mutate its receiver (`map`, `filter`, `slice`, …) whose callbacks are
//!   themselves pure functions in this sense;
//! * no `new`, no tagged template, no call to a function the proof cannot see. A callback of a method that calls it
//!   (`map`, `filter`, …) is an inline function, never a name; the parameters of every function, their defaults and the
//!   defaults of a destructuring pattern are code that runs on each call and are walked like the body.
//!
//! The method allowlist trusts the method NAME (the Array / String contract): a receiver with its own impure `map` would
//! pass. That is accepted: the reducer's inputs are the state and the action, plain data in the code this reads.
use crate::analyze::names::NameTable;
use crate::ir::IdentKind;
use bun_ast as js_ast;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;

const GLOBAL_CALLS: &[&str] = &[
    "String",
    "Number",
    "Boolean",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
];

/// Methods that return a new value and leave the receiver and the arguments alone.
const NON_MUTATING: &[&str] = &[
    "map",
    "filter",
    "slice",
    "concat",
    "includes",
    "indexOf",
    "lastIndexOf",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "some",
    "every",
    "join",
    "flat",
    "flatMap",
    "reduce",
    "at",
    "toString",
    "toUpperCase",
    "toLowerCase",
    "trim",
    "startsWith",
    "endsWith",
    "padStart",
    "padEnd",
    "toFixed",
    "toSorted",
    "toReversed",
    "toSpliced",
    "with",
];

/// Methods that CALL their first argument: it must be an inline function the proof reads. An identifier (`.map(helper)`)
/// names a function the proof cannot see, which may write.
const CALLBACK_METHODS: &[&str] = &[
    "map",
    "filter",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "some",
    "every",
    "flatMap",
    "reduce",
];

/// Whether the function with parameters `args` and body `stmts` is a pure reducer. The parameters count: a default
/// (`(s, a = tick()) => …`) is code that runs on every call, like the body, and so is a destructuring default.
pub fn is_pure(names: &NameTable<'_>, args: &[js_ast::G::Arg], stmts: &[js_ast::Stmt]) -> bool {
    let p = Proof { names };
    p.params(args) && p.stmts(stmts)
}

struct Proof<'a, 'b> {
    names: &'a NameTable<'b>,
}

impl Proof<'_, '_> {
    /// The parameters of a function: each binding pattern and each default value.
    fn params(&self, args: &[js_ast::G::Arg]) -> bool {
        args.iter()
            .all(|a| self.binding(&a.binding) && a.default.as_ref().is_none_or(|d| self.expr(d)))
    }

    /// A binding pattern: a computed key and every default (`{ by = tick() }`, `[x = tick()]`), at any depth.
    fn binding(&self, b: &js_ast::Binding) -> bool {
        use js_ast::b::B;
        match b.data {
            B::BIdentifier(_) | B::BMissing(_) => true,
            B::BArray(arr) => arr.items().iter().all(|i| {
                self.binding(&i.binding) && i.default_value.as_ref().is_none_or(|d| self.expr(d))
            }),
            B::BObject(obj) => obj.properties().iter().all(|p| {
                (!p.flags.contains(js_ast::flags::Property::IsComputed) || self.expr(&p.key))
                    && self.binding(&p.value)
                    && p.default_value.as_ref().is_none_or(|d| self.expr(d))
            }),
        }
    }

    fn stmts(&self, stmts: &[js_ast::Stmt]) -> bool {
        stmts.iter().all(|s| self.stmt(s))
    }

    fn stmt(&self, s: &js_ast::Stmt) -> bool {
        match &s.data {
            S::SReturn(r) => r.value.as_ref().is_none_or(|v| self.expr(v)),
            S::SBlock(b) => self.stmts(b.stmts.slice()),
            S::SIf(i) => {
                self.expr(&i.test)
                    && self.stmt(&i.yes)
                    && i.no.as_ref().is_none_or(|n| self.stmt(n))
            }
            S::SLocal(l) => {
                matches!(l.kind, js_ast::S::Kind::KConst)
                    && l.decls.iter().all(|d| {
                        self.binding(&d.binding) && d.value.as_ref().is_some_and(|v| self.expr(v))
                    })
            }
            S::SSwitch(sw) => {
                self.expr(&sw.test)
                    && sw.cases.slice().iter().all(|c| {
                        c.value.as_ref().is_none_or(|v| self.expr(v)) && self.stmts(c.body.slice())
                    })
            }
            S::SBreak(b) => b.label.is_none(),
            S::STypeScript(_) | S::SEmpty(_) | S::SDirective(_) | S::SComment(_) => true,
            _ => false,
        }
    }

    fn global(&self, r: js_ast::Ref) -> bool {
        matches!(self.names.kind_of(r).1, IdentKind::Global)
    }

    /// A callback argument: a pure arrow or function expression, or any pure expression.
    fn arg(&self, a: &js_ast::Expr) -> bool {
        match &a.data {
            E::EArrow(f) => {
                !f.is_async && self.params(f.args.slice()) && self.stmts(f.body.stmts.slice())
            }
            E::EFunction(f) => {
                !f.func.flags.contains(js_ast::flags::Function::IsAsync)
                    && !f.func.flags.contains(js_ast::flags::Function::IsGenerator)
                    && self.stmts(f.func.body.stmts.slice())
            }
            _ => self.expr(a),
        }
    }

    fn expr(&self, e: &js_ast::Expr) -> bool {
        match &e.data {
            E::EIdentifier(_)
            | E::EImportIdentifier(_)
            | E::EString(_)
            | E::ENumber(_)
            | E::EBoolean(_)
            | E::ENull(_)
            | E::EUndefined(_) => true,
            E::EDot(d) => self.expr(&d.target),
            E::EIndex(i) => self.expr(&i.target) && self.expr(&i.index),
            E::EUnary(u) => {
                matches!(
                    js_ast::OpCode::unary_assign_target(u.op),
                    js_ast::AssignTarget::None
                ) && !matches!(u.op, js_ast::OpCode::UnDelete)
                    && self.expr(&u.value)
            }
            E::EBinary(b) => {
                matches!(b.op.binary_assign_target(), js_ast::AssignTarget::None)
                    && self.expr(&b.left)
                    && self.expr(&b.right)
            }
            E::EIf(i) => self.expr(&i.test) && self.expr(&i.yes) && self.expr(&i.no),
            E::ETemplate(t) => {
                t.tag.is_none() && t.parts.slice().iter().all(|p| self.expr(&p.value))
            }
            E::EArray(a) => a.items.iter().all(|x| self.expr(x)),
            E::ESpread(s) => self.expr(&s.value),
            E::EObject(o) => o.properties.iter().all(|p| {
                matches!(
                    p.kind,
                    js_ast::G::PropertyKind::Normal | js_ast::G::PropertyKind::Spread
                ) && p.key.as_ref().is_none_or(|k| self.expr(k))
                    && p.value.as_ref().is_none_or(|v| self.expr(v))
            }),
            E::ECall(c) => self.call(c),
            _ => false,
        }
    }

    fn call(&self, c: &js_ast::E::Call) -> bool {
        if c.was_jsx_element {
            return false;
        }
        let args = c.args.iter().all(|a| self.arg(a));
        match &c.target.data {
            E::EIdentifier(id) => {
                args && GLOBAL_CALLS.contains(&self.names.name(id.ref_).as_str())
                    && self.global(id.ref_)
            }
            E::EDot(d) => {
                let method = String::from_utf8_lossy(d.name.slice());
                if let E::EIdentifier(id) = &d.target.data
                    && self.names.name(id.ref_) == "Math"
                    && self.global(id.ref_)
                {
                    return args && method != "random";
                }
                // a method that calls its first argument takes it inline, never by name
                let inline_callback = !CALLBACK_METHODS.contains(&method.as_ref())
                    || c.args
                        .first()
                        .is_some_and(|a| matches!(a.data, E::EArrow(_) | E::EFunction(_)));
                args && inline_callback
                    && NON_MUTATING.contains(&method.as_ref())
                    && self.expr(&d.target)
            }
            _ => false,
        }
    }
}
