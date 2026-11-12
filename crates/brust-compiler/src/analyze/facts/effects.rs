//! F538: what a handler DOES to things it does not own: its writes, whether it reads its parameters, the globals it reaches.
//!
//! A handler's `callees` say what it calls; they do not see `e.currentTarget.innerHTML = html`, which is an assignment.
//! This walk reports every assignment, update and `delete` in a handler (and in every local function it reaches, at any
//! depth, by call or by reference) with what its target is rooted at. The facts are a REPORT, not a sandbox: policy stays
//! with the caller, and the rule it should apply is the narrow one (only `local` writes; only `setter` and `local` callees).
//!
//! Fail closed. A target the walk cannot classify is `other`; a binding it cannot trace is `other`, never `local`. `local`
//! is claimed for exactly two shapes: an assignment to a variable the handler itself declares, and a write one property
//! deep on an object (or array) literal the handler itself created. Everything that reaches a parameter, a global or a
//! variable of the enclosing component carries that name, through simple `const` aliases (`const t = e.currentTarget`).
use super::*;
use std::cell::RefCell;
use std::rc::Rc;

/// One assignment, update (`++`, `--`) or `delete` a handler (or a local function it reaches) performs.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFact {
    pub line: u32,
    pub col: u32,
    /// What the written place is rooted at: `local` (a variable the handler declares, or a property of an object literal it
    /// made), `param` (a parameter variable itself: `e = x`), `param-member` (reached through a parameter or an alias of
    /// one: `e.currentTarget.innerHTML = x`), `closure` (a variable of the enclosing component or module: `count = 1`),
    /// `closure-member` (a property reached through one), `global` (`location = x`), `global-member` (`document.title = x`,
    /// `window.location.href = x`), `other` (anything the walk cannot trace: a call result, `this`, a loop variable, a
    /// variable assigned from several sources).
    pub target: &'static str,
    /// The written place as the source spells it, best effort: `e.currentTarget.innerHTML`, `items[?].x`.
    pub path: String,
}

/// A local function (a declaration, or a `const f = () => …` / `useCallback(…)` value) a handler reaches.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FnRef {
    pub name: String,
    pub line: u32,
    pub col: u32,
}

/// What one local function does, for its OWN body (nested inline functions included, other local functions it reaches not):
/// the same rule a handler is held to, so a caller can apply it to each function a handler reaches.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FnFact {
    pub name: String,
    pub line: u32,
    pub col: u32,
    pub writes: Vec<WriteFact>,
    /// The function reads one of its own parameters (a destructuring signature counts).
    pub reads_params: bool,
    pub globals: Vec<String>,
    pub callees: Vec<Callee>,
    /// The local functions its body names (calls them, or passes them on).
    pub reaches: Vec<FnRef>,
}

/// How a name was introduced, file-wide (first declaration wins; a second one is an assignment).
#[derive(Clone)]
pub(super) enum DeclKind {
    /// `const x = init` / `let x = init` / `var x = init`; `None` for `let x`.
    Plain(Option<js_ast::Expr>),
    /// A name bound by a pattern (`const { a } = init`), with every default the pattern spells.
    Pattern {
        init: Option<js_ast::Expr>,
        defaults: Vec<js_ast::Expr>,
    },
    /// A parameter of some function (the unit's own parameters, and their defaults, are read from the function itself).
    Param,
    /// A loop or catch binding: the value comes from somewhere the walk does not follow.
    Other,
    /// A function name.
    Fn,
    /// A class name: its constructor and methods are not units of this walk, so a call to it is never `local`.
    Class,
}

/// Where a value comes from, for the one question that matters: what does writing through it touch?
#[derive(Clone, Copy, PartialEq, Eq)]
enum Origin {
    /// A literal, or a function the code itself made. A property OF it is unknown (`o.t = document.body` stores a reference).
    Fresh,
    Param,
    /// A parameter of a function that encloses the handler (the component's props, a helper's arguments), or a name derived
    /// from one: a value that came in from outside, which nothing in the file fixes.
    Prop,
    Global,
    Closure,
    Other,
}

fn join(a: Origin, b: Origin) -> Origin {
    if a == b || b == Origin::Fresh {
        a
    } else if a == Origin::Fresh {
        b
    } else {
        Origin::Other
    }
}

/// A property of something: unknown when the something is a literal the code made (it can hold any reference).
fn member_of(o: Origin) -> Origin {
    if o == Origin::Fresh { Origin::Other } else { o }
}

/// What one unit (a handler's function, or a local function it reaches) does, in its own lexical body.
#[derive(Default)]
pub(super) struct Unit {
    pub writes: Vec<WriteFact>,
    pub reads_params: bool,
    pub globals: BTreeSet<String>,
    pub callees: BTreeSet<Callee>,
    /// Local functions named in the body (by index of their symbol).
    pub reaches: BTreeSet<u32>,
    /// Function expressions a name in the body may hold that no name of their own binds (`go = (e) => …`).
    pub extra: Vec<js_ast::Expr>,
}

/// The bindings of one unit: its own parameters, and everything declared inside it (a nested function's parameters too).
struct Ctx {
    params: HashMap<u32, Vec<js_ast::Expr>>,
    inner: HashSet<u32>,
}

/// What the whole handler does: its own body plus every local function it reaches.
pub(super) struct HandlerEffects {
    pub writes: Vec<WriteFact>,
    pub reads_params: bool,
    pub globals: Vec<String>,
    pub callees: Vec<Callee>,
    pub reaches: Vec<FnRef>,
}

fn is_assign_op(op: js_ast::OpCode) -> bool {
    op.binary_assign_target() != js_ast::AssignTarget::None
}

/// `++x`, `x--`.
fn is_update_op(op: js_ast::OpCode) -> bool {
    js_ast::OpCode::unary_assign_target(op) != js_ast::AssignTarget::None
}

/// The expression at the foot of a member chain and the number of member hops to it.
fn chain_root(e: &js_ast::Expr) -> (&js_ast::Expr, usize) {
    let mut cur = e;
    let mut hops = 0;
    loop {
        match &cur.data {
            E::EDot(d) => {
                cur = &d.target;
                hops += 1;
            }
            E::EIndex(i) => {
                cur = &i.target;
                hops += 1;
            }
            _ => return (cur, hops),
        }
    }
}

/// The names a binding pattern declares, with every default value it spells; `true` when it is a destructuring pattern.
fn binding_idents(
    b: &js_ast::Binding,
    defaults: &mut Vec<js_ast::Expr>,
    out: &mut Vec<u32>,
) -> bool {
    match b.data {
        B::BIdentifier(id) => {
            out.push(id.r#ref.inner_index());
            false
        }
        B::BArray(arr) => {
            for item in arr.items() {
                if let Some(d) = &item.default_value {
                    defaults.push(*d);
                }
                binding_idents(&item.binding, defaults, out);
            }
            true
        }
        B::BObject(obj) => {
            for p in obj.properties() {
                if let Some(d) = &p.default_value {
                    defaults.push(*d);
                }
                binding_idents(&p.value, defaults, out);
            }
            true
        }
        B::BMissing(_) => false,
    }
}

/// The parameters of a function node: (name, defaults) for each, and whether any is a destructuring pattern.
fn param_info(node: FnNode) -> (Vec<(u32, Vec<js_ast::Expr>)>, bool) {
    fn of(args: &[js_ast::G::Arg]) -> (Vec<(u32, Vec<js_ast::Expr>)>, bool) {
        let mut out = Vec::new();
        let mut destructured = false;
        for arg in args {
            let mut defaults: Vec<js_ast::Expr> = arg.default.iter().copied().collect();
            let mut names = Vec::new();
            destructured |= binding_idents(&arg.binding, &mut defaults, &mut names);
            for n in names {
                out.push((n, defaults.clone()));
            }
        }
        (out, destructured)
    }
    match node {
        FnNode::Stmt(s) => match &s.data {
            S::SFunction(f) => of(f.func.args.slice()),
            _ => (Vec::new(), false),
        },
        FnNode::Expr(e) => match &e.data {
            E::EArrow(a) => of(a.args.slice()),
            E::EFunction(f) => of(f.func.args.slice()),
            _ => (Vec::new(), false),
        },
    }
}

fn node_loc(node: FnNode) -> i32 {
    match node {
        FnNode::Stmt(s) => s.loc.start,
        FnNode::Expr(e) => e.loc.start,
    }
}

/// `e` is a function written in the file.
fn is_fn_expr(e: &js_ast::Expr) -> bool {
    matches!(e.data, E::EArrow(_) | E::EFunction(_))
}

/// The places an assignment writes: the target itself, or every target a destructuring pattern holds.
fn assign_targets(e: &js_ast::Expr, out: &mut Vec<js_ast::Expr>) {
    match &e.data {
        E::EArray(a) => {
            for item in a.items.iter() {
                match &item.data {
                    E::EMissing(_) => {}
                    E::ESpread(sp) => assign_targets(&sp.value, out),
                    // `[a.b = 1] = xs`: the default is an assignment to `a.b`.
                    E::EBinary(b) if matches!(b.op, js_ast::OpCode::BinAssign) => {
                        assign_targets(&b.left, out)
                    }
                    _ => assign_targets(item, out),
                }
            }
        }
        E::EObject(o) => {
            for p in o.properties.iter() {
                let Some(v) = &p.value else { continue };
                match &v.data {
                    E::EBinary(b) if matches!(b.op, js_ast::OpCode::BinAssign) => {
                        assign_targets(&b.left, out)
                    }
                    _ => assign_targets(v, out),
                }
            }
        }
        _ => out.push(*e),
    }
}

impl<'a> Reader<'a> {
    /// The canonical symbol of `idx`: a `var` declared again in a nested block is a second symbol linked to the first, and
    /// every table of this walk is keyed by the one the code reads.
    fn canon(&self, idx: u32) -> u32 {
        let syms = self.ast.symbols.as_slice();
        let mut cur = idx;
        for _ in 0..64 {
            let Some(s) = syms.get(cur as usize) else {
                return cur;
            };
            let link = s.link.get();
            if !link.is_valid() {
                return cur;
            }
            cur = link.inner_index();
        }
        cur
    }

    fn ident_idx(&self, e: &js_ast::Expr) -> Option<u32> {
        ident_ref(e).map(|r| self.canon(r.inner_index()))
    }

    fn sym_at(&self, idx: u32) -> Option<&js_ast::symbol::Symbol> {
        self.ast.symbols.as_slice().get(idx as usize)
    }

    fn name_at(&self, idx: u32) -> String {
        self.sym_at(idx)
            .map(|s| String::from_utf8_lossy(s.original_name.slice()).into_owned())
            .unwrap_or_default()
    }

    fn unbound(&self, idx: u32) -> bool {
        self.sym_at(idx)
            .is_some_and(|s| s.kind == js_ast::symbol::Kind::Unbound)
    }

    /// Every name a node declares, with how: a `let`/`const`/`var`, a function or class name, a function's parameters (not
    /// those of the function at `skip_loc`: the unit's own), a catch or loop binding. Parents are visited before children,
    /// so a loop's own binding is seen as a loop binding before the declaration statement is.
    pub(super) fn declared(
        &self,
        n: N<'_>,
        skip_loc: Option<i32>,
        f: &mut dyn FnMut(u32, DeclKind),
    ) {
        let params = |args: &[js_ast::G::Arg], f: &mut dyn FnMut(u32, DeclKind)| {
            for arg in args {
                let mut names = Vec::new();
                binding_idents(&arg.binding, &mut Vec::new(), &mut names);
                for name in names {
                    f(name, DeclKind::Param);
                }
            }
        };
        match n {
            N::S(s) => match &s.data {
                S::SFunction(func) => {
                    if let Some(name) = &func.func.name {
                        f(name.ref_.inner_index(), DeclKind::Fn);
                    }
                    if skip_loc != Some(s.loc.start) {
                        params(func.func.args.slice(), f);
                    }
                }
                S::SClass(c) => {
                    if let Some(name) = &c.class.class_name {
                        f(name.ref_.inner_index(), DeclKind::Class);
                    }
                }
                S::SLocal(l) => {
                    for d in l.decls.iter() {
                        let mut defaults = Vec::new();
                        let mut names = Vec::new();
                        let pattern = binding_idents(&d.binding, &mut defaults, &mut names);
                        for name in names {
                            f(
                                name,
                                if pattern {
                                    DeclKind::Pattern {
                                        init: d.value,
                                        defaults: defaults.clone(),
                                    }
                                } else {
                                    DeclKind::Plain(d.value)
                                },
                            );
                        }
                    }
                }
                S::SForIn(fo) => self.declared_by_loop(&fo.init, f),
                S::SForOf(fo) => self.declared_by_loop(&fo.init, f),
                S::STry(t) => {
                    if let Some(c) = &t.catch
                        && let Some(b) = &c.binding
                    {
                        let mut names = Vec::new();
                        binding_idents(b, &mut Vec::new(), &mut names);
                        for name in names {
                            f(name, DeclKind::Other);
                        }
                    }
                }
                _ => {}
            },
            N::E(e) => match &e.data {
                E::EArrow(a) if skip_loc != Some(e.loc.start) => params(a.args.slice(), f),
                E::EFunction(func) => {
                    if let Some(name) = &func.func.name {
                        f(name.ref_.inner_index(), DeclKind::Fn);
                    }
                    if skip_loc != Some(e.loc.start) {
                        params(func.func.args.slice(), f);
                    }
                }
                E::EClass(c) => {
                    if let Some(name) = &c.class_name {
                        f(name.ref_.inner_index(), DeclKind::Class);
                    }
                }
                _ => {}
            },
        }
    }

    fn declared_by_loop(&self, init: &js_ast::Stmt, f: &mut dyn FnMut(u32, DeclKind)) {
        if let S::SLocal(l) = &init.data {
            for d in l.decls.iter() {
                let mut names = Vec::new();
                binding_idents(&d.binding, &mut Vec::new(), &mut names);
                for name in names {
                    f(name, DeclKind::Other);
                }
            }
        }
    }

    /// File-wide tables the origin and callee rules read: how every name was declared, every value assigned to a name
    /// (flow-insensitive: a name assigned from two sources has both), and where each named local function sits.
    pub(super) fn collect_effects(&mut self) {
        let ast = self.ast;
        let mut decls: HashMap<u32, DeclKind> = HashMap::new();
        let mut assigned: HashMap<u32, Vec<js_ast::Expr>> = HashMap::new();
        let mut assigned_other: HashSet<u32> = HashSet::new();
        let mut written_roots: HashSet<u32> = HashSet::new();
        for part in ast.parts.iter() {
            walk_stmts(part.stmts.slice(), &mut |n| {
                self.declared(n, None, &mut |idx, kind| {
                    let idx = self.canon(idx);
                    match decls.entry(idx) {
                        std::collections::hash_map::Entry::Vacant(v) => {
                            v.insert(kind);
                        }
                        // A second declaration (`var x` twice) is an assignment of its value.
                        std::collections::hash_map::Entry::Occupied(_) => match kind {
                            DeclKind::Plain(Some(init))
                            | DeclKind::Pattern {
                                init: Some(init), ..
                            } => {
                                assigned.entry(idx).or_default().push(init);
                            }
                            DeclKind::Plain(None) | DeclKind::Fn | DeclKind::Class => {}
                            _ => {
                                assigned_other.insert(idx);
                            }
                        },
                    }
                });
                match n {
                    N::E(e) => {
                        // A member written anywhere in the file (`props.onSave = f`, `props.n++`): its root holds more than
                        // what its caller passed.
                        let written = match &e.data {
                            E::EBinary(b) if is_assign_op(b.op) => {
                                let mut ts = Vec::new();
                                if matches!(b.op, js_ast::OpCode::BinAssign) {
                                    assign_targets(&b.left, &mut ts);
                                } else {
                                    ts.push(b.left);
                                }
                                ts
                            }
                            E::EUnary(u)
                                if is_update_op(u.op)
                                    || matches!(u.op, js_ast::OpCode::UnDelete) =>
                            {
                                vec![u.value]
                            }
                            _ => Vec::new(),
                        };
                        for t in written {
                            let (root, hops) = chain_root(&t);
                            if hops > 0
                                && let Some(i) = self.ident_idx(root)
                            {
                                written_roots.insert(i);
                            }
                        }
                        if let E::EBinary(b) = &e.data
                            && is_assign_op(b.op)
                        {
                            let ident_left = self.ident_idx(&b.left);
                            match (b.op, ident_left) {
                                (js_ast::OpCode::BinAssign, Some(idx)) => {
                                    assigned.entry(idx).or_default().push(b.right);
                                }
                                // `x ||= v`, `x ??= v`, `x &&= v` may store `v`; `x += v` stores a primitive.
                                (
                                    js_ast::OpCode::BinNullishCoalescingAssign
                                    | js_ast::OpCode::BinLogicalOrAssign
                                    | js_ast::OpCode::BinLogicalAndAssign,
                                    Some(idx),
                                ) => assigned.entry(idx).or_default().push(b.right),
                                (js_ast::OpCode::BinAssign, None) => {
                                    // A destructuring assignment stores values the walk does not follow.
                                    let mut targets = Vec::new();
                                    assign_targets(&b.left, &mut targets);
                                    for t in targets {
                                        if let Some(idx) = self.ident_idx(&t) {
                                            assigned_other.insert(idx);
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    N::S(s) => {
                        let init = match &s.data {
                            S::SForIn(fo) => Some(fo.init),
                            S::SForOf(fo) => Some(fo.init),
                            _ => None,
                        };
                        if let Some(init) = init
                            && let S::SExpr(x) = &init.data
                        {
                            let mut targets = Vec::new();
                            assign_targets(&x.value, &mut targets);
                            for t in targets {
                                if let Some(idx) = self.ident_idx(&t) {
                                    assigned_other.insert(idx);
                                }
                            }
                        }
                    }
                }
            });
        }
        // Every table is keyed by the canonical symbol, the `fns` and `setters` of the first pass included.
        let fns: HashMap<u32, FnNode> =
            self.fns.iter().map(|(k, v)| (self.canon(*k), *v)).collect();
        let setters: HashSet<u32> = self.setters.iter().map(|k| self.canon(*k)).collect();
        let mut by_loc = HashMap::new();
        for (idx, node) in &fns {
            by_loc.insert(node_loc(*node), *idx);
        }
        self.fns = fns;
        self.setters = setters;
        self.decls = decls;
        self.assigned = assigned;
        self.assigned_other = assigned_other;
        self.written_roots = written_roots;
        self.fn_by_loc = by_loc;
    }

    /// Where the value of binding `idx` comes from, as seen from the unit `ctx`.
    fn origin_of_ref(&self, idx: u32, ctx: &Ctx, seen: &mut HashSet<u32>) -> Origin {
        if self.unbound(idx) {
            return Origin::Global;
        }
        if self.imported.contains_key(&idx) {
            return Origin::Closure;
        }
        // The `arguments` object of the unit's function is its parameters.
        if self.name_at(idx) == "arguments" {
            return Origin::Param;
        }
        if !seen.insert(idx) {
            // A cycle between names contributes nothing of its own: the other sources of the names decide.
            return Origin::Fresh;
        }
        let mut o = if let Some(defaults) = ctx.params.get(&idx) {
            let mut o = Origin::Param;
            for d in defaults {
                o = join(o, self.origin_of_expr(d, ctx, seen));
            }
            o
        } else if !ctx.inner.contains(&idx) {
            // Declared outside the unit: the enclosing component's or the module's. A parameter of an enclosing function, and
            // a name aliasing or destructured from one, is a `Prop`; anything else is a `Closure` variable.
            let o = match self.decls.get(&idx) {
                Some(DeclKind::Param) => Origin::Prop,
                Some(DeclKind::Plain(Some(init))) => self.origin_of_expr(init, ctx, seen),
                Some(DeclKind::Pattern {
                    init: Some(init), ..
                }) => member_of(self.origin_of_expr(init, ctx, seen)),
                _ => Origin::Closure,
            };
            seen.remove(&idx);
            return if o == Origin::Prop {
                Origin::Prop
            } else {
                Origin::Closure
            };
        } else {
            match self.decls.get(&idx) {
                Some(DeclKind::Plain(Some(init))) => self.origin_of_expr(init, ctx, seen),
                Some(DeclKind::Plain(None)) | Some(DeclKind::Fn) | Some(DeclKind::Class) => {
                    Origin::Fresh
                }
                Some(DeclKind::Pattern {
                    init: Some(init),
                    defaults,
                }) => {
                    let mut o = member_of(self.origin_of_expr(init, ctx, seen));
                    for d in defaults {
                        o = join(o, self.origin_of_expr(d, ctx, seen));
                    }
                    o
                }
                // A nested function's parameter, a loop or catch binding, a pattern with no value: unknown.
                _ => Origin::Other,
            }
        };
        if self.assigned_other.contains(&idx) {
            o = join(o, Origin::Other);
        }
        if let Some(values) = self.assigned.get(&idx) {
            for v in values {
                o = join(o, self.origin_of_expr(v, ctx, seen));
            }
        }
        seen.remove(&idx);
        o
    }

    fn origin_of_expr(&self, e: &js_ast::Expr, ctx: &Ctx, seen: &mut HashSet<u32>) -> Origin {
        match &e.data {
            E::EIdentifier(_) | E::EImportIdentifier(_) => match self.ident_idx(e) {
                Some(idx) => self.origin_of_ref(idx, ctx, seen),
                None => Origin::Other,
            },
            E::EDot(d) => member_of(self.origin_of_expr(&d.target, ctx, seen)),
            E::EIndex(i) => member_of(self.origin_of_expr(&i.target, ctx, seen)),
            E::ECall(c) if c.was_jsx_element => Origin::Fresh,
            // `new Image()`: an object the platform made, written through like the global it came from.
            E::ENew(n) => match self.ident_idx(&n.target) {
                Some(idx) if self.unbound(idx) => Origin::Global,
                _ => Origin::Other,
            },
            E::EArrow(_)
            | E::EFunction(_)
            | E::EClass(_)
            | E::EObject(_)
            | E::EArray(_)
            | E::ENumber(_)
            | E::EString(_)
            | E::EBoolean(_)
            | E::EBranchBoolean(_)
            | E::ENull(_)
            | E::EUndefined(_)
            | E::EBigInt(_)
            | E::ERegExp(_) => Origin::Fresh,
            E::ETemplate(t) if t.tag.is_none() => Origin::Fresh,
            // `!x`, `-x`, `typeof x`, `x++`, `delete x.y`: a primitive.
            E::EUnary(_) => Origin::Fresh,
            E::EBinary(b) => match b.op {
                js_ast::OpCode::BinComma | js_ast::OpCode::BinAssign => {
                    self.origin_of_expr(&b.right, ctx, seen)
                }
                js_ast::OpCode::BinLogicalOr
                | js_ast::OpCode::BinLogicalAnd
                | js_ast::OpCode::BinNullishCoalescing
                | js_ast::OpCode::BinLogicalOrAssign
                | js_ast::OpCode::BinLogicalAndAssign
                | js_ast::OpCode::BinNullishCoalescingAssign => join(
                    self.origin_of_expr(&b.left, ctx, seen),
                    self.origin_of_expr(&b.right, ctx, seen),
                ),
                // Arithmetic, comparison and the other compound assignments yield a primitive.
                _ => Origin::Fresh,
            },
            E::EIf(i) => join(
                self.origin_of_expr(&i.yes, ctx, seen),
                self.origin_of_expr(&i.no, ctx, seen),
            ),
            _ => Origin::Other,
        }
    }

    /// The written place as the source spells it, best effort.
    fn path_text(&self, e: &js_ast::Expr) -> String {
        match &e.data {
            E::EIdentifier(_) | E::EImportIdentifier(_) => self
                .ident_idx(e)
                .map(|i| self.name_at(i))
                .unwrap_or_default(),
            E::EDot(d) => format!(
                "{}.{}",
                self.path_text(&d.target),
                String::from_utf8_lossy(d.name.slice())
            ),
            E::EIndex(i) => match &i.index.data {
                E::EString(s) => format!(
                    "{}[{:?}]",
                    self.path_text(&i.target),
                    crate::analyze::expr::estring(s)
                ),
                _ => format!("{}[?]", self.path_text(&i.target)),
            },
            E::ECall(c) => format!("{}(?)", self.path_text(&c.target)),
            E::EThis(_) => "this".to_string(),
            _ => "?".to_string(),
        }
    }

    /// What a write to `t` is rooted at (see [`WriteFact::target`]).
    fn write_target(&self, t: &js_ast::Expr, ctx: &Ctx) -> &'static str {
        match &t.data {
            E::EIdentifier(_) | E::EImportIdentifier(_) => {
                let Some(idx) = self.ident_idx(t) else {
                    return "other";
                };
                if self.unbound(idx) {
                    "global"
                } else if ctx.params.contains_key(&idx) {
                    "param"
                } else if ctx.inner.contains(&idx) {
                    "local"
                } else {
                    "closure"
                }
            }
            E::EDot(_) | E::EIndex(_) => {
                let (root, hops) = chain_root(t);
                let Some(idx) = self.ident_idx(root) else {
                    return "other";
                };
                match self.origin_of_ref(idx, ctx, &mut HashSet::new()) {
                    Origin::Param => "param-member",
                    Origin::Prop => "prop-member",
                    Origin::Global => "global-member",
                    Origin::Closure => "closure-member",
                    // A property of an object literal the handler made, one level deep: `o.x = 1`. Deeper (`o.t.x = 1`)
                    // goes through whatever `o.t` was set to.
                    Origin::Fresh if hops == 1 => "local",
                    _ => "other",
                }
            }
            _ => "other",
        }
    }

    fn push_write(&self, t: &js_ast::Expr, ctx: &Ctx, out: &mut Vec<WriteFact>) {
        let (line, col) = self.pos(t);
        out.push(WriteFact {
            line,
            col,
            target: self.write_target(t, ctx),
            path: self.path_text(t),
        });
    }

    /// The parameter of an enclosing function `e` is rooted at (through member hops and `const` aliases).
    fn param_root(&self, e: &js_ast::Expr) -> Option<u32> {
        let mut cur = *e;
        for _ in 0..8 {
            let idx = self.ident_idx(chain_root(&cur).0)?;
            match self.decls.get(&idx) {
                Some(DeclKind::Param) => return Some(idx),
                Some(DeclKind::Plain(Some(init))) => cur = *init,
                _ => return None,
            }
        }
        None
    }

    /// The parameter is never reassigned and none of its members is written anywhere in the file: what a caller passed
    /// is what it holds. A `prop` or `prop-member` callee is claimed only then (a platform that trusts host props relies on it).
    fn param_untouched(&self, idx: u32) -> bool {
        !self.assigned.contains_key(&idx)
            && !self.assigned_other.contains(&idx)
            && !self.written_roots.contains(&idx)
    }

    fn prop_untouched(&self, e: &js_ast::Expr) -> bool {
        self.param_root(e).is_some_and(|i| self.param_untouched(i))
    }

    /// The callee a call to `target` is, seen from the unit `ctx` (see [`Callee::kind`]): an alias of a global or of a
    /// parameter is named for what it aliases (`const f = window.fetch; f()` is the global member `window.fetch`).
    fn classify_depth(&self, target: &js_ast::Expr, ctx: &Ctx, depth: u8) -> Callee {
        let unknown = |name: String| Callee {
            name,
            kind: "unknown",
            from: None,
        };
        if let Some(idx) = self.ident_idx(target) {
            let name = self.name_at(idx);
            if let Some((spec, _)) = self.imported.get(&idx) {
                return Callee {
                    name,
                    kind: "import",
                    from: Some(spec.clone()),
                };
            }
            // A name assigned again (`let go = () => {}; go = window.fetch`) is whatever it was last given: the file does not
            // fix it, so it is neither a setter nor a local function.
            let reassigned = self.assigned.contains_key(&idx) || self.assigned_other.contains(&idx);
            if reassigned && !self.unbound(idx) {
                return unknown(name);
            }
            if self.setters.contains(&idx) {
                return Callee {
                    name,
                    kind: "setter",
                    from: None,
                };
            }
            if self.unbound(idx) {
                return Callee {
                    name,
                    kind: "global",
                    from: None,
                };
            }
            // A value passed in: nothing in this file says what it is.
            if ctx.params.contains_key(&idx) {
                return unknown(name);
            }
            if self.fns.contains_key(&idx) {
                return Callee {
                    name,
                    kind: "local",
                    from: None,
                };
            }
            let local = Callee {
                name: name.clone(),
                kind: "local",
                from: None,
            };
            return match self.decls.get(&idx) {
                Some(DeclKind::Plain(Some(init))) => {
                    if reassigned || depth >= 6 {
                        unknown(name)
                    } else if is_fn_expr(init) {
                        local
                    } else if matches!(
                        init.data,
                        E::EIdentifier(_) | E::EImportIdentifier(_) | E::EDot(_)
                    ) {
                        // `const f = window.fetch`: the name of what it is, not of the alias.
                        self.classify_depth(init, ctx, depth + 1)
                    } else {
                        unknown(name)
                    }
                }
                Some(DeclKind::Plain(None)) => {
                    if reassigned {
                        unknown(name)
                    } else {
                        local
                    }
                }
                Some(DeclKind::Pattern {
                    init: Some(init), ..
                }) => match self.origin_of_expr(init, ctx, &mut HashSet::new()) {
                    // `const { fetch } = window`.
                    Origin::Global => Callee {
                        name,
                        kind: "global-member",
                        from: None,
                    },
                    Origin::Param => Callee {
                        name,
                        kind: "param-member",
                        from: None,
                    },
                    // `const { onSave } = props`: caller-supplied.
                    Origin::Prop if self.prop_untouched(init) => Callee {
                        name,
                        kind: "prop",
                        from: None,
                    },
                    _ => unknown(name),
                },
                Some(DeclKind::Fn) => local,
                Some(DeclKind::Class) => unknown(name),
                // A parameter of a function outside the handler (the component's props, mostly) is a value its caller gives;
                // a parameter of a function inside it, a loop or catch binding and a pattern with no value are not fixed by
                // the file.
                Some(DeclKind::Param) if !ctx.inner.contains(&idx) => {
                    if self.param_untouched(idx) {
                        Callee {
                            name,
                            kind: "prop",
                            from: None,
                        }
                    } else {
                        unknown(name)
                    }
                }
                Some(DeclKind::Param)
                | Some(DeclKind::Other)
                | Some(DeclKind::Pattern { init: None, .. }) => unknown(name),
                None => unknown(name),
            };
        }
        if let E::EDot(_) = &target.data
            && let Some((name, root)) = dotted(self, target)
        {
            let ridx = self.canon(root.inner_index());
            if let Some((spec, _)) = self.imported.get(&ridx) {
                return Callee {
                    name,
                    kind: "member",
                    from: Some(spec.clone()),
                };
            }
            let kind = match self.origin_of_ref(ridx, ctx, &mut HashSet::new()) {
                Origin::Param => "param-member",
                Origin::Prop if self.prop_untouched(target) => "prop-member",
                Origin::Prop => "member",
                Origin::Global => "global-member",
                _ => "member",
            };
            return Callee {
                name,
                kind,
                from: None,
            };
        }
        unknown(String::new())
    }

    /// The named local functions the name `idx` may hold: itself, or what a chain of `const f = go` / `useCallback(go)`
    /// aliases (and any later `f = other`) leads to. A reached function's body is part of what the caller does, so an alias
    /// must lead to it as the function's own name does.
    /// It also returns the function expressions the name was given that no name of their own binds (`go = (e) => …`):
    /// those are walked as units of their own.
    pub(super) fn fn_values(&self, idx: u32) -> (Vec<u32>, Vec<js_ast::Expr>) {
        // Most names are neither a function nor an alias of one: nothing to follow.
        let aliasing = matches!(
            self.decls.get(&idx),
            Some(DeclKind::Plain(Some(_))) | Some(DeclKind::Pattern { init: Some(_), .. })
        ) || self.assigned.contains_key(&idx);
        if !aliasing && !self.fns.contains_key(&idx) {
            return (Vec::new(), Vec::new());
        }
        let mut out = Vec::new();
        let mut exprs: Vec<js_ast::Expr> = Vec::new();
        let mut seen = HashSet::new();
        let mut work = vec![idx];
        while let Some(cur) = work.pop() {
            if !seen.insert(cur) || seen.len() > 32 {
                continue;
            }
            if self.fns.contains_key(&cur) {
                out.push(cur);
            }
            let mut values: Vec<js_ast::Expr> = Vec::new();
            match self.decls.get(&cur) {
                Some(DeclKind::Plain(Some(init))) => values.push(*init),
                Some(DeclKind::Pattern {
                    init: Some(init), ..
                }) => values.push(*init),
                _ => {}
            }
            if let Some(more) = self.assigned.get(&cur) {
                values.extend(more.iter().copied());
            }
            for v in values {
                let t = unwrap_callback(self.ast, &v);
                if let Some(next) = self.ident_idx(&t) {
                    work.push(next);
                } else if is_fn_expr(&t) && !self.fn_by_loc.contains_key(&t.loc.start) {
                    exprs.push(t);
                }
            }
        }
        (out, exprs)
    }

    fn build_ctx(&self, node: FnNode, root_loc: i32) -> (Ctx, bool) {
        let (params, destructured) = param_info(node);
        let mut ctx = Ctx {
            params: HashMap::new(),
            inner: HashSet::new(),
        };
        for (idx, defaults) in params {
            ctx.params.insert(self.canon(idx), defaults);
        }
        let mut inner = HashSet::new();
        let mut walk = |n: N<'_>| {
            self.declared(n, Some(root_loc), &mut |idx, _| {
                inner.insert(self.canon(idx));
            });
        };
        match node {
            FnNode::Stmt(s) => walk_stmt(&s, &mut walk),
            FnNode::Expr(e) => walk_expr(&e, &mut walk),
        }
        ctx.inner = inner;
        (ctx, destructured)
    }

    /// What `node` does in its own lexical body: every depth of nested inline functions, but not another named function it
    /// reaches (those are separate units, listed in `reaches`).
    pub(super) fn analyze_unit(&self, node: FnNode) -> Unit {
        let root_loc = node_loc(node);
        let (ctx, destructured) = self.build_ctx(node, root_loc);
        let mut unit = Unit {
            reads_params: destructured,
            ..Unit::default()
        };
        let mut covered: HashSet<u32> = HashSet::new();
        let mut visit = |n: N<'_>| match n {
            N::S(s) => {
                if let S::SFunction(_) = &s.data
                    && s.loc.start != root_loc
                    && let Some(idx) = self.fn_by_loc.get(&s.loc.start)
                {
                    covered.insert(*idx);
                }
                let init = match &s.data {
                    S::SForIn(fo) => Some(fo.init),
                    S::SForOf(fo) => Some(fo.init),
                    _ => None,
                };
                if let Some(init) = init
                    && let S::SExpr(x) = &init.data
                {
                    let mut targets = Vec::new();
                    assign_targets(&x.value, &mut targets);
                    for t in targets {
                        self.push_write(&t, &ctx, &mut unit.writes);
                    }
                }
            }
            N::E(e) => match &e.data {
                E::EIdentifier(_) | E::EImportIdentifier(_) => {
                    let Some(idx) = self.ident_idx(e) else { return };
                    let name = self.name_at(idx);
                    if self.unbound(idx) && !name.is_empty() {
                        unit.globals.insert(name.clone());
                    }
                    if ctx.params.contains_key(&idx) || name == "arguments" {
                        unit.reads_params = true;
                    }
                    let (ids, exprs) = self.fn_values(idx);
                    unit.reaches.extend(ids);
                    unit.extra.extend(exprs);
                }
                E::EArrow(_) | E::EFunction(_) => {
                    if e.loc.start != root_loc
                        && let Some(idx) = self.fn_by_loc.get(&e.loc.start)
                    {
                        covered.insert(*idx);
                    }
                }
                E::ECall(c) => {
                    if !c.was_jsx_element {
                        unit.callees.insert(self.classify_depth(&c.target, &ctx, 0));
                    }
                }
                E::ENew(nw) => {
                    unit.callees
                        .insert(self.classify_depth(&nw.target, &ctx, 0));
                }
                E::EBinary(b) if is_assign_op(b.op) => {
                    let mut targets = Vec::new();
                    if matches!(b.op, js_ast::OpCode::BinAssign) {
                        assign_targets(&b.left, &mut targets);
                    } else {
                        targets.push(b.left);
                    }
                    for t in targets {
                        self.push_write(&t, &ctx, &mut unit.writes);
                    }
                }
                E::EUnary(u) if is_update_op(u.op) || matches!(u.op, js_ast::OpCode::UnDelete) => {
                    self.push_write(&u.value, &ctx, &mut unit.writes);
                }
                _ => {}
            },
        };
        match node {
            FnNode::Stmt(s) => walk_stmt(&s, &mut visit),
            FnNode::Expr(e) => walk_expr(&e, &mut visit),
        }
        for c in covered {
            unit.reaches.remove(&c);
        }
        unit.writes.sort_by(|a, b| {
            (a.line, a.col, a.target, &a.path).cmp(&(b.line, b.col, b.target, &b.path))
        });
        unit.writes.dedup();
        unit
    }

    fn unit_of_fn(&self, idx: u32) -> Option<Rc<Unit>> {
        if let Some(u) = self.units.borrow().get(&idx) {
            return Some(u.clone());
        }
        let node = *self.fns.get(&idx)?;
        let u = Rc::new(self.analyze_unit(node));
        self.units.borrow_mut().insert(idx, u.clone());
        Some(u)
    }

    fn fn_ref(&self, idx: u32) -> Option<FnRef> {
        let node = *self.fns.get(&idx)?;
        let (line, col) = match node {
            FnNode::Stmt(s) => line_col(self.text, s.loc.start.max(0) as u32),
            FnNode::Expr(e) => self.pos(&e),
        };
        Some(FnRef {
            name: self.name_at(idx),
            line,
            col,
        })
    }

    /// What the handler `value` does: its own body, and every local function it reaches (by call or by reference), at any
    /// depth. Each reached function is also recorded in `Facts::functions`.
    pub(super) fn handler_effects(&mut self, value: &js_ast::Expr) -> HandlerEffects {
        let target = unwrap_callback(self.ast, value);
        let mut writes = Vec::new();
        let mut globals = BTreeSet::new();
        let mut callees = BTreeSet::new();
        let mut reaches: BTreeSet<u32> = BTreeSet::new();
        let reads_params;
        let mut work: Vec<u32> = Vec::new();
        // Function expressions some name may hold that nothing else binds: walked as units of their own.
        let mut pending: Vec<js_ast::Expr> = Vec::new();
        match self.ident_idx(&target) {
            Some(idx)
                if self.fns.contains_key(&idx)
                    && !self.assigned.contains_key(&idx)
                    && !self.assigned_other.contains(&idx) =>
            {
                // `onClick={go}`: the handler IS that local function (a name assigned again is whatever it was last given:
                // the next branch walks every function it may hold and lists the name as an unknown callee).
                let u = self.unit_of_fn(idx).expect("a known local function");
                reads_params = u.reads_params;
                work.push(idx);
            }
            Some(idx)
                if {
                    let (ids, exprs) = self.fn_values(idx);
                    !ids.is_empty() || !exprs.is_empty()
                } =>
            {
                // `const h = go; onClick={h}`: the file does not say which it is when `h` is assigned more than once, and the
                // event may reach any of them.
                reads_params = true;
                let none = Ctx {
                    params: HashMap::new(),
                    inner: HashSet::new(),
                };
                callees.insert(self.classify_depth(&target, &none, 0));
                let (ids, exprs) = self.fn_values(idx);
                work.extend(ids);
                pending.extend(exprs);
            }
            _ if is_fn_expr(&target) => {
                let u = self.analyze_unit(FnNode::Expr(target));
                reads_params = u.reads_params;
                writes.extend(u.writes.iter().cloned());
                globals.extend(u.globals.iter().cloned());
                callees.extend(u.callees.iter().cloned());
                work.extend(u.reaches.iter().copied());
                pending.extend(u.extra.iter().copied());
            }
            _ => {
                // Code the file does not show (a prop, an import, a call result, a conditional): it receives the event, and
                // what it is called is itself the callee. Whatever calls and functions the expression spells are walked.
                reads_params = true;
                let u = self.analyze_unit(FnNode::Expr(target));
                writes.extend(u.writes.iter().cloned());
                globals.extend(u.globals.iter().cloned());
                callees.extend(u.callees.iter().cloned());
                work.extend(u.reaches.iter().copied());
                pending.extend(u.extra.iter().copied());
                let none = Ctx {
                    params: HashMap::new(),
                    inner: HashSet::new(),
                };
                callees.insert(self.classify_depth(&target, &none, 0));
            }
        }
        let mut seen: HashSet<u32> = HashSet::new();
        let mut seen_exprs: HashSet<i32> = HashSet::new();
        loop {
            if let Some(idx) = work.pop() {
                if !seen.insert(idx) {
                    continue;
                }
                let Some(u) = self.unit_of_fn(idx) else {
                    continue;
                };
                reaches.insert(idx);
                writes.extend(u.writes.iter().cloned());
                globals.extend(u.globals.iter().cloned());
                callees.extend(u.callees.iter().cloned());
                work.extend(u.reaches.iter().copied());
                pending.extend(u.extra.iter().copied());
                self.record_fn(idx, &u);
            } else if let Some(e) = pending.pop() {
                if !seen_exprs.insert(e.loc.start) {
                    continue;
                }
                let u = self.analyze_unit(FnNode::Expr(e));
                writes.extend(u.writes.iter().cloned());
                globals.extend(u.globals.iter().cloned());
                callees.extend(u.callees.iter().cloned());
                work.extend(u.reaches.iter().copied());
                pending.extend(u.extra.iter().copied());
            } else {
                break;
            }
        }
        writes.sort_by(|a, b| {
            (a.line, a.col, a.target, &a.path).cmp(&(b.line, b.col, b.target, &b.path))
        });
        writes.dedup();
        HandlerEffects {
            writes,
            reads_params,
            globals: globals.into_iter().collect(),
            callees: callees.into_iter().collect(),
            reaches: reaches.iter().filter_map(|i| self.fn_ref(*i)).collect(),
        }
    }

    fn record_fn(&mut self, idx: u32, u: &Unit) {
        let Some(r) = self.fn_ref(idx) else { return };
        let key = (r.line, r.col);
        if self.fn_facts.contains_key(&key) {
            return;
        }
        let fact = FnFact {
            name: r.name,
            line: r.line,
            col: r.col,
            writes: u.writes.clone(),
            reads_params: u.reads_params,
            globals: u.globals.iter().cloned().collect(),
            callees: u.callees.iter().cloned().collect(),
            reaches: u.reaches.iter().filter_map(|i| self.fn_ref(*i)).collect(),
        };
        self.fn_facts.insert(key, fact);
    }
}

/// Memo of the analysed local functions, by symbol.
pub(super) type UnitCache = RefCell<HashMap<u32, Rc<Unit>>>;

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(src: &str) -> Facts {
        crate::parse::run_on_compiler_thread(|| {
            read_source("el/Promo.tsx", src.as_bytes().to_vec()).expect("the source parses")
        })
    }

    /// The facts of the first handler of a component whose render is `<b onClick={HANDLER}>`; `pre` is what the component
    /// declares before it, `module` what the module declares around it.
    fn handler(module: &str, pre: &str, handler: &str) -> (Facts, HandlerFact) {
        let src = format!(
            "import {{ useState }} from 'react'\nimport {{ bump }} from '../shop/sdk'\n{module}\nexport default function Promo(props: any) {{\n  const [n, setN] = useState(0)\n  let count = 0\n  const ref = {{ current: null as any }}\n{pre}\n  return <b onClick={{{handler}}}>x</b>\n}}\n"
        );
        let f = facts(&src);
        let h = f.handlers[0].clone();
        (f, h)
    }

    fn kinds(h: &HandlerFact) -> Vec<(&str, &str)> {
        h.callees
            .iter()
            .map(|c| (c.name.as_str(), c.kind))
            .collect()
    }

    fn writes(h: &HandlerFact) -> Vec<(&str, &str)> {
        h.writes
            .iter()
            .map(|w| (w.target, w.path.as_str()))
            .collect()
    }

    #[test]
    fn the_repro_an_assignment_through_the_event_is_a_param_member_write() {
        let (_, h) = handler(
            "",
            "",
            "(e: any) => { e.currentTarget.innerHTML = '<b>x</b>'; setN(n + 1) }",
        );
        assert_eq!(
            writes(&h),
            vec![("param-member", "e.currentTarget.innerHTML")]
        );
        assert!(h.reads_params);
        assert!(
            h.callees
                .iter()
                .any(|c| c.name == "setN" && c.kind == "setter")
        );
        assert!(h.globals.is_empty(), "{:?}", h.globals);
    }

    #[test]
    fn a_pure_setter_handler_has_no_writes_reads_no_parameter_and_reaches_no_global() {
        let (f, h) = handler("", "", "() => setN(n + 1)");
        assert!(
            h.writes.is_empty() && !h.reads_params && h.globals.is_empty() && h.reaches.is_empty()
        );
        assert!(f.functions.is_empty());
        // An unused parameter is not a read; a read of it is.
        assert!(!handler("", "", "(e: any) => setN(1)").1.reads_params);
        assert!(
            handler("", "", "(e: any) => setN(e.target.value)")
                .1
                .reads_params
        );
    }

    #[test]
    fn a_write_through_an_alias_of_the_parameter_is_still_a_param_member_write() {
        let (_, h) = handler(
            "",
            "",
            "(e: any) => { const t = e.currentTarget; t.innerHTML = 'x'; const u = t; u.title = 'y' }",
        );
        assert_eq!(
            writes(&h),
            vec![("param-member", "t.innerHTML"), ("param-member", "u.title")]
        );
    }

    #[test]
    fn a_destructured_parameter_is_a_read_and_its_names_are_parameters() {
        let (_, h) = handler(
            "",
            "",
            "({ currentTarget }: any) => { currentTarget.innerHTML = 'x' }",
        );
        assert_eq!(
            writes(&h),
            vec![("param-member", "currentTarget.innerHTML")]
        );
        assert!(h.reads_params);
        // Destructured out of the parameter inside the body.
        let (_, h) = handler(
            "",
            "",
            "(e: any) => { const { target } = e; target.value = '1' }",
        );
        assert_eq!(writes(&h), vec![("param-member", "target.value")]);
    }

    #[test]
    fn writes_in_a_nested_arrow_and_in_every_statement_form_are_found() {
        let (_, h) = handler(
            "",
            "",
            "(e: any) => { [1].forEach(() => { e.target.x = 1 }); e.target.n++; --e.target.m; e.target.v += 1; delete e.target.d; e.target.a ??= 2 }",
        );
        assert_eq!(
            writes(&h),
            vec![
                ("param-member", "e.target.x"),
                ("param-member", "e.target.n"),
                ("param-member", "e.target.m"),
                ("param-member", "e.target.v"),
                ("param-member", "e.target.d"),
                ("param-member", "e.target.a"),
            ]
        );
    }

    #[test]
    fn destructuring_assignments_and_loop_targets_are_writes() {
        let (_, h) = handler(
            "",
            "",
            "(e: any) => { [e.target.a, e.target.b = 1] = [1, 2]; ({ k: e.target.c, ...e.target.d } = { k: 1 }); for (e.target.i of [1]) {} for (e.target.j in {}) {} }",
        );
        assert_eq!(
            writes(&h),
            vec![
                ("param-member", "e.target.a"),
                ("param-member", "e.target.b"),
                ("param-member", "e.target.c"),
                ("param-member", "e.target.d"),
                ("param-member", "e.target.i"),
                ("param-member", "e.target.j"),
            ]
        );
    }

    #[test]
    fn a_local_function_reached_transitively_is_part_of_the_handler_and_has_its_own_fact() {
        let (f, h) = handler(
            "function paint(el: any) { el.style.color = 'red' }\nfunction go(e: any) { paint(e.currentTarget) }",
            "",
            "() => go(undefined)",
        );
        assert_eq!(writes(&h), vec![("param-member", "el.style.color")]);
        assert_eq!(
            h.reaches
                .iter()
                .map(|r| r.name.as_str())
                .collect::<Vec<_>>(),
            vec!["paint", "go"]
        );
        let names: Vec<_> = f
            .functions
            .iter()
            .map(|x| (x.name.as_str(), x.writes.len(), x.reads_params))
            .collect();
        assert_eq!(
            names,
            vec![("paint", 1, true), ("go", 0, true)],
            "{:?}",
            f.functions
        );
        // Reached by reference, not by call: `forEach(go)`.
        let (_, h) = handler(
            "function mark(el: any) { el.dataset.on = '1' }",
            "",
            "(e: any) => { [e.target].forEach(mark) }",
        );
        assert_eq!(writes(&h), vec![("param-member", "el.dataset.on")]);
        // Reached through an alias of the function, and as the handler itself.
        let (_, h) = handler(
            "function mark(el: any) { el.dataset.on = '1' }",
            "const m = mark",
            "() => m(1)",
        );
        assert_eq!(writes(&h), vec![("param-member", "el.dataset.on")]);
        let (_, h) = handler(
            "function mark(el: any) { el.dataset.on = '1' }",
            "const m = mark",
            "m",
        );
        assert_eq!(writes(&h), vec![("param-member", "el.dataset.on")]);
        assert!(h.reads_params);
        // A function nested in the handler is walked in place.
        let (_, h) = handler(
            "",
            "",
            "(e: any) => { function inner() { e.target.x = 1 } inner() }",
        );
        assert_eq!(writes(&h), vec![("param-member", "e.target.x")]);
    }

    #[test]
    fn globals_and_global_members_are_written_and_called_as_such() {
        let (_, h) = handler(
            "",
            "",
            "() => { document.title = 'x'; window.location.href = '/y'; location = '/z'; globalThis['name'] = 'n'; document.body.append('p') }",
        );
        assert_eq!(
            writes(&h),
            vec![
                ("global-member", "document.title"),
                ("global-member", "window.location.href"),
                ("global", "location"),
                ("global-member", "globalThis[\"name\"]"),
            ]
        );
        assert_eq!(
            h.globals,
            vec!["document", "globalThis", "location", "window"]
        );
        assert!(
            h.callees
                .iter()
                .any(|c| c.name == "document.body.append" && c.kind == "global-member")
        );
        // An alias of a global, a name destructured out of one, and an object the platform made.
        let (_, h) = handler(
            "",
            "",
            "() => { const w = window; w.location.href = '/'; const { body } = document; body.innerHTML = ''; const i = new Image(); i.src = '/x' }",
        );
        assert_eq!(
            writes(&h),
            vec![
                ("global-member", "w.location.href"),
                ("global-member", "body.innerHTML"),
                ("global-member", "i.src"),
            ]
        );
    }

    #[test]
    fn a_call_on_a_parameter_is_a_param_member_callee_not_a_dropped_one() {
        let (_, h) = handler(
            "",
            "",
            "(e: any) => { e.preventDefault(); e.target.remove(); e.target.closest('a').remove() }",
        );
        let kinds: Vec<_> = h
            .callees
            .iter()
            .map(|c| (c.name.as_str(), c.kind))
            .collect();
        assert!(
            kinds.contains(&("e.preventDefault", "param-member")),
            "{kinds:?}"
        );
        assert!(
            kinds.contains(&("e.target.remove", "param-member")),
            "{kinds:?}"
        );
        // A chain through a call is a callee the walk cannot name.
        assert!(kinds.contains(&("", "unknown")), "{kinds:?}");
        assert!(h.writes.is_empty());
    }

    #[test]
    fn local_is_claimed_only_for_the_handlers_own_variables_and_literals_one_level_deep() {
        let (_, h) = handler(
            "",
            "",
            "() => { let a = 0; a = 5; a += 1; const o: any = {}; o.x = 1; o['y'] = 2; const xs: any = []; xs[0] = 1; xs.length = 0 }",
        );
        assert!(
            h.writes.iter().all(|w| w.target == "local"),
            "{:?}",
            h.writes
        );
        assert_eq!(h.writes.len(), 6);
        // Deeper, or through what was stored in the object, is not local.
        let (_, h) = handler(
            "",
            "",
            "() => { const o: any = {}; o.t = document.body; o.t.innerHTML = 'x'; const { t } = o; t.title = 'y'; const arr: any = [document.body]; arr[0].title = 'z'; for (const el of arr) el.title = 'w' }",
        );
        assert_eq!(
            writes(&h),
            vec![
                ("local", "o.t"),
                ("other", "o.t.innerHTML"),
                ("other", "t.title"),
                ("other", "arr[?].title"),
                ("other", "el.title"),
            ]
        );
    }

    #[test]
    fn what_the_walk_cannot_trace_is_other_and_never_local() {
        let (_, h) = handler(
            "",
            "",
            "(e: any) => { e.target.closest('a').innerHTML = 'x'; (function (this: any) { this.x = 1 })(); const t: any = foo(); t.x = 1; let m: any = e.target; m = document.body; m.x = 1 }",
        );
        assert_eq!(
            writes(&h),
            vec![
                ("other", "e.target.closest(?).innerHTML"),
                ("other", "this.x"),
                ("other", "t.x"),
                ("local", "m"),
                ("other", "m.x"),
            ]
        );
        // A name assigned from a literal and from a parameter is what the parameter is.
        let (_, h) = handler(
            "",
            "",
            "(e: any) => { let t: any = {}; t = e.target; t.x = 1 }",
        );
        assert_eq!(writes(&h), vec![("local", "t"), ("param-member", "t.x")]);
        // A destructuring assignment stores something the walk does not follow.
        let (_, h) = handler(
            "",
            "",
            "(e: any) => { let t: any = {}; [t] = [e.target]; t.x = 1 }",
        );
        assert!(
            h.writes
                .iter()
                .any(|w| w.path == "t.x" && w.target == "other"),
            "{:?}",
            h.writes
        );
    }

    #[test]
    fn closure_and_parameter_variables_are_named_for_what_they_are() {
        let (_, h) = handler(
            "",
            "",
            "(e: any) => { count = 5; ref.current = e.target; props.x = 1; e = null }",
        );
        assert_eq!(
            writes(&h),
            vec![
                ("closure", "count"),
                ("closure-member", "ref.current"),
                ("prop-member", "props.x"),
                ("param", "e"),
            ]
        );
    }

    #[test]
    fn a_handler_the_file_does_not_show_is_itself_a_callee_and_receives_the_event() {
        let (_, h) = handler("", "", "props.go");
        assert!(h.reads_params);
        assert!(
            h.callees.iter().any(|c| c.name == "props.go"),
            "{:?}",
            h.callees
        );
        let (_, h) = handler("", "", "bump");
        assert!(h.reads_params);
        assert_eq!(
            h.callees
                .iter()
                .map(|c| (c.name.as_str(), c.kind))
                .collect::<Vec<_>>(),
            vec![("bump", "import")]
        );
        // A call result and a conditional: unknown, and whatever the expression spells is walked.
        let (_, h) = handler(
            "function make() { return () => { document.title = 'x' } }",
            "",
            "make()",
        );
        assert!(
            h.callees.iter().any(|c| c.kind == "unknown"),
            "{:?}",
            h.callees
        );
        assert_eq!(writes(&h), vec![("global-member", "document.title")]);
    }

    #[test]
    fn a_call_through_an_alias_of_a_global_is_the_global_member() {
        let (_, h) = handler("const f = window.fetch", "", "() => f('/x')");
        assert!(
            h.callees
                .iter()
                .any(|c| c.name == "window.fetch" && c.kind == "global-member"),
            "{:?}",
            h.callees
        );
        let (_, h) = handler("", "const { fetch } = window", "() => fetch('/x')");
        assert!(
            h.callees
                .iter()
                .any(|c| c.name == "fetch" && c.kind == "global-member"),
            "{:?}",
            h.callees
        );
        // A function parameter called, and a name assigned twice: unknown. A prop and a local function stay local.
        let (_, h) = handler(
            "function run(cb: any) { cb() }",
            "let g = bump; g = props.x",
            "() => { run(1); g() }",
        );
        assert!(
            h.callees
                .iter()
                .any(|c| c.name == "cb" && c.kind == "unknown"),
            "{:?}",
            h.callees
        );
        assert!(
            h.callees
                .iter()
                .any(|c| c.name == "g" && c.kind == "unknown"),
            "{:?}",
            h.callees
        );
        let (_, h) = handler(
            "function a() {}",
            "const { onSave } = props",
            "() => { a(); onSave() }",
        );
        assert_eq!(kinds(&h), vec![("a", "local"), ("onSave", "prop")]);
    }

    #[test]
    fn a_setter_or_a_local_function_must_be_what_it_looks_like() {
        // A name that is assigned again, and a `useState` that is not React's.
        let f = facts(
            "import { useState } from 'react'\nexport default function Promo() {\n  let [n, setN] = useState(0)\n  setN = window.fetch as any\n  return <b onClick={() => setN('/x')}>x</b>\n}\n",
        );
        assert!(
            f.handlers[0]
                .callees
                .iter()
                .any(|c| c.name == "setN" && c.kind == "unknown"),
            "{:?}",
            f.handlers[0].callees
        );
        let f = facts(
            "function useState(v: any): any { return [v, window.fetch] }\nexport default function Promo() {\n  const [m, setM] = useState(0)\n  return <b onClick={() => setM('/x')}>x</b>\n}\n",
        );
        assert!(
            f.handlers[0].callees.iter().all(|c| c.kind != "setter"),
            "{:?}",
            f.handlers[0].callees
        );
        assert!(
            f.hooks
                .iter()
                .any(|k| k.name == "useState" && k.from.is_none())
        );
        // A local function that is reassigned.
        let (_, h) = handler(
            "let go = () => {}\ngo = window.fetch as any",
            "",
            "() => go()",
        );
        assert!(
            h.callees
                .iter()
                .any(|c| c.name == "go" && c.kind == "unknown"),
            "{:?}",
            h.callees
        );
        // `React.useState` from the namespace import is React's.
        let f = facts(
            "import * as React from 'react'\nexport default function Promo() {\n  const [n, setN] = React.useState(0)\n  return <b onClick={() => setN(n + 1)}>x</b>\n}\n",
        );
        assert!(
            f.handlers[0]
                .callees
                .iter()
                .any(|c| c.name == "setN" && c.kind == "setter"),
            "{:?}",
            f.handlers[0].callees
        );
    }

    #[test]
    fn a_class_or_an_object_the_file_built_is_never_a_local_callee() {
        let (_, h) = handler(
            "class Foo { constructor() { document.title = 'x' } }",
            "",
            "() => new Foo()",
        );
        assert!(
            h.callees
                .iter()
                .any(|c| c.name == "Foo" && c.kind == "unknown"),
            "{:?}",
            h.callees
        );
        let (_, h) = handler(
            "const api = { f: window.fetch }",
            "const { f } = api",
            "() => f('/x')",
        );
        assert!(
            h.callees
                .iter()
                .any(|c| c.name == "f" && c.kind == "unknown"),
            "{:?}",
            h.callees
        );
        // A prop destructured from the component's own parameter is caller-supplied: `prop`, never `local`.
        let (_, h) = handler("", "const { onSave } = props", "() => onSave()");
        assert_eq!(kinds(&h), vec![("onSave", "prop")]);
    }

    #[test]
    fn a_reassigned_handler_function_and_untraceable_bindings_are_never_local() {
        // `onClick={go}` where `go` is assigned again: every function it may hold is walked, and the name is unknown.
        let (_, h) = handler(
            "let go = (e: any) => { e.target.x = 1 }\ngo = (e: any) => { document.title = 'x' }",
            "",
            "go",
        );
        assert!(
            h.callees
                .iter()
                .any(|c| c.name == "go" && c.kind == "unknown"),
            "{:?}",
            h.callees
        );
        assert_eq!(
            writes(&h),
            vec![
                ("param-member", "e.target.x"),
                ("global-member", "document.title")
            ]
        );
        // A loop binding of the component, and a prop object that is written to, are not fixed by the file.
        let f = facts(
            "export default function Promo({ items }: any) {\n  const out: any[] = []\n  for (const f of items) out.push(<b onClick={() => f()}>x</b>)\n  return <>{out}</>\n}\n",
        );
        assert!(
            f.handlers[0]
                .callees
                .iter()
                .any(|c| c.name == "f" && c.kind == "unknown"),
            "{:?}",
            f.handlers[0].callees
        );
        let (_, h) = handler(
            "",
            "props.onSave = window.fetch\nconst { onSave } = props",
            "() => onSave('/x')",
        );
        // `prop` is claimed only for a parameter that holds what its caller passed: the props object is written to here.
        assert_eq!(kinds(&h), vec![("onSave", "unknown")]);
        let (_, h) = handler(
            "",
            "props.onSave = window.fetch",
            "() => props.onSave('/x')",
        );
        assert_eq!(kinds(&h), vec![("props.onSave", "member")]);
        let f = facts(
            "function Btn(f: any) {\n  f = window.fetch\n  return <button onClick={() => f('x')}>x</button>\n}\nexport default function P() { return Btn(1) }\n",
        );
        assert_eq!(kinds(&f.handlers[0]), vec![("f", "unknown")]);
        // A handler that writes a member of the props does not stop an untouched parameter being a `prop`.
        let f = facts(
            "function Btn(f: any, o: any) {\n  return <button onClick={() => { f(1); o.x = 2 }}>x</button>\n}\nexport default function P() { return Btn(1, 2) }\n",
        );
        assert_eq!(kinds(&f.handlers[0]), vec![("f", "prop")]);
        assert_eq!(writes(&f.handlers[0]), vec![("prop-member", "o.x")]);
    }

    #[test]
    fn a_parameter_of_any_enclosing_function_is_a_prop_never_local() {
        // A helper's parameter called from a handler written inside it, wired to a global by the same file.
        let f = facts(
            "export default function P() {\n  const Btn = (f: any) => <button onClick={() => f('x')}>x</button>\n  return Btn(document.write.bind(document))\n}\n",
        );
        assert_eq!(kinds(&f.handlers[0]), vec![("f", "prop")]);
        // The handler named by the parameter, and a same-file component's destructured prop.
        let f = facts(
            "function Btn(f: any) { return <button onClick={f}>x</button> }\nexport default function P() { return Btn(document.write) }\n",
        );
        assert_eq!(kinds(&f.handlers[0]), vec![("f", "prop")]);
        let f = facts(
            "function Inner({ f }: any) { return <button onClick={() => f(1)}>x</button> }\nexport default function P() { return <Inner f={document.write.bind(document)} /> }\n",
        );
        assert_eq!(kinds(&f.handlers[0]), vec![("f", "prop")]);
        // A call through a member of a prop.
        let (_, h) = handler("", "", "() => { props.onSave(1); props.api.send(2) }");
        assert_eq!(
            kinds(&h),
            vec![
                ("props.api.send", "prop-member"),
                ("props.onSave", "prop-member")
            ]
        );
        // An alias keeps the kind, and a destructured member of one is still caller-supplied.
        let (_, h) = handler(
            "",
            "const g = props.onSave\nconst { a: { b } } = props",
            "() => { g(1); b(2) }",
        );
        assert_eq!(
            kinds(&h),
            vec![("b", "prop"), ("props.onSave", "prop-member")]
        );
        // A write to a member of a prop is a `prop-member` write, at any depth.
        let (_, h) = handler("", "", "() => { props.obj.x = 1; props.y++ }");
        assert_eq!(
            writes(&h),
            vec![("prop-member", "props.obj.x"), ("prop-member", "props.y")]
        );
        // A component's own `const` is a closure variable, not a prop.
        let (_, h) = handler("", "const cfg = { a: 1 }", "() => { cfg.a = 2 }");
        assert_eq!(writes(&h), vec![("closure-member", "cfg.a")]);
    }

    #[test]
    fn writes_in_the_odd_places_are_found() {
        let (_, h) = handler(
            "",
            "",
            "async (e: any, x: any = (document.title = 'a')) => { const o: any = { set s(v: any) { document.body.id = v } }; o.s = 1; class A { static k = (e.target.k = 1) }; await fetch('/x'); foo(e.target.a = 1); (e.target.b = 1, 2); c ? (e.target.d = 1) : 0; c && (e.target.f = 1); void (e.target.g = 1); try { throw 1 } catch (z: any) { e.target.h = z } finally { e.target.i = 1 } }",
        );
        let paths: Vec<_> = h.writes.iter().map(|w| w.path.as_str()).collect();
        for want in [
            "document.title",
            "document.body.id",
            "o.s",
            "e.target.k",
            "e.target.a",
            "e.target.b",
            "e.target.d",
            "e.target.f",
            "e.target.g",
            "e.target.h",
            "e.target.i",
        ] {
            assert!(paths.contains(&want), "{want} missing from {paths:?}");
        }
        assert!(
            h.writes
                .iter()
                .all(|w| w.target != "local" || w.path == "o.s"),
            "{:?}",
            h.writes
        );
        // A callback the handler is wrapped in, and a function named by `useCallback`.
        let (_, h) = handler(
            "",
            "const go = useCallback((e: any) => { e.target.x = 1 }, [])",
            "go",
        );
        assert_eq!(writes(&h), vec![("param-member", "e.target.x")]);
        let (_, h) = handler("", "", "useCallback((e: any) => { e.target.x = 1 }, [])");
        assert_eq!(writes(&h), vec![("param-member", "e.target.x")]);
        // `var` declared twice is an assignment of the second value.
        let (_, h) = handler(
            "",
            "",
            "(e: any) => { var t: any = {}; if (n) { var t: any = e.target } t.x = 1 }",
        );
        assert!(
            h.writes
                .iter()
                .any(|w| w.path == "t.x" && w.target == "param-member"),
            "{:?}",
            h.writes
        );
    }

    #[test]
    fn the_new_fields_serialise_camel_case() {
        let (f, _) = handler("function go() { document.title = 'x' }", "", "() => go()");
        let json = serde_json::to_value(&f).unwrap();
        let h = &json["handlers"][0];
        assert_eq!(h["readsParams"], false);
        assert_eq!(h["writes"][0]["target"], "global-member");
        assert_eq!(h["reaches"][0]["name"], "go");
        assert_eq!(json["functions"][0]["readsParams"], false);
        assert!(h.get("reads_params").is_none());
    }
}
