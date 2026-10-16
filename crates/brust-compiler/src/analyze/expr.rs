//! Reads Bun's visited expressions into brust-owned `RawExpr`s. Total: any shape
//! outside the §6.2 grammar becomes `Opaque` with the printed JS and the reason.
use crate::analyze::names::{Aliases, NameTable, binding_refs};
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
    print: &'r Printer<'r>,
    pub diagnostics: Vec<Diagnostic>,
    /// Inline handlers in encounter order; index `i` is `<pending:i>` and becomes `_h{i+1}`.
    pub pending_handlers: Vec<HandlerDecl>,
    /// Loop bindings in scope at the point being read (innermost last).
    pub loop_scope: Vec<String>,
    /// Set while reading the callback of a `.map(…)` call: its JSX body is a
    /// list item body, where `key` belongs.
    map_callback: bool,
    /// The context Providers read in the template (S2): what this component hands to its consumers.
    pub provides: Vec<crate::ir::ProvideDecl>,
    /// B7: render-prop arrows written on components, read as templates (`ir::RenderProp`).
    pub render_props: Vec<crate::ir::RenderProp>,
    /// B7: the code being read is the verbatim copy of an arrow whose body was also read as a template. The copy is
    /// used only if its call site cannot be specialised, and that call site then falls back anyway (`island-prop`),
    /// so what the copy reads as written (`...rest`, a snapshot ref, a context local) is not an escape of this component.
    pub verbatim_unused: bool,
    /// `useId()` calls hoisted out of the return expression (R34.120), by call address: each reads as the local the
    /// component declares for it.
    pub hoisted_calls: std::collections::HashMap<usize, String>,
}

impl<'r, 'a> Reader<'r, 'a> {
    pub fn new(names: &'r mut NameTable<'a>, print: &'r Printer<'r>) -> Self {
        Reader {
            names,
            print,
            diagnostics: Vec::new(),
            pending_handlers: Vec::new(),
            loop_scope: Vec::new(),
            map_callback: false,
            provides: Vec::new(),
            render_props: Vec::new(),
            verbatim_unused: false,
            hoisted_calls: std::collections::HashMap::new(),
        }
    }

    pub fn print(&self, e: &js_ast::Expr) -> String {
        (self.print)(Js::Expr(e), self.names.print_aliases())
    }

    pub fn print_stmt(&self, s: &js_ast::Stmt) -> String {
        (self.print)(Js::Stmt(s), self.names.print_aliases())
    }

    /// `e` as printed JS. Its captures come from the same walk as an arrow's;
    /// JSX anywhere inside overrides `why` with `contains-jsx`.
    pub fn opaque(&self, e: &js_ast::Expr, why: &str) -> RawExpr {
        let mut w = Walk::default();
        w.expr(e);
        self.rest_in_verbatim(&w, loc_of(e));
        self.snapshot_in_verbatim(&w, loc_of(e));
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

    /// A call argument. B3: the forwarded ref handed on whole (`useComposedRefs(forwardedRef, …)`, `composeRefs(ref)`) is
    /// `null`: a native component is never given a ref (a call site that passes `ref` already falls back,
    /// `forwardref-ref`), which is what React hands a `forwardRef` render function when its caller passes none. Any
    /// other read of it (a member, an operand, a binding) stays a fallback.
    pub fn arg(&mut self, a: &js_ast::Expr) -> RawExpr {
        if let E::EIdentifier(id) = &a.data
            && self.names.is_forwarded_ref(id.ref_)
        {
            self.names.note_forwarded_ref_dropped(a.loc.start);
            return RawExpr {
                loc: loc_of(a),
                kind: RawKind::Lit(Literal::Null),
            };
        }
        self.expr(a)
    }

    pub fn expr(&mut self, e: &js_ast::Expr) -> RawExpr {
        let loc = loc_of(e);
        let kind = match &e.data {
            E::EString(s) => RawKind::Lit(Literal::Str(estring(s))),
            E::ENumber(n) => RawKind::Lit(Literal::Num(n.value())),
            E::EBoolean(b) | E::EBranchBoolean(b) => RawKind::Lit(Literal::Bool(b.value)),
            E::ENull(_) => RawKind::Lit(Literal::Null),
            E::EUndefined(_) => RawKind::Lit(Literal::Undefined),
            // The bare rest object is only a spread source (`jsx.rs`); as a value it is not read.
            E::EIdentifier(id) if self.names.is_rest(id.ref_) => {
                if self.names.rest_escape.get().is_none() {
                    self.names.rest_escape.set(Some(loc));
                }
                return self.opaque(e, "props rest object");
            }
            // A context local read as a value (not `context.field`): brust cannot narrow it (fail closed).
            // R34.142: unless the context has a literal default (`createContext(undefined)`): its whole value is the hidden
            // prop `__whole`, the default when no Provider is above the page.
            E::EIdentifier(id)
                if let Some(ctx) = self.names.ctx_local(id.ref_).map(str::to_string)
                    && self.names.scalar_default(&ctx).is_some() =>
            {
                self.names
                    .note_ctx_field(&ctx, crate::analyze::hooks::WHOLE_FIELD);
                RawKind::Ident {
                    name: crate::ir::ctx_prop(&ctx, crate::analyze::hooks::WHOLE_FIELD),
                    kind: IdentKind::Prop,
                }
            }
            E::EIdentifier(id) if self.names.ctx_local(id.ref_).is_some() => {
                if self.names.ctx_escape.get().is_none() {
                    self.names.ctx_escape.set(Some(loc));
                }
                return self.opaque(e, "context value");
            }
            // B4: `.current` of a ref that is never written is its initial value, held as a state cell no one sets.
            E::EDot(d)
                if d.name.slice() == b"current"
                    && matches!(&d.target.data, E::EIdentifier(t) if self.names.is_snapshot_ref(t.ref_)) =>
            {
                let E::EIdentifier(t) = &d.target.data else {
                    unreachable!()
                };
                self.ident(t.ref_)
            }
            E::EIdentifier(id) => self.ident(id.ref_),
            E::EImportIdentifier(id) => self.ident(id.ref_),
            // `context.field` of a context local reads the hidden prop of that field (S2).
            E::EDot(d)
                if let E::EIdentifier(t) = &d.target.data
                    && let Some(ctx) = self.names.ctx_local(t.ref_).map(str::to_string) =>
            {
                let field = String::from_utf8_lossy(d.name.slice()).into_owned();
                if let Some(what) = crate::analyze::context::field_problem(&field) {
                    self.diagnostics.push(Diagnostic::fallback(
                        "context-shape",
                        format!("the context field `{field}` {what}"),
                        loc,
                        "rename the field to a plain identifier, or keep this component in React",
                    ));
                }
                self.names.note_ctx_field(&ctx, &field);
                RawKind::Ident {
                    name: crate::ir::ctx_prop(&ctx, &field),
                    kind: IdentKind::Prop,
                }
            }
            E::EDot(d)
                if let Some(kind) =
                    self.rest_member(&d.target, &String::from_utf8_lossy(d.name.slice())) =>
            {
                kind
            }
            E::EDot(d) => {
                let name = String::from_utf8_lossy(d.name.slice()).into_owned();
                // `props.x` on a non-destructured props parameter reads prop `x`.
                if let E::EIdentifier(id) = &d.target.data
                    && self.names.is_props_ident(id.ref_)
                {
                    self.note_prop_read(&name, loc);
                    RawKind::Ident {
                        name,
                        kind: IdentKind::Prop,
                    }
                } else if let Some(kind) = self.store_read(&d.target, &name) {
                    // `s.count` / `s?.count` on a `useStore` view: the view is never
                    // nullish, so the optional link reads the same key (M3-F D7).
                    kind
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
            // `rest["data-x"]` reads prop `data-x` (R34.14).
            E::EIndex(ix)
                if let E::EString(key) = &ix.index.data
                    && let Some(kind) = self.rest_member(&ix.target, &estring(key)) =>
            {
                kind
            }
            // `s["count"]` on a `useStore` view reads key `count`.
            E::EIndex(ix)
                if let E::EString(key) = &ix.index.data
                    && let Some(kind) = self.store_read(&ix.target, &estring(key)) =>
            {
                kind
            }
            E::EIndex(ix) => RawKind::Index {
                target: Box::new(self.expr(&ix.target)),
                index: Box::new(self.expr(&ix.index)),
            },
            E::ECall(c) if c.was_jsx_element => return self.jsx_expr(e),
            E::ECall(c)
                if let Some(name) =
                    self.hoisted_calls.get(&crate::analyze::hooks::call_addr(c)) =>
            {
                RawKind::Ident {
                    name: name.clone(),
                    kind: IdentKind::Local,
                }
            }
            E::ECall(c) => match &c.target.data {
                E::EIdentifier(_) | E::EImportIdentifier(_) | E::EDot(_)
                    if c.optional_chain.is_none() =>
                {
                    let callee = self.expr(&c.target);
                    let is_map = matches!(&c.target.data,
                        E::EDot(d) if d.name.slice() == b"map")
                        && c.args.len() == 1;
                    let user_fn = matches!(
                        &callee.kind,
                        RawKind::Ident {
                            kind: IdentKind::Import { .. } | IdentKind::Local,
                            ..
                        }
                    );
                    let mut args = Vec::with_capacity(c.args.len());
                    for a in c.args.iter() {
                        if matches!(a.data, E::ESpread(_)) {
                            return self.opaque(e, "spread argument");
                        }
                        self.map_callback = is_map && matches!(a.data, E::EArrow(_));
                        // B3: only for a function of the app or a package (evaluated in JS, where the ref IS `null`), never
                        // a builtin the server prints its own way (`String(ref)`).
                        args.push(if user_fn { self.arg(a) } else { self.expr(a) });
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
            // B5: `{ ...a, k: v, ...b }` is `Object.assign({}, a, { k: v }, b)`: each spread is a plain read of `a` / `b`
            // (`...props.style` of the `...rest` object reads the prop `style`), so the object stays structured
            // instead of printing the rest object as written.
            E::EObject(o)
                if o.properties
                    .iter()
                    .any(|p| matches!(p.kind, js_ast::G::PropertyKind::Spread)) =>
            {
                let mut args = vec![RawExpr {
                    loc,
                    kind: RawKind::Object(Vec::new()),
                }];
                let mut seg: Vec<(String, RawExpr)> = Vec::new();
                for p in o.properties.iter() {
                    if matches!(p.kind, js_ast::G::PropertyKind::Spread) {
                        let Some(value) = &p.value else {
                            return self.opaque(e, "object spread shape");
                        };
                        if !seg.is_empty() {
                            args.push(RawExpr {
                                loc,
                                kind: RawKind::Object(std::mem::take(&mut seg)),
                            });
                        }
                        args.push(self.expr(value));
                        continue;
                    }
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
                    seg.push((name, self.expr(value)));
                }
                if !seg.is_empty() {
                    args.push(RawExpr {
                        loc,
                        kind: RawKind::Object(seg),
                    });
                }
                RawKind::Call {
                    callee: Box::new(RawExpr {
                        loc,
                        kind: RawKind::Member {
                            target: Box::new(RawExpr {
                                loc,
                                kind: RawKind::Ident {
                                    name: "Object".into(),
                                    kind: IdentKind::Global,
                                },
                            }),
                            name: "assign".into(),
                            optional: false,
                        },
                    }),
                    args,
                }
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

    /// `<view>.<member>` when `target` is a `useStore` view: `Ident { "s.count", Store }`.
    fn store_read(&self, target: &js_ast::Expr, member: &str) -> Option<RawKind> {
        let E::EIdentifier(id) = &target.data else {
            return None;
        };
        let handle = self.names.store_view(id.ref_)?;
        Some(RawKind::Ident {
            name: format!("{}.{member}", self.names.name(id.ref_)),
            kind: IdentKind::Store {
                handle: handle.into(),
                key: Some(member.into()),
            },
        })
    }

    fn ident(&self, r: js_ast::Ref) -> RawKind {
        let (name, kind) = self.names.kind_of(r);
        RawKind::Ident { name, kind }
    }

    /// Code printed as written that reads the props `...rest` object would see the whole props
    /// (named keys included): recorded so the component falls back (R34.14).
    /// B4: a ref held as a state cell is read as `.current` only in structured code; printed as written it would read
    /// `.current` off the value. Recorded so the component keeps the old `ref-in-render` fallback.
    fn snapshot_in_verbatim(&self, w: &Walk, loc: u32) {
        if self.verbatim_unused {
            return;
        }
        if self.names.snapshot_escape.get().is_none()
            && w.used.iter().any(|r| self.names.is_snapshot_ref(*r))
        {
            self.names.snapshot_escape.set(Some(loc));
        }
    }

    fn rest_in_verbatim(&self, w: &Walk, loc: u32) {
        if self.verbatim_unused {
            return;
        }
        if self.names.rest_escape.get().is_none() && w.used.iter().any(|r| self.names.is_rest(*r)) {
            self.names.rest_escape.set(Some(loc));
        }
        // A context local (`const c = useContext(Ctx)`) is not a value in the chunk: `c.field` is read as a hidden prop
        // by the structured reader only. Printed as written it would be an undefined name (R34.103).
        if self.names.ctx_escape.get().is_none()
            && w.used.iter().any(|r| self.names.ctx_local(*r).is_some())
        {
            self.names.ctx_escape.set(Some(loc));
        }
    }

    /// F168: the template prints a prop read as its bare name, so a name the template binds itself (`loop`, `range`,
    /// ...), a keyword or a non-identifier is shadowed or misread. The first such read is reported once per component
    /// (`prop-jinja-name` / `prop-quoted-key`, a fallback), whether the prop is destructured or read as a member.
    fn note_prop_read(&self, name: &str, loc: u32) {
        if self.names.prop_read_problem.borrow().is_some() {
            return;
        }
        if let Some((code, what)) = crate::analyze::names::template_name_problem(name) {
            *self.names.prop_read_problem.borrow_mut() = Some((loc, name.to_string(), code, what));
        }
    }

    /// `rest.k`: prop `k`, or `undefined` when the pattern names `k` (it is not in the rest).
    fn rest_member(&self, target: &js_ast::Expr, key: &str) -> Option<RawKind> {
        let E::EIdentifier(id) = &target.data else {
            return None;
        };
        if !self.names.is_rest(id.ref_) {
            return None;
        }
        Some(if self.names.named_props().iter().any(|n| n == key) {
            RawKind::Lit(Literal::Undefined)
        } else {
            self.note_prop_read(key, loc_of(target));
            RawKind::Ident {
                name: key.to_string(),
                kind: IdentKind::Prop,
            }
        })
    }

    fn arrow(&mut self, e: &js_ast::Expr, a: &js_ast::E::Arrow) -> RawExpr {
        let list_body = std::mem::take(&mut self.map_callback);
        let mut params = Vec::new();
        for (i, arg) in a.args.slice().iter().enumerate() {
            match arg.binding.data {
                // `(...args) => …`: the rest parameter keeps its `...` in the name, so it prints as written (and, as no
                // name a body reads, an evaluator that binds parameters by name refuses a function that has one)
                B::BIdentifier(id) if arg.default.is_none() => {
                    let rest = a.has_rest_arg && i + 1 == a.args.len();
                    let name = self.names.name(id.r#ref);
                    params.push(if rest { format!("...{name}") } else { name })
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
                    Some(v) if list_body && crate::analyze::jsx::is_list_body(v) => {
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
        if matches!(body, ArrowBody::Block { .. }) {
            let mut w = Walk::default();
            for arg in a.args.slice() {
                w.declare_binding(&arg.binding);
            }
            w.stmts(stmts);
            self.rest_in_verbatim(&w, loc_of(e));
        }
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
        if w.import_meta {
            // Seen by the dependency pass as a global no build-time slot may read.
            out.push(("import.meta".to_string(), IdentKind::Global));
        }
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
    #[allow(clippy::type_complexity)]
    pub fn module_scope(
        &mut self,
        ast: &js_ast::Ast<'_>,
    ) -> (
        Vec<(String, Vec<(String, IdentKind)>)>,
        Vec<crate::ir::ModuleDecl>,
    ) {
        let mut out = Vec::new();
        let mut decls = Vec::new();
        let mutated = crate::analyze::use_scan::unsafe_to_fold(ast, &*self.names);
        let strip = |s: String| s.strip_prefix("export ").map(str::to_string).unwrap_or(s);
        let module = crate::analyze::stores::Module::new(ast);
        for part in ast.parts.iter() {
            for stmt in part.stmts.slice() {
                match &stmt.data {
                    S::SFunction(f) => {
                        let stmt_source = strip(self.print_stmt(stmt));
                        if let Some(n) = &f.func.name {
                            let (captures, _) =
                                self.captures_of(f.func.args.slice(), f.func.body.stmts.slice());
                            let name = self.names.name(n.ref_);
                            out.push((name.clone(), captures));
                            decls.push(crate::ir::ModuleDecl {
                                names: vec![name],
                                source: stmt_source,
                                consts: vec![],
                            });
                        }
                    }
                    S::SLocal(l) => {
                        let stmt_source = strip(self.print_stmt(stmt));
                        let mut names = Vec::new();
                        let mut consts = Vec::new();
                        for d in l.decls.iter() {
                            // `const X = forwardRef(function (props, ref) {…})` is a component, declared like a
                            // function: its parameters are not module-level values to fold (R34.63).
                            if let (B::BIdentifier(id), Some(v)) = (d.binding.data, &d.value)
                                && let Some(f) =
                                    crate::analyze::component::forward_ref_callback(&module, v)
                            {
                                let (captures, _) =
                                    self.captures_of(f.args.slice(), f.body.stmts.slice());
                                let name = self.names.name(id.r#ref);
                                names.push(name.clone());
                                out.push((name, captures));
                                continue;
                            }
                            if let (B::BIdentifier(id), Some(v)) = (d.binding.data, &d.value) {
                                let mut w = Walk::default();
                                w.expr(v);
                                let (captures, _) = self.captured(w);
                                let name = self.names.name(id.r#ref);
                                names.push(name.clone());
                                if matches!(l.kind, js_ast::S::Kind::KConst) {
                                    // Reading the initializer must leave no diagnostic or
                                    // handler behind: it is only a candidate for folding.
                                    let (nd, nh) =
                                        (self.diagnostics.len(), self.pending_handlers.len());
                                    let value = self.expr(v);
                                    self.diagnostics.truncate(nd);
                                    self.pending_handlers.truncate(nh);
                                    consts.push(crate::ir::ConstVal {
                                        name: name.clone(),
                                        value,
                                        mutated: mutated.contains(&id.r#ref.inner_index()),
                                    });
                                }
                                out.push((name, captures));
                            }
                        }
                        if !names.is_empty() {
                            decls.push(crate::ir::ModuleDecl {
                                names,
                                source: stmt_source,
                                consts,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        (out, decls)
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
pub fn read_expr(e: &js_ast::Expr, names: &mut NameTable<'_>, printer: &Printer<'_>) -> RawExpr {
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

pub(crate) fn template_text(t: &js_ast::E::TemplateContents) -> String {
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

pub(crate) fn data_name(d: &E) -> &'static str {
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

/// The identifier a member / index chain starts from (`a` of `a.b[c].d`).
pub fn chain_root(e: &js_ast::Expr) -> Option<js_ast::Ref> {
    match &e.data {
        E::EIdentifier(id) => Some(id.ref_),
        E::EImportIdentifier(id) => Some(id.ref_),
        E::EDot(d) => chain_root(&d.target),
        E::EIndex(i) => chain_root(&i.target),
        _ => None,
    }
}

/// F230: the roots whose object `e` may be (not a copy): an identifier or a member chain of one, through `?:`, `&&`,
/// `||`, `??` and a comma's last operand.
pub fn alias_roots(e: &js_ast::Expr) -> Vec<js_ast::Ref> {
    match &e.data {
        E::EIf(c) => {
            let mut v = alias_roots(&c.yes);
            v.extend(alias_roots(&c.no));
            v
        }
        E::EBinary(b)
            if matches!(
                b.op,
                OpCode::BinLogicalAnd | OpCode::BinLogicalOr | OpCode::BinNullishCoalescing
            ) =>
        {
            let mut v = alias_roots(&b.left);
            v.extend(alias_roots(&b.right));
            v
        }
        E::EBinary(b) if matches!(b.op, OpCode::BinComma) => alias_roots(&b.right),
        _ => chain_root(e).into_iter().collect(),
    }
}

/// Collects declared bindings and used identifier refs below a function body.
/// A small structural walk; the React Compiler is not used for this.
#[derive(Default)]
pub struct Walk {
    pub declared: Vec<js_ast::Ref>,
    pub used: Vec<js_ast::Ref>,
    /// The same reads with the start of the identifier expression (a read is told apart by where it is, not counted).
    pub used_at: Vec<(js_ast::Ref, i32)>,
    /// Every call expression reached, outermost first.
    pub calls: Vec<js_ast::Expr>,
    /// Location of the first dynamic `import()` reached (F38): the printer
    /// cannot print one (no import record), so such code is never printed.
    pub dynamic_import: Option<u32>,
    /// `import.meta` (`.env`, `.url`, `.dir`) is read: ambient input of the build host (L2).
    pub import_meta: bool,
    /// Identifiers written by an assignment or `++`/`--` (the left side's own bindings, not
    /// a member target's object).
    pub assigned: Vec<js_ast::Ref>,
    /// The root identifiers of other member / index writes (`x.a++`, `delete x.a`, `[x.a] = …`): an object written through.
    pub member_written: Vec<js_ast::Ref>,
    /// `(root, value)` of each `x.a = value` / `x[k] op= value` assignment (not in `member_written`).
    pub member_writes: Vec<(js_ast::Ref, js_ast::Expr)>,
    /// A member / index assignment whose chain does not start at an identifier (`get().a = …`): what it writes is unknown.
    pub opaque_write: bool,
    /// `(binding, read)`: a binding declared or assigned from a value that reads `read` (`const s = slots`,
    /// `s = { a: slots }`), so writing through the binding may write into `read`.
    pub flows: Vec<(js_ast::Ref, js_ast::Ref)>,
    /// F230: `(binding, root)`: a binding declared or assigned as an alias of `root`'s object (`const l = list`,
    /// `l = cfg.items`, `x = a ?? b`), not from a computed value (`const r = f(list)`), which `flows` also records.
    pub aliases: Vec<(js_ast::Ref, js_ast::Ref)>,
    /// F230: only code that runs where it stands: a function's body is not walked unless the function is called right
    /// there (`(() => { … })()`); a nested function in it is not walked either.
    pub shallow: bool,
    /// `(base, member, base start)` of each `base.member` / `base['member']` read whose base is an identifier; the member
    /// is empty for a computed one (`base[key]`). The base is also in `used_at`.
    pub member_reads: Vec<(js_ast::Ref, String, i32)>,
    /// B4: the start of each identifier expression that is the object of a `.current` member read.
    pub current_reads: Vec<i32>,
    /// B4: identifiers read inside a nested function (a handler, an effect, a callback), where a ref is not a render read.
    pub fn_uses: Vec<js_ast::Ref>,
    /// Depth of nested functions at the point being walked (crate-visible: F230's shallow walks build a `Walk` too).
    pub(crate) depth: u32,
}

impl Walk {
    fn assign_target(&mut self, e: &js_ast::Expr) {
        match &e.data {
            E::EIdentifier(id) => self.assigned.push(id.ref_),
            E::EImportIdentifier(id) => self.assigned.push(id.ref_),
            E::EArray(a) => a.items.iter().for_each(|x| self.assign_target(x)),
            E::EObject(o) => o
                .properties
                .iter()
                .filter_map(|p| p.value.as_ref())
                .for_each(|v| self.assign_target(v)),
            E::ESpread(sp) => self.assign_target(&sp.value),
            E::EBinary(b) if matches!(b.op, OpCode::BinAssign) => self.assign_target(&b.left),
            E::EDot(_) | E::EIndex(_) => match chain_root(e) {
                Some(r) => self.member_written.push(r),
                None => self.opaque_write = true,
            },
            _ => {}
        }
    }

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

    /// F42: a class body is code too (methods, field initialisers, static blocks, `extends`).
    fn class(&mut self, c: &js_ast::G::Class) {
        if let Some(name) = &c.class_name {
            self.declared.push(name.ref_);
        }
        if let Some(x) = &c.extends {
            self.expr(x);
        }
        for p in c.properties.iter() {
            if let Some(k) = &p.key {
                self.expr(k);
            }
            if let Some(v) = &p.value {
                self.expr(v);
            }
            if let Some(i) = &p.initializer {
                self.expr(i);
            }
            if let Some(b) = &p.class_static_block {
                self.stmts(&b.stmts);
            }
        }
    }

    fn func(&mut self, f: &js_ast::G::Fn) {
        if let Some(name) = &f.name {
            self.declared.push(name.ref_);
        }
        if self.shallow {
            return;
        }
        self.func_body(f);
    }

    /// A function's parameters and body, one function deeper (B4 `fn_uses`), from every path that walks one.
    fn func_body(&mut self, f: &js_ast::G::Fn) {
        self.depth += 1;
        for arg in f.args.slice() {
            self.declare_binding(&arg.binding);
            if let Some(d) = &arg.default {
                self.expr(d);
            }
        }
        self.stmts(f.body.stmts.slice());
        self.depth -= 1;
    }

    /// A call's argument. Shallow: a function handed to a call may run during it (`xs.forEach((x) => …)`, a `Promise`
    /// executor), so its body is walked (still shallow: a function nested in it is not).
    fn call_arg(&mut self, x: &js_ast::Expr) {
        match (&x.data, self.shallow) {
            (E::EArrow(a), true) => self.arrow_body(a),
            (E::EFunction(f), true) => self.func_body(&f.func),
            _ => self.expr(x),
        }
    }

    fn arrow_body(&mut self, a: &js_ast::E::Arrow) {
        self.depth += 1;
        for arg in a.args.slice() {
            self.declare_binding(&arg.binding);
            if let Some(d) = &arg.default {
                self.expr(d);
            }
        }
        self.stmts(a.body.stmts.slice());
        self.depth -= 1;
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
                    let d0 = self.declared.len();
                    self.declare_binding(&d.binding);
                    let d1 = self.declared.len();
                    if let Some(v) = &d.value {
                        let u0 = self.used.len();
                        self.expr(v);
                        for t in d0..d1 {
                            for u in u0..self.used.len() {
                                self.flows.push((self.declared[t], self.used[u]));
                            }
                            for r in alias_roots(v) {
                                self.aliases.push((self.declared[t], r));
                            }
                        }
                    }
                }
            }
            S::SExportDefault(ed) => match &ed.value {
                js_ast::StmtOrExpr::Expr(e) => self.expr(e),
                js_ast::StmtOrExpr::Stmt(s) => self.stmt(s),
            },
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
            S::SClass(c) => self.class(&c.class),
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
            E::EIdentifier(id) => {
                self.used.push(id.ref_);
                self.used_at.push((id.ref_, e.loc.start));
                if self.depth > 0 {
                    self.fn_uses.push(id.ref_);
                }
            }
            E::EImportIdentifier(id) => {
                self.used.push(id.ref_);
                self.used_at.push((id.ref_, e.loc.start));
                if self.depth > 0 {
                    self.fn_uses.push(id.ref_);
                }
            }
            E::EArray(a) => a.items.iter().for_each(|x| self.expr(x)),
            E::EUnary(u) => {
                if !matches!(
                    OpCode::unary_assign_target(u.op),
                    js_ast::AssignTarget::None
                ) {
                    self.assign_target(&u.value);
                }
                self.expr(&u.value)
            }
            E::EBinary(b) => {
                if !matches!(b.op.binary_assign_target(), js_ast::AssignTarget::None) {
                    // `x.a = v` / `x[k] += v`: the value written is kept, so a caller can tell what it may carry.
                    match (&b.left.data, chain_root(&b.left)) {
                        (E::EDot(_) | E::EIndex(_), Some(r)) => {
                            self.member_writes.push((r, b.right))
                        }
                        _ => self.assign_target(&b.left),
                    }
                }
                self.expr(&b.left);
                let u0 = self.used.len();
                self.expr(&b.right);
                if !matches!(b.op.binary_assign_target(), js_ast::AssignTarget::None)
                    && let Some(t) = chain_root(&b.left)
                {
                    for u in u0..self.used.len() {
                        self.flows.push((t, self.used[u]));
                    }
                    for r in alias_roots(&b.right) {
                        self.aliases.push((t, r));
                    }
                }
            }
            E::ENew(n) => {
                self.expr(&n.target);
                n.args.iter().for_each(|x| self.call_arg(x));
            }
            E::ECall(c) => {
                self.calls.push(*e);
                // Shallow: an immediately-invoked function runs here.
                match (&c.target.data, self.shallow) {
                    (E::EArrow(a), true) => self.arrow_body(a),
                    (E::EFunction(f), true) => self.func_body(&f.func),
                    _ => self.expr(&c.target),
                }
                c.args.iter().for_each(|x| self.call_arg(x));
            }
            E::EDot(d) => {
                if let Some(base) = match &d.target.data {
                    E::EIdentifier(id) => Some(id.ref_),
                    E::EImportIdentifier(id) => Some(id.ref_),
                    _ => None,
                } {
                    self.member_reads.push((
                        base,
                        String::from_utf8_lossy(d.name.slice()).into_owned(),
                        d.target.loc.start,
                    ));
                }
                if d.name.slice() == b"current"
                    && let E::EIdentifier(_) = &d.target.data
                {
                    self.current_reads.push(d.target.loc.start);
                }
                self.expr(&d.target)
            }
            E::EIndex(i) => {
                if let Some(base) = match &i.target.data {
                    E::EIdentifier(id) => Some(id.ref_),
                    E::EImportIdentifier(id) => Some(id.ref_),
                    _ => None,
                } {
                    let member = match &i.index.data {
                        E::EString(s) => estring(s),
                        _ => String::new(),
                    };
                    self.member_reads.push((base, member, i.target.loc.start));
                }
                self.expr(&i.target);
                self.expr(&i.index);
            }
            E::EArrow(_) if self.shallow => {}
            E::EArrow(a) => self.arrow_body(a),
            E::EFunction(f) => self.func(&f.func),
            E::EClass(c) => self.class(c),
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
            E::EImportMeta(_) | E::EImportMetaMain(_) => self.import_meta = true,
            E::EImport(i) => {
                self.dynamic_import.get_or_insert(loc_of(e));
                self.expr(&i.expr);
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

/// The source recorded for code that contains a dynamic `import()`.
pub const DYNAMIC_IMPORT_SOURCE: &str = "/* dynamic import */";

/// A [`Reader`]'s printer: JavaScript for `js`, with the renamed symbols of its name table.
pub type Printer<'p> = dyn Fn(Js<'_>, &Aliases) -> String + 'p;

/// What a [`Reader`]'s printer can print.
#[derive(Clone, Copy)]
pub enum Js<'x> {
    Expr(&'x js_ast::Expr),
    Stmt(&'x js_ast::Stmt),
}

/// Prints `js` as JavaScript; see [`print_expr_js`].
pub fn print_js(parsed: &Parsed, ast: &js_ast::Ast<'_>, js: Js<'_>) -> String {
    print_js_with(parsed, ast, &Aliases::new(), js)
}

/// [`print_js`] with renamed symbols (G3): each symbol index in `aliases` prints as its name.
pub fn print_js_with(
    parsed: &Parsed,
    ast: &js_ast::Ast<'_>,
    aliases: &Aliases,
    js: Js<'_>,
) -> String {
    // A dynamic `import()` makes the printer assert (no import record for it):
    // never print one; the component falls back with a `dynamic-import` diagnostic.
    let mut w = Walk::default();
    match js {
        Js::Expr(e) => w.expr(e),
        Js::Stmt(s) => w.stmt(s),
    }
    if w.dynamic_import.is_some() {
        return DYNAMIC_IMPORT_SOURCE.to_string();
    }
    // F42 backstop: the Bun printer asserts on shapes this crate does not foresee; a panic
    // there must degrade the component to a React island, never abort the process.
    let printed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match js {
        Js::Expr(e) => print_expr_with(parsed, ast, aliases, e),
        Js::Stmt(s) => print_with(parsed, ast, aliases, || *s),
    }));
    match printed {
        Ok(text) => text,
        Err(_) => {
            PRINTER_PANIC.with(|p| p.set(true));
            DYNAMIC_IMPORT_SOURCE.to_string()
        }
    }
}

thread_local! {
    /// Set when [`print_js`] caught a printer panic; the reader raises `printer-panic`.
    static PRINTER_PANIC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Whether a printer panic was caught since the last call (and clears the flag).
pub fn take_printer_panic() -> bool {
    PRINTER_PANIC.with(|p| p.replace(false))
}

/// Prints one expression as JavaScript with `bun_js_printer`. There is no public
/// single-expression entry (`print_json` uses an empty symbol table and JSON
/// mode), so this prints a one-statement module `return <e>;` through
/// `bun_js_printer::print_ast` with a copy of the module's symbol names and
/// strips the `return ` / `;` around it. Import records are left out on
/// purpose: the printer then prints every import binding by its local name.
pub fn print_expr_js(parsed: &Parsed, ast: &js_ast::Ast<'_>, e: &js_ast::Expr) -> String {
    print_expr_with(parsed, ast, &Aliases::new(), e)
}

fn print_expr_with(
    parsed: &Parsed,
    ast: &js_ast::Ast<'_>,
    aliases: &Aliases,
    e: &js_ast::Expr,
) -> String {
    let text = print_with(parsed, ast, aliases, || {
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
    aliases: &Aliases,
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
        .enumerate()
        .map(|(i, s)| js_ast::Symbol {
            // `aliases` outlives the printer, so its names can stand in for the source's.
            original_name: match aliases.get(&(i as u32)) {
                Some(a) => js_ast::StoreStr::new(a.as_bytes()),
                None => s.original_name,
            },
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
