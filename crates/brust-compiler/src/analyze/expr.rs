//! Reads Bun's visited expressions into brust-owned `RawExpr`s. Total: any shape
//! outside the §6.2 grammar becomes `Opaque` with the printed JS and the reason.
use crate::analyze::names::{NameTable, binding_refs};
use crate::ir::{
    ArrowBody, BinOp, Diagnostic, HandlerDecl, IdentKind, Literal, RawExpr, RawKind, UnOp,
};
use crate::parse::Parsed;
use bun_ast as js_ast;
use js_ast::OpCode;
use js_ast::b::B;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;
use std::collections::HashSet;

/// Shared state of one component read: the name table, the printer for opaque
/// sources, diagnostics, and inline event handlers waiting to be named (`_hN`).
pub struct Reader<'r, 'a> {
    pub names: &'r mut NameTable<'a>,
    print: &'r dyn Fn(Js<'_>) -> String,
    pub diagnostics: Vec<Diagnostic>,
    /// Inline handlers in encounter order; index `i` is `<pending:i>` and becomes `_h{i+1}`.
    pub pending_handlers: Vec<HandlerDecl>,
    /// Loop bindings in scope at the point being read (innermost last).
    pub loop_scope: Vec<String>,
    /// Set while reading the callback of a `.map(…)` call: its JSX body is a
    /// list item body, where `key` belongs.
    map_callback: bool,
}

impl<'r, 'a> Reader<'r, 'a> {
    pub fn new(names: &'r mut NameTable<'a>, print: &'r dyn Fn(Js<'_>) -> String) -> Self {
        Reader {
            names,
            print,
            diagnostics: Vec::new(),
            pending_handlers: Vec::new(),
            loop_scope: Vec::new(),
            map_callback: false,
        }
    }

    pub fn print(&self, e: &js_ast::Expr) -> String {
        (self.print)(Js::Expr(e))
    }

    pub fn print_stmt(&self, s: &js_ast::Stmt) -> String {
        (self.print)(Js::Stmt(s))
    }

    /// `e` as printed JS. Its captures come from the same walk as an arrow's;
    /// JSX anywhere inside overrides `why` with `contains-jsx`.
    pub fn opaque(&self, e: &js_ast::Expr, why: &str) -> RawExpr {
        let mut w = Walk::default();
        w.expr(e);
        let (captures, jsx) = self.captured(w);
        RawExpr {
            loc: loc_of(e),
            kind: RawKind::Opaque {
                source: self.print(e),
                why: if jsx { "contains-jsx" } else { why }.to_string(),
                captures,
            },
        }
    }

    pub fn expr(&mut self, e: &js_ast::Expr) -> RawExpr {
        let loc = loc_of(e);
        let kind = match &e.data {
            E::EString(s) => RawKind::Lit(Literal::Str(estring(s))),
            E::ENumber(n) => RawKind::Lit(Literal::Num(n.value())),
            E::EBoolean(b) | E::EBranchBoolean(b) => RawKind::Lit(Literal::Bool(b.value)),
            E::ENull(_) => RawKind::Lit(Literal::Null),
            E::EUndefined(_) => RawKind::Lit(Literal::Undefined),
            E::EIdentifier(id) => self.ident(id.ref_),
            E::EImportIdentifier(id) => self.ident(id.ref_),
            E::EDot(d) => {
                let name = String::from_utf8_lossy(d.name.slice()).into_owned();
                // `props.x` on a non-destructured props parameter reads prop `x`.
                if let E::EIdentifier(id) = &d.target.data
                    && self.names.is_props_ident(id.ref_)
                {
                    RawKind::Ident {
                        name,
                        kind: IdentKind::Prop,
                    }
                } else {
                    RawKind::Member {
                        target: Box::new(self.expr(&d.target)),
                        name,
                        // Only the link that starts the chain is `?.`; a
                        // continuation is short-circuited by it.
                        optional: matches!(d.optional_chain, Some(js_ast::OptionalChain::Start)),
                    }
                }
            }
            E::EIndex(ix) if matches!(ix.optional_chain, Some(js_ast::OptionalChain::Start)) => {
                return self.opaque(e, "optional index");
            }
            E::EIndex(ix) => RawKind::Index {
                target: Box::new(self.expr(&ix.target)),
                index: Box::new(self.expr(&ix.index)),
            },
            E::ECall(c) if c.was_jsx_element => return self.jsx_expr(e),
            E::ECall(c) => match &c.target.data {
                E::EIdentifier(_) | E::EImportIdentifier(_) | E::EDot(_)
                    if c.optional_chain.is_none() =>
                {
                    let callee = self.expr(&c.target);
                    let is_map = matches!(&c.target.data,
                        E::EDot(d) if d.name.slice() == b"map")
                        && c.args.len() == 1;
                    let mut args = Vec::with_capacity(c.args.len());
                    for a in c.args.iter() {
                        if matches!(a.data, E::ESpread(_)) {
                            return self.opaque(e, "spread argument");
                        }
                        self.map_callback = is_map && matches!(a.data, E::EArrow(_));
                        args.push(self.expr(a));
                        self.map_callback = false;
                    }
                    RawKind::Call {
                        callee: Box::new(callee),
                        args,
                    }
                }
                _ => return self.opaque(e, "call target"),
            },
            E::EBinary(b) => match bin_op(b.op) {
                Some(op) => RawKind::Binary {
                    op,
                    left: Box::new(self.expr(&b.left)),
                    right: Box::new(self.expr(&b.right)),
                },
                None => return self.opaque(e, "operator"),
            },
            E::EUnary(u) => {
                let op = match u.op {
                    OpCode::UnNot => UnOp::Not,
                    OpCode::UnNeg => UnOp::Neg,
                    OpCode::UnPos => UnOp::Pos,
                    OpCode::UnTypeof => UnOp::Typeof,
                    _ => return self.opaque(e, "operator"),
                };
                RawKind::Unary {
                    op,
                    value: Box::new(self.expr(&u.value)),
                }
            }
            E::EIf(i) => RawKind::Cond {
                test: Box::new(self.expr(&i.test)),
                yes: Box::new(self.expr(&i.yes)),
                no: Box::new(self.expr(&i.no)),
            },
            E::ETemplate(t) if t.tag.is_none() => {
                let head = template_text(&t.head);
                let mut parts = Vec::new();
                for p in t.parts.slice() {
                    parts.push((self.expr(&p.value), template_text(&p.tail)));
                }
                RawKind::Template { head, parts }
            }
            E::ETemplate(_) => return self.opaque(e, "tagged template"),
            E::EArray(a) => {
                let mut items = Vec::with_capacity(a.items.len());
                for item in a.items.iter() {
                    if matches!(item.data, E::ESpread(_) | E::EMissing(_)) {
                        return self.opaque(e, "array spread or hole");
                    }
                    items.push(self.expr(item));
                }
                RawKind::Array(items)
            }
            E::EObject(o) => {
                let mut props = Vec::with_capacity(o.properties.len());
                for p in o.properties.iter() {
                    let (Some(key), Some(value)) = (&p.key, &p.value) else {
                        return self.opaque(e, "object property shape");
                    };
                    if !matches!(p.kind, js_ast::G::PropertyKind::Normal)
                        || p.flags.contains(js_ast::flags::Property::IsComputed)
                    {
                        return self.opaque(e, "object spread, accessor or computed key");
                    }
                    let name = match &key.data {
                        E::EString(s) => estring(s),
                        E::ENumber(n) => format_num(n.value()),
                        _ => return self.opaque(e, "object key"),
                    };
                    props.push((name, self.expr(value)));
                }
                RawKind::Object(props)
            }
            E::EArrow(a) => return self.arrow(e, a),
            other => return self.opaque(e, data_name(other)),
        };
        RawExpr { loc, kind }
    }

    fn ident(&self, r: js_ast::Ref) -> RawKind {
        let (name, kind) = self.names.kind_of(r);
        RawKind::Ident { name, kind }
    }

    fn arrow(&mut self, e: &js_ast::Expr, a: &js_ast::E::Arrow) -> RawExpr {
        let list_body = std::mem::take(&mut self.map_callback);
        let mut params = Vec::new();
        for arg in a.args.slice() {
            match arg.binding.data {
                B::BIdentifier(id) if arg.default.is_none() => {
                    params.push(self.names.name(id.r#ref))
                }
                _ => return self.opaque(e, "arrow parameter pattern"),
            }
        }
        if a.is_async {
            return self.opaque(e, "async arrow");
        }
        let stmts = a.body.stmts.slice();
        let body = match stmts {
            [only] if a.prefer_expr => match &only.data {
                S::SReturn(r) => match &r.value {
                    Some(v) if list_body && crate::analyze::jsx::is_jsx(v) => {
                        let node = crate::analyze::jsx::read_list_body(self, v);
                        ArrowBody::Expr(Box::new(RawExpr {
                            loc: loc_of(v),
                            kind: RawKind::Jsx(Box::new(node)),
                        }))
                    }
                    Some(v) => ArrowBody::Expr(Box::new(self.expr(v))),
                    None => ArrowBody::Block {
                        source: self.print(e),
                        captures_only: false,
                    },
                },
                _ => ArrowBody::Block {
                    source: self.print(e),
                    captures_only: false,
                },
            },
            _ => ArrowBody::Block {
                source: self.print(e),
                captures_only: false,
            },
        };
        let (captures, jsx) = self.captures(a);
        if jsx && matches!(body, ArrowBody::Block { .. }) {
            // Ruling 1 (M1b-2 plan): JSX built in a block body is marked on an Opaque.
            return RawExpr {
                loc: loc_of(e),
                kind: RawKind::Opaque {
                    source: self.print(e),
                    why: "contains-jsx".into(),
                    captures,
                },
            };
        }
        RawExpr {
            loc: loc_of(e),
            kind: RawKind::Arrow {
                params,
                body,
                captures,
            },
        }
    }

    /// Identifiers the arrow reads that it does not declare itself, first
    /// occurrence order, deduplicated by symbol.
    /// And whether the arrow builds JSX anywhere inside.
    fn captures(&self, a: &js_ast::E::Arrow) -> (Vec<(String, IdentKind)>, bool) {
        self.captures_of(a.args.slice(), a.body.stmts.slice())
    }

    fn captures_of(
        &self,
        args: &[js_ast::G::Arg],
        body: &[js_ast::Stmt],
    ) -> (Vec<(String, IdentKind)>, bool) {
        let mut w = Walk::default();
        for arg in args {
            w.declare_binding(&arg.binding);
            if let Some(d) = &arg.default {
                w.expr(d);
            }
        }
        w.stmts(body);
        self.captured(w)
    }

    /// The walked identifiers that are read but not declared inside, first
    /// occurrence order, deduplicated by symbol; the generated JSX runtime
    /// bindings are not captures. Second: whether a JSX call was reached.
    fn captured(&self, w: Walk) -> (Vec<(String, IdentKind)>, bool) {
        let jsx = w
            .calls
            .iter()
            .any(|c| matches!(&c.data, E::ECall(call) if call.was_jsx_element));
        let mut seen: Vec<js_ast::Ref> = Vec::new();
        let mut out = Vec::new();
        for r in w.used {
            if self.names.is_jsx_runtime(r)
                || w.declared.iter().any(|d| self.names.same(*d, r))
                || seen.iter().any(|s| self.names.same(*s, r))
            {
                continue;
            }
            seen.push(r);
            out.push(self.names.kind_of(r));
        }
        (out, jsx)
    }

    /// Module-level declarations and their captures: `function f` and each
    /// identifier-bound `const`/`let`/`var` (exported or not).
    pub fn module_scope(&self, ast: &js_ast::Ast<'_>) -> Vec<(String, Vec<(String, IdentKind)>)> {
        let mut out = Vec::new();
        for part in ast.parts.iter() {
            for stmt in part.stmts.slice() {
                match &stmt.data {
                    S::SFunction(f) => {
                        if let Some(n) = &f.func.name {
                            let (captures, _) =
                                self.captures_of(f.func.args.slice(), f.func.body.stmts.slice());
                            out.push((self.names.name(n.ref_), captures));
                        }
                    }
                    S::SLocal(l) => {
                        for d in l.decls.iter() {
                            if let (B::BIdentifier(id), Some(v)) = (d.binding.data, &d.value) {
                                let mut w = Walk::default();
                                w.expr(v);
                                let (captures, _) = self.captured(w);
                                out.push((self.names.name(id.r#ref), captures));
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        out
    }

    /// A `function name(…) {…}` declaration in the component body, read as the
    /// arrow it is equivalent to for the IR (body kept as printed source).
    pub fn function_decl(&self, stmt: &js_ast::Stmt, f: &js_ast::G::Fn) -> RawExpr {
        let loc = stmt.loc.start.max(0) as u32;
        let mut params = Vec::new();
        for arg in f.args.slice() {
            match arg.binding.data {
                B::BIdentifier(id) if arg.default.is_none() => {
                    params.push(self.names.name(id.r#ref))
                }
                _ => {
                    params.clear();
                    break;
                }
            }
        }
        let (captures, jsx) = self.captures_of(f.args.slice(), f.body.stmts.slice());
        if jsx || params.len() != f.args.len() {
            return RawExpr {
                loc,
                kind: RawKind::Opaque {
                    source: self.print_stmt(stmt),
                    why: if jsx {
                        "contains-jsx"
                    } else {
                        "function parameter pattern"
                    }
                    .into(),
                    captures,
                },
            };
        }
        RawExpr {
            loc,
            kind: RawKind::Arrow {
                params,
                body: ArrowBody::Block {
                    source: self.print_stmt(stmt),
                    captures_only: false,
                },
                captures,
            },
        }
    }

    /// JSX in expression position (a ternary arm, a `.map` body outside a child).
    fn jsx_expr(&mut self, e: &js_ast::Expr) -> RawExpr {
        let node = crate::analyze::jsx::read_jsx(self, e);
        RawExpr {
            loc: loc_of(e),
            kind: RawKind::Jsx(Box::new(node)),
        }
    }
}

/// Reads one expression with no surrounding component context (no handler
/// hoisting, no loop scope). Never fails: unknown shapes are `Opaque`.
pub fn read_expr(
    e: &js_ast::Expr,
    names: &mut NameTable<'_>,
    printer: &dyn Fn(Js<'_>) -> String,
) -> RawExpr {
    Reader::new(names, printer).expr(e)
}

pub fn loc_of(e: &js_ast::Expr) -> u32 {
    e.loc.start.max(0) as u32
}

fn bin_op(op: OpCode) -> Option<BinOp> {
    Some(match op {
        OpCode::BinAdd => BinOp::Add,
        OpCode::BinSub => BinOp::Sub,
        OpCode::BinMul => BinOp::Mul,
        OpCode::BinDiv => BinOp::Div,
        OpCode::BinRem => BinOp::Rem,
        OpCode::BinLooseEq => BinOp::Eq,
        OpCode::BinLooseNe => BinOp::Ne,
        OpCode::BinStrictEq => BinOp::StrictEq,
        OpCode::BinStrictNe => BinOp::StrictNe,
        OpCode::BinLt => BinOp::Lt,
        OpCode::BinLe => BinOp::Le,
        OpCode::BinGt => BinOp::Gt,
        OpCode::BinGe => BinOp::Ge,
        OpCode::BinLogicalAnd => BinOp::And,
        OpCode::BinLogicalOr => BinOp::Or,
        OpCode::BinNullishCoalescing => BinOp::Nullish,
        _ => return None,
    })
}

/// The string value of a literal, following the rope and decoding UTF-16.
pub fn estring(s: &js_ast::E::EString) -> String {
    let mut out = String::new();
    let mut cur = Some(s);
    while let Some(part) = cur {
        if part.is_utf8() {
            out.push_str(&String::from_utf8_lossy(part.slice8()));
        } else {
            out.push_str(&String::from_utf16_lossy(part.slice16()));
        }
        cur = part.next.as_deref();
    }
    out
}

fn template_text(t: &js_ast::E::TemplateContents) -> String {
    match t {
        js_ast::E::TemplateContents::Cooked(s) => estring(s),
        js_ast::E::TemplateContents::Raw(r) => String::from_utf8_lossy(r.slice()).into_owned(),
    }
}

fn format_num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn data_name(d: &E) -> &'static str {
    match d {
        E::EArray(_) => "EArray",
        E::EUnary(_) => "EUnary",
        E::EBinary(_) => "EBinary",
        E::EClass(_) => "EClass",
        E::ENew(_) => "ENew",
        E::EFunction(_) => "EFunction",
        E::ECall(_) => "ECall",
        E::EDot(_) => "EDot",
        E::EIndex(_) => "EIndex",
        E::EArrow(_) => "EArrow",
        E::EJsxElement(_) => "EJsxElement",
        E::EObject(_) => "EObject",
        E::ESpread(_) => "ESpread",
        E::ETemplate(_) => "ETemplate",
        E::ERegExp(_) => "ERegExp",
        E::EAwait(_) => "EAwait",
        E::EYield(_) => "EYield",
        E::EIf(_) => "EIf",
        E::EImport(_) => "EImport",
        E::EThis(_) => "EThis",
        E::ESuper(_) => "ESuper",
        E::EBigInt(_) => "EBigInt",
        E::EPrivateIdentifier(_) => "EPrivateIdentifier",
        E::ENewTarget(_) => "ENewTarget",
        E::EImportMeta(_) => "EImportMeta",
        E::EMissing(_) => "EMissing",
        _ => "unsupported expression",
    }
}

/// Collects declared bindings and used identifier refs below a function body.
/// A small structural walk; the React Compiler is not used for this.
#[derive(Default)]
pub struct Walk {
    pub declared: Vec<js_ast::Ref>,
    pub used: Vec<js_ast::Ref>,
    /// Every call expression reached, outermost first.
    pub calls: Vec<js_ast::Expr>,
}

impl Walk {
    pub fn declare_binding(&mut self, b: &js_ast::Binding) {
        binding_refs(b, &mut self.declared);
        self.binding_defaults(b);
    }

    fn binding_defaults(&mut self, b: &js_ast::Binding) {
        match b.data {
            B::BArray(arr) => {
                for item in arr.items() {
                    if let Some(d) = &item.default_value {
                        self.expr(d);
                    }
                    self.binding_defaults(&item.binding);
                }
            }
            B::BObject(obj) => {
                for p in obj.properties() {
                    self.expr(&p.key);
                    if let Some(d) = &p.default_value {
                        self.expr(d);
                    }
                    self.binding_defaults(&p.value);
                }
            }
            B::BIdentifier(_) | B::BMissing(_) => {}
        }
    }

    fn func(&mut self, f: &js_ast::G::Fn) {
        if let Some(name) = &f.name {
            self.declared.push(name.ref_);
        }
        for arg in f.args.slice() {
            self.declare_binding(&arg.binding);
            if let Some(d) = &arg.default {
                self.expr(d);
            }
        }
        self.stmts(f.body.stmts.slice());
    }

    pub fn stmts(&mut self, stmts: &[js_ast::Stmt]) {
        for s in stmts {
            self.stmt(s);
        }
    }

    pub fn stmt(&mut self, s: &js_ast::Stmt) {
        match &s.data {
            S::SBlock(b) => self.stmts(b.stmts.slice()),
            S::SExpr(x) => self.expr(&x.value),
            S::SLocal(l) => {
                for d in l.decls.iter() {
                    self.declare_binding(&d.binding);
                    if let Some(v) = &d.value {
                        self.expr(v);
                    }
                }
            }
            S::SReturn(r) => {
                if let Some(v) = &r.value {
                    self.expr(v);
                }
            }
            S::SThrow(t) => self.expr(&t.value),
            S::SIf(i) => {
                self.expr(&i.test);
                self.stmt(&i.yes);
                if let Some(no) = &i.no {
                    self.stmt(no);
                }
            }
            S::SFunction(f) => self.func(&f.func),
            S::SFor(f) => {
                if let Some(init) = &f.init {
                    self.stmt(init);
                }
                if let Some(t) = &f.test {
                    self.expr(t);
                }
                if let Some(u) = &f.update {
                    self.expr(u);
                }
                self.stmt(&f.body);
            }
            S::SForIn(f) => {
                self.stmt(&f.init);
                self.expr(&f.value);
                self.stmt(&f.body);
            }
            S::SForOf(f) => {
                self.stmt(&f.init);
                self.expr(&f.value);
                self.stmt(&f.body);
            }
            S::SWhile(w) => {
                self.expr(&w.test);
                self.stmt(&w.body);
            }
            S::SDoWhile(w) => {
                self.stmt(&w.body);
                self.expr(&w.test);
            }
            S::STry(t) => {
                self.stmts(t.body.slice());
                if let Some(c) = &t.catch {
                    if let Some(b) = &c.binding {
                        self.declare_binding(b);
                    }
                    self.stmts(c.body.slice());
                }
                if let Some(f) = &t.finally {
                    self.stmts(f.stmts.slice());
                }
            }
            S::SSwitch(sw) => {
                self.expr(&sw.test);
                for c in sw.cases.slice() {
                    if let Some(v) = &c.value {
                        self.expr(v);
                    }
                    self.stmts(c.body.slice());
                }
            }
            S::SLabel(l) => self.stmt(&l.stmt),
            _ => {}
        }
    }

    pub fn expr(&mut self, e: &js_ast::Expr) {
        match &e.data {
            E::EIdentifier(id) => self.used.push(id.ref_),
            E::EImportIdentifier(id) => self.used.push(id.ref_),
            E::EArray(a) => a.items.iter().for_each(|x| self.expr(x)),
            E::EUnary(u) => self.expr(&u.value),
            E::EBinary(b) => {
                self.expr(&b.left);
                self.expr(&b.right);
            }
            E::ENew(n) => {
                self.expr(&n.target);
                n.args.iter().for_each(|x| self.expr(x));
            }
            E::ECall(c) => {
                self.calls.push(*e);
                self.expr(&c.target);
                c.args.iter().for_each(|x| self.expr(x));
            }
            E::EDot(d) => self.expr(&d.target),
            E::EIndex(i) => {
                self.expr(&i.target);
                self.expr(&i.index);
            }
            E::EArrow(a) => {
                for arg in a.args.slice() {
                    self.declare_binding(&arg.binding);
                    if let Some(d) = &arg.default {
                        self.expr(d);
                    }
                }
                self.stmts(a.body.stmts.slice());
            }
            E::EFunction(f) => self.func(&f.func),
            E::EObject(o) => {
                for p in o.properties.iter() {
                    if let Some(k) = &p.key {
                        self.expr(k);
                    }
                    if let Some(v) = &p.value {
                        self.expr(v);
                    }
                    if let Some(i) = &p.initializer {
                        self.expr(i);
                    }
                }
            }
            E::ESpread(s) => self.expr(&s.value),
            E::ETemplate(t) => {
                if let Some(tag) = &t.tag {
                    self.expr(tag);
                }
                for p in t.parts.slice() {
                    self.expr(&p.value);
                }
            }
            E::EAwait(a) => self.expr(&a.value),
            E::EYield(y) => {
                if let Some(v) = &y.value {
                    self.expr(v);
                }
            }
            E::EIf(i) => {
                self.expr(&i.test);
                self.expr(&i.yes);
                self.expr(&i.no);
            }
            _ => {}
        }
    }
}

/// Every symbol a sequence of statements declares at its own level and below.
pub fn declared_in(stmts: &[js_ast::Stmt]) -> HashSet<u32> {
    let mut w = Walk::default();
    w.stmts(stmts);
    w.declared.iter().map(|r| r.inner_index()).collect()
}

/// What a [`Reader`]'s printer can print.
#[derive(Clone, Copy)]
pub enum Js<'x> {
    Expr(&'x js_ast::Expr),
    Stmt(&'x js_ast::Stmt),
}

/// Prints `js` as JavaScript; see [`print_expr_js`].
pub fn print_js(parsed: &Parsed, ast: &js_ast::Ast<'_>, js: Js<'_>) -> String {
    match js {
        Js::Expr(e) => print_expr_js(parsed, ast, e),
        Js::Stmt(s) => print_with(parsed, ast, || *s),
    }
}

/// Prints one expression as JavaScript with `bun_js_printer`. There is no public
/// single-expression entry (`print_json` uses an empty symbol table and JSON
/// mode), so this prints a one-statement module `return <e>;` through
/// `bun_js_printer::print_ast` with a copy of the module's symbol names and
/// strips the `return ` / `;` around it. Import records are left out on
/// purpose: the printer then prints every import binding by its local name.
pub fn print_expr_js(parsed: &Parsed, ast: &js_ast::Ast<'_>, e: &js_ast::Expr) -> String {
    let text = print_with(parsed, ast, || {
        js_ast::Stmt::alloc(js_ast::S::Return { value: Some(*e) }, e.loc)
    });
    let text = text.strip_suffix(';').unwrap_or(&text);
    let text = text.strip_prefix("return").unwrap_or(text);
    text.trim().to_string()
}

/// Prints the one statement `make` builds (inside an allocation scope over the
/// module's arena) as a module of its own.
fn print_with(
    parsed: &Parsed,
    ast: &js_ast::Ast<'_>,
    make: impl FnOnce() -> js_ast::Stmt,
) -> String {
    let arena = parsed.arena();
    let mut ast_alloc = js_ast::ASTMemoryAllocator::borrowing(arena);
    let _scope = ast_alloc.enter();

    let stmts = arena.alloc_slice_copy(&[make()]);
    let mut tree = js_ast::Ast::empty_in(arena);
    tree.parts.push(js_ast::Part {
        stmts: js_ast::StoreSlice::new_mut(stmts),
        ..Default::default()
    });
    let symbols: Vec<js_ast::Symbol> = ast
        .symbols
        .as_slice()
        .iter()
        .map(|s| js_ast::Symbol {
            original_name: s.original_name,
            link: core::cell::Cell::new(s.link.get()),
            kind: s.kind,
            import_item_status: s.import_item_status,
            ..Default::default()
        })
        .collect();
    let map = js_ast::symbol::Map::init_with_one_list(symbols);
    let mut out = bun_js_printer::BufferPrinter::init(bun_js_printer::BufferWriter::init());
    let printed = bun_js_printer::print_ast::<_, false, false>(
        &mut out,
        arena,
        &tree,
        map,
        parsed.source(),
        bun_js_printer::Options::default(),
    );
    if printed.is_err() {
        return String::from("/* unprintable */");
    }
    String::from_utf8_lossy(out.ctx.get_written())
        .trim_end()
        .to_string()
}
