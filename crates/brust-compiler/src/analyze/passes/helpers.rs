//! F279: a call of a single-return module function with plain-read arguments becomes the function's expression with the
//! arguments put in (`ComponentIR::inline_fns`, proven primitive-valued by `plain_fn`), before placement: the server
//! prints the value where a precompute job would have had to run the function, so a child whose only job was such a
//! call (Radix's `data-state={getState(checked)}`) has none.
//!
//! F560: the same for a function the component itself declares as a const arrow with an expression body
//! (`const l = (th, en) => (lang === 'th' ? th : en)`, also what a custom hook returns once it is inlined): a call in
//! the render is the arrow's expression over what it captures. A page of translated labels then prints them, where it
//! had one job per component, and a value computed per request no longer names a function only the client has.
use super::children::pure_read;
use crate::ir::{
    ArrowBody, Attr, ComponentIR, DerivedDecl, Expr, IdentKind, InlineFn, Node, RawExpr, RawKind,
    ServerExpr,
};
use std::collections::{HashMap, HashSet};

pub fn inline(ir: &mut ComponentIR) {
    let locals = local_arrows(ir);
    if ir.inline_fns.is_empty() && locals.is_empty() {
        return;
    }
    let fns: Vec<InlineFn> = ir.inline_fns.clone();
    // A function name that a local of the component hides is not the module function.
    let mut hidden: HashSet<String> = HashSet::new();
    hidden.extend(ir.derived.iter().map(|d| d.name.clone()));
    hidden.extend(ir.handlers.iter().map(|h| h.name.clone()));
    hidden.extend(ir.refs.iter().map(|r| r.name.clone()));
    hidden.extend(ir.id_bindings.iter().cloned());
    for s in &ir.state {
        hidden.insert(s.name.clone());
        hidden.extend(s.setter.iter().cloned());
    }
    hidden.extend(ir.props.iter().map(|p| p.local.clone()));
    let cx = Cx {
        fns: &fns,
        locals: &locals,
        hidden: &hidden,
    };
    let mut template = std::mem::replace(&mut ir.template, Node::Fragment(Vec::new()));
    cx.node(&mut template);
    ir.template = template;
    for d in &mut ir.derived {
        cx.expr(&mut d.expr);
    }
    for s in &mut ir.state {
        cx.expr(&mut s.init);
    }
}

/// F560: the component's own const arrows a call can be replaced by: an expression body made only of nodes [`put`]
/// rewrites (no function, JSX or code kept as written inside it, which would keep naming a parameter), distinct
/// parameter names, and a name no state, prop, handler or second declaration shares.
fn local_arrows(ir: &ComponentIR) -> Vec<InlineFn> {
    let mut taken: HashSet<&str> = HashSet::new();
    taken.extend(ir.handlers.iter().map(|h| h.name.as_str()));
    taken.extend(ir.refs.iter().map(|r| r.name.as_str()));
    taken.extend(ir.id_bindings.iter().map(String::as_str));
    for s in &ir.state {
        taken.insert(s.name.as_str());
        taken.extend(s.setter.iter().map(String::as_str));
    }
    taken.extend(ir.props.iter().map(|p| p.local.as_str()));
    arrows_of(&ir.derived, &taken)
}

/// [`local_arrows`] over a list of declarations; `taken` are the names something that is not a derived value holds.
fn arrows_of(derived: &[DerivedDecl], taken: &HashSet<&str>) -> Vec<InlineFn> {
    fn plain(e: &RawExpr) -> bool {
        match &e.kind {
            RawKind::Lit(_) | RawKind::Ident { .. } => true,
            RawKind::Member { target, .. } => plain(target),
            RawKind::Index { target, index } => plain(target) && plain(index),
            RawKind::Unary { value, .. } => plain(value),
            RawKind::Binary { left, right, .. } => plain(left) && plain(right),
            RawKind::Cond { test, yes, no } => plain(test) && plain(yes) && plain(no),
            RawKind::Template { parts, .. } => parts.iter().all(|(p, _)| plain(p)),
            // A method of an imported object or of a store handle may write it (`cart.count.set(1)`): such an arrow
            // stays a function, so the render-write checks report the write where it is written.
            RawKind::Call { callee, args } => {
                !member_of_import(callee) && plain(callee) && args.iter().all(plain)
            }
            RawKind::Array(xs) => xs.iter().all(plain),
            RawKind::Object(ps) => ps.iter().all(|(_, v)| plain(v)),
            RawKind::Arrow { .. } | RawKind::Jsx(_) | RawKind::Opaque { .. } => false,
        }
    }
    fn member_of_import(callee: &RawExpr) -> bool {
        let mut at = callee;
        let mut member = false;
        loop {
            match &at.kind {
                RawKind::Member { target, .. } | RawKind::Index { target, .. } => {
                    member = true;
                    at = target;
                }
                RawKind::Ident { kind, .. } => {
                    return member
                        && matches!(kind, IdentKind::Import { .. } | IdentKind::Store { .. });
                }
                _ => return false,
            }
        }
    }
    derived
        .iter()
        .filter_map(|d| {
            let Expr::Raw(RawExpr {
                kind:
                    RawKind::Arrow {
                        params,
                        body: ArrowBody::Expr(body),
                        ..
                    },
                ..
            }) = &d.expr
            else {
                return None;
            };
            let distinct = params.iter().collect::<HashSet<_>>().len() == params.len();
            let once = derived.iter().filter(|o| o.name == d.name).count() == 1;
            (distinct && once && !taken.contains(d.name.as_str()) && plain(body)).then(|| {
                InlineFn {
                    name: d.name.clone(),
                    params: params.clone(),
                    body: (**body).clone(),
                }
            })
        })
        .collect()
}

/// F560, for the reader: the calls of the component's own expression arrows inside its derived values, replaced before
/// the reader judges those values (a value computed per request must not name a function only the client has; a call
/// that is replaced names none). `taken`: the names a handler, a state, a setter or a ref holds.
pub(crate) fn inline_local_calls(derived: &mut [DerivedDecl], taken: &HashSet<&str>) {
    let locals = arrows_of(derived, taken);
    if locals.is_empty() {
        return;
    }
    let hidden = HashSet::new();
    let cx = Cx {
        fns: &[],
        locals: &locals,
        hidden: &hidden,
    };
    for d in derived.iter_mut() {
        cx.expr(&mut d.expr);
    }
}

struct Cx<'a> {
    fns: &'a [InlineFn],
    /// F560: the component's own const arrows ([`local_arrows`]).
    locals: &'a [InlineFn],
    hidden: &'a HashSet<String>,
}

impl Cx<'_> {
    fn expr(&self, e: &mut Expr) {
        if let Expr::Raw(r) | Expr::Server(ServerExpr(r)) = e {
            self.raw(r, 0);
        }
    }

    fn node(&self, n: &mut Node) {
        match n {
            Node::Element {
                attrs, children, ..
            } => {
                for a in attrs.iter_mut() {
                    match a {
                        Attr::Dynamic { value, .. }
                        | Attr::Spread(value)
                        | Attr::InnerHtml { value } => self.expr(value),
                        Attr::CollectionItem { data } => self.expr(data),
                        Attr::Static { .. }
                        | Attr::Event { .. }
                        | Attr::Ref { .. }
                        | Attr::ForwardRef => {}
                    }
                }
                children.iter_mut().for_each(|c| self.node(c));
            }
            Node::Fragment(cs) => cs.iter_mut().for_each(|c| self.node(c)),
            Node::Slot(e) => self.expr(e),
            Node::If {
                cond, then, else_, ..
            } => {
                self.expr(cond);
                then.iter_mut()
                    .chain(else_.iter_mut())
                    .for_each(|c| self.node(c));
            }
            Node::For {
                source, key, body, ..
            } => {
                self.expr(source);
                self.expr(key);
                body.iter_mut().for_each(|c| self.node(c));
            }
            Node::Component {
                props, children, ..
            } => {
                for (_, v) in props.iter_mut() {
                    self.expr(v);
                }
                children.iter_mut().for_each(|c| self.node(c));
            }
            Node::Dynamic {
                component, props, ..
            } => {
                self.expr(component);
                self.expr(props);
            }
            Node::Text(_) | Node::Outlet => {}
        }
    }

    fn raw(&self, r: &mut RawExpr, depth: u8) {
        match &mut r.kind {
            RawKind::Member { target, .. } => self.raw(target, depth),
            RawKind::Index { target, index } => {
                self.raw(target, depth);
                self.raw(index, depth);
            }
            RawKind::Call { args, .. } => args.iter_mut().for_each(|a| self.raw(a, depth)),
            RawKind::Binary { left, right, .. } => {
                self.raw(left, depth);
                self.raw(right, depth);
            }
            RawKind::Unary { value, .. } => self.raw(value, depth),
            RawKind::Cond { test, yes, no } => {
                self.raw(test, depth);
                self.raw(yes, depth);
                self.raw(no, depth);
            }
            RawKind::Template { parts, .. } => {
                parts.iter_mut().for_each(|(p, _)| self.raw(p, depth))
            }
            RawKind::Array(xs) => xs.iter_mut().for_each(|x| self.raw(x, depth)),
            RawKind::Object(ps) => ps.iter_mut().for_each(|(_, v)| self.raw(v, depth)),
            RawKind::Lit(_)
            | RawKind::Ident { .. }
            | RawKind::Arrow { .. }
            | RawKind::Jsx(_)
            | RawKind::Opaque { .. } => {}
        }
        if depth >= 4 {
            return;
        }
        let RawKind::Call { callee, args } = &r.kind else {
            return;
        };
        let RawKind::Ident {
            name,
            kind: IdentKind::Local,
        } = &callee.kind
        else {
            return;
        };
        // A local arrow is the component's own declaration of that name; a module function is hidden by one.
        let (f, local) = match self.locals.iter().find(|f| &f.name == name) {
            Some(f) => (f, true),
            None if self.hidden.contains(name) => return,
            None => match self.fns.iter().find(|f| &f.name == name) {
                Some(f) => (f, false),
                None => return,
            },
        };
        // A local arrow's argument may be any expression without a call: computing it where the parameter is read
        // (once, several times or never) cannot be told from computing it at the call.
        let arg_ok = |a: &RawExpr| if local { call_free(a) } else { pure_read(a) };
        if f.params.len() != args.len() || !args.iter().all(arg_ok) {
            return;
        }
        let map: HashMap<&str, &RawExpr> = f
            .params
            .iter()
            .map(String::as_str)
            .zip(args.iter())
            .collect();
        let mut body = f.body.clone();
        put(&mut body, &map);
        body.loc = r.loc;
        *r = body;
        // the body may call other inlinable helpers
        self.raw(r, depth + 1);
    }
}

/// No call, no function, no JSX and no code kept as written anywhere in `e`: reads, literals and operators only.
fn call_free(e: &RawExpr) -> bool {
    match &e.kind {
        RawKind::Lit(_) | RawKind::Ident { .. } => true,
        RawKind::Member { target, .. } => call_free(target),
        RawKind::Index { target, index } => call_free(target) && call_free(index),
        RawKind::Unary { value, .. } => call_free(value),
        RawKind::Binary { left, right, .. } => call_free(left) && call_free(right),
        RawKind::Cond { test, yes, no } => call_free(test) && call_free(yes) && call_free(no),
        RawKind::Template { parts, .. } => parts.iter().all(|(p, _)| call_free(p)),
        RawKind::Array(xs) => xs.iter().all(call_free),
        RawKind::Object(ps) => ps.iter().all(|(_, v)| call_free(v)),
        RawKind::Call { .. } | RawKind::Arrow { .. } | RawKind::Jsx(_) | RawKind::Opaque { .. } => {
            false
        }
    }
}

/// `e` with every parameter replaced by its argument.
fn put(e: &mut RawExpr, map: &HashMap<&str, &RawExpr>) {
    match &mut e.kind {
        RawKind::Ident { name, kind } if !matches!(kind, IdentKind::Global) => {
            if let Some(a) = map.get(name.as_str()) {
                *e = (*a).clone();
            }
        }
        RawKind::Unary { value, .. } => put(value, map),
        RawKind::Binary { left, right, .. } => {
            put(left, map);
            put(right, map);
        }
        RawKind::Cond { test, yes, no } => {
            put(test, map);
            put(yes, map);
            put(no, map);
        }
        RawKind::Call { callee, args } => {
            put(callee, map);
            args.iter_mut().for_each(|a| put(a, map));
        }
        RawKind::Template { parts, .. } => parts.iter_mut().for_each(|(p, _)| put(p, map)),
        RawKind::Member { target, .. } => put(target, map),
        RawKind::Index { target, index } => {
            put(target, map);
            put(index, map);
        }
        RawKind::Array(xs) => xs.iter_mut().for_each(|x| put(x, map)),
        RawKind::Object(ps) => ps.iter_mut().for_each(|(_, v)| put(v, map)),
        _ => {}
    }
}
