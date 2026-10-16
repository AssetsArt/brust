//! What each identifier in a component refers to, decided from Bun's symbol
//! table and import records, never from the spelling (plan Review Focus 4).
use crate::ir::{IdentKind, PolyTag};
use bun_ast as js_ast;
use js_ast::b::B;
use js_ast::expr::Data as E;
use std::collections::{HashMap, HashSet};

/// A member of an imported binding (shadcn S1.4, R34.35): `<DialogPrimitive.Root>` with
/// `import { Dialog as DialogPrimitive } from "radix-ui"` is `radix-ui` / `Dialog` / `["Root"]`; the same holds
/// for a module-level `const Root = DialogPrimitive.Root` alias. `imported` is `default`, `*` or a name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemberRef {
    pub source: String,
    pub imported: String,
    pub member: Vec<String>,
}

/// Sources a member tag may resolve into: packages. A relative module (its members are components the
/// compiler could compile, a later lane) and React itself (`React.Fragment`) are not.
pub fn is_package_source(source: &str) -> bool {
    !(source.starts_with('.')
        || source.starts_with('/')
        || source == "react"
        || source.starts_with("react/"))
}

/// `BASE.MEMBER` where `BASE` is an import from a package (single level, no optional chain).
pub fn member_of(
    e: &js_ast::Expr,
    import_of: impl Fn(js_ast::Ref) -> Option<(String, String)>,
) -> Option<MemberRef> {
    use js_ast::expr::Data as E;
    let E::EDot(d) = &e.data else { return None };
    if d.optional_chain.is_some() {
        return None;
    }
    let r = match &d.target.data {
        E::EIdentifier(id) => id.ref_,
        E::EImportIdentifier(id) => id.ref_,
        _ => return None,
    };
    let (source, imported) = import_of(r)?;
    is_package_source(&source).then(|| MemberRef {
        source,
        imported,
        member: vec![String::from_utf8_lossy(d.name.slice()).into_owned()],
    })
}

/// What the printer prints a renamed symbol as, by symbol index (custom hooks, G3).
pub type Aliases = HashMap<u32, String>;

/// A symbol renamed while a custom hook is inlined (G3): what it prints as, and what it
/// reads as when that is not its own classification (an argument bound to the caller's
/// value reads as the caller's identifier).
#[derive(Clone, Debug)]
pub struct Alias {
    pub print: String,
    pub kind: Option<(String, IdentKind)>,
}

/// Symbol-indexed facts about one component. Keys are `Ref::inner_index` of the
/// symbol after following links.
pub struct NameTable<'a> {
    symbols: &'a [js_ast::Symbol],
    /// Local import binding → (module path, imported name; `default` or `*` for
    /// default and namespace imports).
    imports: HashMap<u32, (String, String)>,
    /// Local binding → the prop it reads (`heading` → `title`).
    props: HashMap<u32, String>,
    /// The component's parameter when it is not destructured (`props`).
    props_ident: Option<u32>,
    /// `...rest` of a destructured props pattern (shadcn S1.2, R34.14): `rest.k` reads prop `k`
    /// (`undefined` for a named key), `{...rest}` spreads the props minus the named keys.
    rest: Option<u32>,
    /// The keys the props pattern names (what `rest` leaves out).
    named_props: Vec<String>,
    /// Where `rest` is read in a way brust cannot narrow to the props minus the named keys:
    /// the bare object as a value, or inside code printed as written (R34.14: fail closed).
    pub rest_escape: std::cell::Cell<Option<u32>>,
    /// F162: where a body pattern's name is used by a statement BEFORE the pattern (a TDZ error in React).
    pub use_before_pattern: std::cell::Cell<Option<u32>>,
    /// A prop READ as a member (`props.loop`, `rest.range`) whose name the template cannot carry (first one: location, name, code, what).
    pub prop_read_problem: std::cell::RefCell<Option<(u32, String, &'static str, &'static str)>>,
    /// Binding locations of the body statements `const { a, b = 1, ...rest } = props` that are read as the props
    /// pattern (R34.66): the same reads as a parameter pattern, so the statement itself is skipped.
    absorbed: HashSet<i32>,
    /// The forwarded ref of a `forwardRef(function (props, ref) {…})` component (R34.63): the symbol of `ref`.
    forwarded_ref: Option<u32>,
    /// Where the reads of it that were dropped as `ref={ref}` on a host element are (any other read fails closed).
    forwarded_ref_dropped: std::cell::RefCell<HashSet<i32>>,
    /// Module-level `const X = BASE.MEMBER` (never reassigned) with `BASE` imported from a package.
    member_aliases: HashMap<u32, MemberRef>,
    /// `const x = c ? {…} : {…}` at module level or at the top of the component body: the initialiser, for
    /// a union spread `{...x}` (R34.66). Only a conditional is kept; a `const` is never reassigned.
    cond_consts: HashMap<u32, js_ast::Expr>,
    /// Module-level `const NAME = <literal-shaped initialiser>` with no use that could write it, by name: the
    /// folder reads them for a prop default (`orientation = DEFAULT_ORIENTATION`, F153b).
    module_inits: HashMap<String, js_ast::Expr>,
    /// The component's polymorphic tag local (`Comp` of `const Comp = asChild ? Slot.Root : "a"`, R34.28).
    poly: HashMap<u32, PolyTag>,
    state: HashSet<u32>,
    /// B4: `const x = useRef(init)` whose `.current` is only ever read in the render (never written, never bound to an
    /// element, never read inside a function): held as a state cell (`state` holds it too).
    snapshot_refs: HashSet<u32>,
    /// B4: the first verbatim code that reads such a ref (the component keeps the `ref-in-render` fallback).
    pub snapshot_escape: std::cell::Cell<Option<u32>>,
    setters: HashSet<u32>,
    loop_bindings: HashSet<u32>,
    /// `useStore` bindings (M3-F D7) → (handle as written, key): the view `s` has key `None`,
    /// a destructured `{ count }` has `Some("count")`.
    stores: HashMap<u32, (String, Option<String>)>,
    /// The exact symbols the parser generated for the JSX runtime: callees of
    /// lowered JSX calls and the generated `Fragment` tag (never by spelling).
    jsx_runtime: HashSet<u32>,
    /// Renamed symbols (G3), and the same map as print names for the printer.
    aliases: HashMap<u32, Alias>,
    printed: Aliases,
    /// The context declarations of the module (S2): Providers, hooks, React contexts.
    pub contexts: crate::analyze::context::Contexts,
    /// `const context = useXContext(…)` locals (symbol key → context name): `context.field` reads a hidden prop.
    ctx_locals: HashMap<u32, String>,
    /// The fields read per context by this component (first-use order).
    ctx_fields: std::cell::RefCell<Vec<(String, String)>>,
    /// Where a context local is used as a bare value (not `context.field`): brust cannot narrow it (fail closed).
    pub ctx_escape: std::cell::Cell<Option<u32>>,
}

/// Every `import` binding of the module: local symbol (`Ref::inner_index`) → (module path,
/// imported name; `default` or `*` for default and namespace imports). `import` statements are
/// the source of truth: `ast.named_imports` is a bundler table and leaves out default and
/// namespace imports.
pub fn module_imports(ast: &js_ast::Ast<'_>) -> HashMap<u32, (String, String)> {
    let records = ast.import_records.as_slice();
    let path_of = |i: u32| {
        records
            .get(i as usize)
            .map(|r| String::from_utf8_lossy(r.path.text).into_owned())
    };
    let mut imports = HashMap::new();
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            let js_ast::stmt::Data::SImport(imp) = &stmt.data else {
                continue;
            };
            let Some(path) = path_of(imp.import_record_index) else {
                continue;
            };
            if let Some(d) = &imp.default_name {
                imports.insert(d.ref_.inner_index(), (path.clone(), "default".into()));
            }
            for item in imp.items.slice() {
                let imported = String::from_utf8_lossy(item.alias.slice()).into_owned();
                imports.insert(item.name.ref_.inner_index(), (path.clone(), imported));
            }
            if imp.star_name_loc.start >= 0 {
                imports.insert(imp.namespace_ref.inner_index(), (path, "*".into()));
            }
        }
    }
    imports
}

/// The hooks React 19 exports from `react`: functions, so truthy, and hooks by their name.
const REACT_HOOKS: &[&str] = &[
    "useActionState",
    "useCallback",
    "useContext",
    "useDebugValue",
    "useDeferredValue",
    "useEffect",
    "useId",
    "useImperativeHandle",
    "useInsertionEffect",
    "useLayoutEffect",
    "useMemo",
    "useOptimistic",
    "useReducer",
    "useRef",
    "useState",
    "useSyncExternalStore",
    "useTransition",
];

/// A string a key expression always evaluates to: a literal, or `.trim()` / `.toString()` of one (the same pure
/// string methods the constant folder knows).
fn const_string(e: &js_ast::Expr) -> Option<String> {
    match &e.data {
        E::EString(s) => Some(crate::analyze::expr::estring(s)),
        E::ECall(c) if c.args.is_empty() => {
            let E::EDot(d) = &c.target.data else {
                return None;
            };
            let inner = const_string(&d.target)?;
            match d.name.slice() {
                b"trim" => Some(inner.trim_matches(crate::ir::is_js_space).to_string()),
                b"toString" => Some(inner),
                _ => None,
            }
        }
        _ => None,
    }
}

impl<'a> NameTable<'a> {
    pub fn new(ast: &'a js_ast::Ast<'_>, component: &js_ast::G::Fn) -> Self {
        let mut table = Self::for_hook(ast);
        if let Some(arg) = component.args.slice().first() {
            match arg.binding.data {
                B::BIdentifier(id) => {
                    table.props_ident = Some(table.key(id.r#ref));
                    table.absorb_body_patterns(component);
                }
                // Only plain `key` / `key: local` / `key = default` bind a prop, and a
                // trailing `...rest` (R34.14); nested patterns are a `prop-pattern`
                // fallback (read_props) and their bindings stay Local.
                B::BObject(obj) => {
                    for p in obj.properties() {
                        if p.flags.contains(js_ast::flags::Property::IsSpread) {
                            if let B::BIdentifier(id) = p.value.data {
                                table.rest = Some(table.key(id.r#ref));
                            }
                            continue;
                        }
                        let (B::BIdentifier(id), js_ast::expr::Data::EString(key)) =
                            (p.value.data, &p.key.data)
                        else {
                            continue;
                        };
                        if p.flags.contains(js_ast::flags::Property::IsSpread) {
                            continue;
                        }
                        let k = table.key(id.r#ref);
                        let name = crate::analyze::expr::estring(key);
                        table.named_props.push(name.clone());
                        table.props.insert(k, name);
                    }
                }
                B::BArray(_) | B::BMissing(_) => {}
            }
        }
        table
    }

    /// `const { a, b = 1, ...rest } = props` at the top level of the body (with `props` the plain first parameter)
    /// binds props exactly like the parameter pattern (R34.66). Only the plain shapes the parameter pattern reads
    /// (`key`, `key: local`, `key = default`, a trailing `...rest`, one `...rest` per component) are absorbed; any
    /// other destructuring stays the `body-shape` fallback.
    fn absorb_body_patterns(&mut self, component: &js_ast::G::Fn) {
        let Some(props) = self.props_ident else {
            return;
        };
        // A default is read before the body's own bindings exist (the statement is skipped, the template binds no
        // local for it): one that reads a binding declared in the body would print a bare, unbound name. Such a
        // pattern stays `body-shape` (review F1).
        let mut body = crate::analyze::expr::Walk::default();
        body.stmts(component.body.stmts.slice());
        let declared: HashSet<u32> = body.declared.iter().map(|r| self.key(*r)).collect();
        let mut candidates = Vec::new();
        for (at, stmt) in component.body.stmts.slice().iter().enumerate() {
            let js_ast::stmt::Data::SLocal(l) = &stmt.data else {
                continue;
            };
            if !matches!(l.kind, js_ast::S::Kind::KConst) || l.decls.len() != 1 {
                continue;
            }
            let d = &l.decls[0];
            let (B::BObject(obj), Some(v)) = (d.binding.data, d.value) else {
                continue;
            };
            let js_ast::expr::Data::EIdentifier(id) = &v.data else {
                continue;
            };
            if self.key(id.ref_) != props {
                continue;
            }
            let plain = obj.properties().iter().all(|p| {
                matches!(p.value.data, B::BIdentifier(_))
                    && (p.flags.contains(js_ast::flags::Property::IsSpread)
                        || matches!(&p.key.data, js_ast::expr::Data::EString(_)))
            });
            let defaults_ok = obj.properties().iter().all(|p| {
                p.default_value.as_ref().is_none_or(|dv| {
                    let mut w = crate::analyze::expr::Walk::default();
                    w.expr(dv);
                    !w.used.iter().any(|u| declared.contains(&self.key(*u)))
                })
            });
            // F162: a name of the pattern read by an EARLIER statement is a TDZ error in React (the pattern is not read
            // yet); brust would render it (a bound, defined prop). A closure declared before counts too: fail closed.
            let bound: HashSet<u32> = obj
                .properties()
                .iter()
                .filter_map(|p| match p.value.data {
                    B::BIdentifier(b) => Some(self.key(b.r#ref)),
                    _ => None,
                })
                .collect();
            let early = component.body.stmts.slice()[..at].iter().find_map(|s| {
                let mut w = crate::analyze::expr::Walk::default();
                w.stmts(std::slice::from_ref(s));
                w.used_at
                    .iter()
                    .find(|(u, _)| bound.contains(&self.key(*u)))
                    .map(|(_, loc)| (*loc).max(0) as u32)
            });
            if let Some(loc) = early {
                if self.use_before_pattern.get().is_none() {
                    self.use_before_pattern.set(Some(loc));
                }
                continue;
            }
            if plain && defaults_ok {
                candidates.push((d.binding.loc.start, obj));
            }
        }
        let is_rest = |p: &js_ast::b::Property| p.flags.contains(js_ast::flags::Property::IsSpread);
        let with_rest = candidates
            .iter()
            .filter(|(_, o)| o.properties().iter().any(is_rest))
            .count();
        // `...rest` leaves out the keys of its own pattern only (JS), while a component's declared props are one
        // list: a rest is read only when its pattern is the only one (anything else stays `body-shape`).
        if with_rest > 1
            || (with_rest == 1 && candidates.len() > 1)
            || self.rest.is_some() && with_rest > 0
        {
            return;
        }
        for (loc, obj) in candidates {
            for p in obj.properties() {
                let B::BIdentifier(b) = p.value.data else {
                    continue;
                };
                let k = self.key(b.r#ref);
                if is_rest(p) {
                    self.rest = Some(k);
                } else if let js_ast::expr::Data::EString(key) = &p.key.data {
                    let name = crate::analyze::expr::estring(key);
                    if with_rest == 1 {
                        self.named_props.push(name.clone());
                    }
                    self.props.insert(k, name);
                }
            }
            self.absorbed.insert(loc);
        }
    }

    /// The body statement whose binding starts at `loc` was absorbed into the props pattern.
    pub fn is_absorbed(&self, loc: i32) -> bool {
        self.absorbed.contains(&loc)
    }

    /// The table for a custom hook's body (G3): the same module facts, and no props (a
    /// hook's first parameter is an ordinary argument).
    pub fn for_hook(ast: &'a js_ast::Ast<'_>) -> Self {
        let imports = module_imports(ast);
        let mut table = NameTable {
            symbols: ast.symbols.as_slice(),
            imports,
            props: HashMap::new(),
            props_ident: None,
            rest: None,
            named_props: Vec::new(),
            rest_escape: std::cell::Cell::new(None),
            use_before_pattern: std::cell::Cell::new(None),
            prop_read_problem: std::cell::RefCell::new(None),
            absorbed: HashSet::new(),
            forwarded_ref: None,
            forwarded_ref_dropped: std::cell::RefCell::new(HashSet::new()),
            member_aliases: HashMap::new(),
            cond_consts: HashMap::new(),
            module_inits: HashMap::new(),
            poly: HashMap::new(),
            state: HashSet::new(),
            snapshot_refs: HashSet::new(),
            snapshot_escape: std::cell::Cell::new(None),
            setters: HashSet::new(),
            loop_bindings: HashSet::new(),
            stores: HashMap::new(),
            jsx_runtime: HashSet::new(),
            aliases: HashMap::new(),
            printed: HashMap::new(),
            contexts: Default::default(),
            ctx_locals: HashMap::new(),
            ctx_fields: std::cell::RefCell::new(Vec::new()),
            ctx_escape: std::cell::Cell::new(None),
        };
        table.contexts = crate::analyze::context::scan(&table, ast);
        table.jsx_runtime = table.collect_jsx_runtime(ast);
        table.member_aliases = table.collect_member_aliases(ast);
        for part in ast.parts.iter() {
            table.add_cond_consts(part.stmts.slice());
        }
        table.collect_module_inits(ast);
        table.collect_react_hook_aliases(ast);
        table
    }

    /// R34.105: a module-level `const useX = React[' useX '.trim().toString()] || other` (Radix spells the name so a
    /// bundler cannot read it) or `const useX = React.useX` is React's own `useX` when the key folds to a constant
    /// string that names a hook React 19 exports: React's exported hooks are functions, so `hook || other` is the
    /// hook. Recorded as an import of `react`, so every reader of a hook call sees React's hook, by symbol.
    fn collect_react_hook_aliases(&mut self, ast: &js_ast::Ast<'_>) {
        let mut found = Vec::new();
        for part in ast.parts.iter() {
            for stmt in part.stmts.slice() {
                let js_ast::stmt::Data::SLocal(l) = &stmt.data else {
                    continue;
                };
                if !matches!(l.kind, js_ast::S::Kind::KConst) {
                    continue;
                }
                for d in l.decls.iter() {
                    if let (B::BIdentifier(id), Some(v)) = (d.binding.data, d.value)
                        && let Some(hook) = self.react_member_hook(&v)
                    {
                        found.push((id.r#ref, hook));
                    }
                }
            }
        }
        for (r, hook) in found {
            let k = self.key(r);
            self.imports.insert(k, ("react".into(), hook.into()));
        }
    }

    /// The React hook `e` reads off the React namespace by a constant key (`hook || other` is `hook`).
    fn react_member_hook(&self, e: &js_ast::Expr) -> Option<&'static str> {
        let on_react = |t: &js_ast::Expr| {
            ident_ref(t).is_some_and(|r| {
                matches!(self.imports.get(&self.key(r)),
                    Some((s, n)) if s == "react" && (n == "*" || n == "default"))
            })
        };
        let key = match &e.data {
            E::EBinary(b) if matches!(b.op, js_ast::OpCode::BinLogicalOr) => {
                return self.react_member_hook(&b.left);
            }
            E::EDot(d) if on_react(&d.target) => {
                String::from_utf8_lossy(d.name.slice()).into_owned()
            }
            E::EIndex(i) if on_react(&i.target) => const_string(&i.index)?,
            _ => return None,
        };
        REACT_HOOKS.iter().find(|h| **h == key).copied()
    }

    /// The module-level `const`s whose initialiser has a literal shape (see `module_inits`).
    fn collect_module_inits(&mut self, ast: &js_ast::Ast<'_>) {
        let mut found = Vec::new();
        for part in ast.parts.iter() {
            for stmt in part.stmts.slice() {
                let js_ast::stmt::Data::SLocal(l) = &stmt.data else {
                    continue;
                };
                if !matches!(l.kind, js_ast::S::Kind::KConst) {
                    continue;
                }
                for d in l.decls.iter() {
                    if let (B::BIdentifier(id), Some(v)) = (d.binding.data, d.value)
                        && literal_shape(&v, 0)
                    {
                        found.push((id.r#ref, v));
                    }
                }
            }
        }
        if found.is_empty() {
            return;
        }
        let bad = crate::analyze::use_scan::unsafe_to_fold(ast, self);
        for (r, v) in found {
            if !bad.contains(&self.key(r)) {
                let name = self.name(r);
                self.module_inits.insert(name, v);
            }
        }
    }

    /// See `module_inits`.
    pub fn module_inits(&self) -> &HashMap<String, js_ast::Expr> {
        &self.module_inits
    }

    /// Records the `const x = <conditional>` statements of `stmts` (a module's or a component body's).
    pub fn add_cond_consts(&mut self, stmts: &[js_ast::Stmt]) {
        for stmt in stmts {
            let js_ast::stmt::Data::SLocal(l) = &stmt.data else {
                continue;
            };
            if !matches!(l.kind, js_ast::S::Kind::KConst) {
                continue;
            }
            for d in l.decls.iter() {
                if let (B::BIdentifier(id), Some(v)) = (d.binding.data, d.value)
                    && matches!(v.data, js_ast::expr::Data::EIf(_))
                {
                    let k = self.key(id.r#ref);
                    self.cond_consts.insert(k, v);
                }
            }
        }
    }

    /// The conditional a `const` was initialised with (see `cond_consts`).
    pub fn cond_const(&self, r: js_ast::Ref) -> Option<js_ast::Expr> {
        self.cond_consts.get(&self.key(r)).copied()
    }

    fn collect_member_aliases(&self, ast: &js_ast::Ast<'_>) -> HashMap<u32, MemberRef> {
        let mut out = HashMap::new();
        for part in ast.parts.iter() {
            for stmt in part.stmts.slice() {
                let js_ast::stmt::Data::SLocal(l) = &stmt.data else {
                    continue;
                };
                // A `let`/`var` may be reassigned: only `const` is an alias.
                if !matches!(l.kind, js_ast::S::Kind::KConst) {
                    continue;
                }
                for d in l.decls.iter() {
                    if let (B::BIdentifier(id), Some(v)) = (d.binding.data, d.value)
                        && let Some(m) = member_of(&v, |r| {
                            self.import_of(r)
                                .map(|(s, i)| (s.to_string(), i.to_string()))
                        })
                    {
                        out.insert(self.key(id.r#ref), m);
                    }
                }
            }
        }
        out
    }

    /// Declares `r` (the second parameter) the forwarded ref of a `forwardRef` component.
    pub fn set_forwarded_ref(&mut self, r: js_ast::Ref) {
        self.forwarded_ref = Some(self.key(r));
    }

    pub fn is_forwarded_ref(&self, r: js_ast::Ref) -> bool {
        self.forwarded_ref.is_some() && self.forwarded_ref == Some(self.key(r))
    }

    /// `ref={ref}` on a host element was dropped (the one allowed read of the forwarded ref), at `loc`.
    pub fn note_forwarded_ref_dropped(&self, loc: i32) {
        self.forwarded_ref_dropped.borrow_mut().insert(loc);
    }

    /// Reads of the forwarded ref among `used` (identifier, location) that were not dropped as `ref={ref}`
    /// (R34.64: fail closed). Judged by location: two reads cannot cancel each other out.
    pub fn forwarded_ref_escapes(&self, used: &[(js_ast::Ref, i32)]) -> usize {
        let Some(k) = self.forwarded_ref else {
            return 0;
        };
        let dropped = self.forwarded_ref_dropped.borrow();
        used.iter()
            .filter(|(r, at)| self.key(*r) == k && !dropped.contains(at))
            .count()
    }

    /// `r` is a module-level `const` that aliases a member of a package import.
    pub fn member_alias_of(&self, r: js_ast::Ref) -> Option<&MemberRef> {
        self.member_aliases.get(&self.key(r))
    }

    fn collect_jsx_runtime(&self, ast: &js_ast::Ast<'_>) -> HashSet<u32> {
        use js_ast::expr::Data as E;
        let mut w = crate::analyze::expr::Walk::default();
        for part in ast.parts.iter() {
            for stmt in part.stmts.slice() {
                match &stmt.data {
                    js_ast::stmt::Data::SExportDefault(ed) => match &ed.value {
                        js_ast::StmtOrExpr::Stmt(s) => w.stmt(s),
                        js_ast::StmtOrExpr::Expr(e) => w.expr(e),
                    },
                    _ => w.stmt(stmt),
                }
            }
        }
        let ref_of = |e: &js_ast::Expr| match &e.data {
            E::EIdentifier(id) => Some(id.ref_),
            E::EImportIdentifier(id) => Some(id.ref_),
            _ => None,
        };
        let mut out = HashSet::new();
        for c in &w.calls {
            let E::ECall(call) = &c.data else { continue };
            if !call.was_jsx_element {
                continue;
            }
            if let Some(r) = ref_of(&call.target) {
                out.insert(self.key(r));
            }
            // The generated `Fragment` tag (a user component tag is not Other).
            if let Some(r) = call.args.first().and_then(ref_of) {
                let k = self.key(r);
                if !self.imports.contains_key(&k)
                    && self
                        .symbols
                        .get(k as usize)
                        .is_some_and(|s| s.kind == js_ast::symbol::Kind::Other)
                {
                    out.insert(k);
                }
            }
        }
        out
    }

    /// [`Self::key`] for the context scan.
    pub fn key_of(&self, r: js_ast::Ref) -> u32 {
        self.key(r)
    }

    /// The name as written in the source (no alias).
    pub fn local_name(&self, r: js_ast::Ref) -> String {
        self.symbols
            .get(self.key(r) as usize)
            .map(|s| String::from_utf8_lossy(s.original_name.slice()).into_owned())
            .unwrap_or_default()
    }

    /// `target` is the identifier imported as `name` from `source` (`createContextScope(…)`).
    pub fn is_import_call(&self, target: &js_ast::Expr, source: &str, name: &str) -> bool {
        let Some(r) = ident_ref(target) else {
            return false;
        };
        matches!(self.imports.get(&self.key(r)), Some((s, n)) if s == source && n == name)
    }

    /// `createContext(…)` or `React.createContext(…)`: React's own, by import (never by spelling alone).
    pub fn is_react_call(&self, target: &js_ast::Expr, name: &str) -> bool {
        match &target.data {
            E::EIdentifier(_) | E::EImportIdentifier(_) => ident_ref(target).is_some_and(|r| {
                matches!(self.imports.get(&self.key(r)), Some((s, n)) if s == "react" && n == name)
            }),
            E::EDot(d) if d.name.slice() == name.as_bytes() => ident_ref(&d.target).is_some_and(|r| {
                matches!(
                    self.imports.get(&self.key(r)),
                    Some((s, n)) if s == "react" && (n == "*" || n == "default")
                )
            }),
            _ => false,
        }
    }

    /// The context a Provider tag (`<XProvider>` or `<C.Provider>`) belongs to, or the context object `C` itself.
    pub fn context_of_provider(&self, r: js_ast::Ref) -> Option<&str> {
        self.contexts
            .providers
            .get(&self.key(r))
            .map(String::as_str)
    }

    /// The context a Radix hook (`useXContext`) reads.
    pub fn context_of_hook(&self, r: js_ast::Ref) -> Option<&str> {
        self.contexts.hooks.get(&self.key(r)).map(String::as_str)
    }

    /// The React context object `C` of `createContext`.
    pub fn react_context(&self, r: js_ast::Ref) -> Option<&str> {
        self.contexts.react.get(&self.key(r)).map(String::as_str)
    }

    /// F2 (Mellow): a context is identified by the module that declares it AND its local name, never the name alone
    /// (`Ctx` recurs across modules and packages). The tag is a hash of the module path only (no package-controlled
    /// text in it), appended to every context name of this module, so `__ctx_<name>_<tag>_<field>` cannot collide.
    pub fn tag_contexts(&mut self, module_path: &str) {
        let mut h: u32 = 0x811c9dc5;
        for b in module_path.bytes() {
            h ^= u32::from(b);
            h = h.wrapping_mul(0x0100_0193);
        }
        let tag = format!("m{h:08x}");
        for m in [
            &mut self.contexts.providers,
            &mut self.contexts.hooks,
            &mut self.contexts.react,
        ] {
            for v in m.values_mut() {
                *v = format!("{v}_{tag}");
            }
        }
    }

    /// A destructured context field (`const { value } = useXContext(…)`): the local reads the hidden prop.
    pub fn bind_prop_local(&mut self, r: js_ast::Ref, prop: &str) {
        let k = self.key(r);
        self.props.insert(k, prop.to_string());
    }

    /// `const context = useXContext(…)`: reads of `context.field` are the hidden prop of that field.
    pub fn bind_ctx_local(&mut self, r: js_ast::Ref, context: &str) {
        let k = self.key(r);
        self.ctx_locals.insert(k, context.to_string());
    }

    /// The context a local is bound to.
    pub fn ctx_local(&self, r: js_ast::Ref) -> Option<&str> {
        self.ctx_locals.get(&self.key(r)).map(String::as_str)
    }

    /// A `context.field` read: remembered so the component declares the hidden prop.
    pub fn note_ctx_field(&self, context: &str, field: &str) {
        let mut f = self.ctx_fields.borrow_mut();
        if !f.iter().any(|(c, n)| c == context && n == field) {
            f.push((context.to_string(), field.to_string()));
        }
    }

    /// The fields read, grouped by context (first-use order).
    pub fn ctx_uses(&self) -> Vec<crate::ir::CtxUse> {
        let mut out: Vec<crate::ir::CtxUse> = Vec::new();
        for (c, n) in self.ctx_fields.borrow().iter() {
            match out.iter_mut().find(|u| &u.context == c) {
                Some(u) => u.fields.push(n.clone()),
                None => out.push(crate::ir::CtxUse {
                    context: c.clone(),
                    fields: vec![n.clone()],
                }),
            }
        }
        out
    }

    /// Symbol index of `r` after following links (merged declarations).
    fn key(&self, r: js_ast::Ref) -> u32 {
        let mut idx = r.inner_index();
        for _ in 0..64 {
            let Some(sym) = self.symbols.get(idx as usize) else {
                break;
            };
            if !sym.has_link() {
                break;
            }
            let next = sym.link.get();
            if next.source_index() != r.source_index() {
                break;
            }
            idx = next.inner_index();
        }
        idx
    }

    pub fn name(&self, r: js_ast::Ref) -> String {
        if let Some(a) = self.aliases.get(&self.key(r)) {
            return a.print.clone();
        }
        self.symbols
            .get(self.key(r) as usize)
            .map(|s| String::from_utf8_lossy(s.original_name.slice()).into_owned())
            .unwrap_or_default()
    }

    pub fn kind_of(&self, r: js_ast::Ref) -> (String, IdentKind) {
        let k = self.key(r);
        if let Some((name, kind)) = self.aliases.get(&k).and_then(|a| a.kind.clone()) {
            return (name, kind);
        }
        if let Some(prop) = self.props.get(&k) {
            return (prop.clone(), IdentKind::Prop);
        }
        // The whole (non-destructured) props object: the root `*` (F20). A capture of the rest
        // object reads it too (a superset: the deps cover every prop); code that is printed as
        // written never sees it (the reader falls back first, `Reader::rest_escapes`).
        if self.props_ident == Some(k) || self.rest == Some(k) {
            return ("*".into(), IdentKind::Prop);
        }
        let name = self.name(r);
        let kind = if self.state.contains(&k) {
            IdentKind::State
        } else if self.setters.contains(&k) {
            IdentKind::Setter
        } else if let Some((handle, key)) = self.stores.get(&k) {
            IdentKind::Store {
                handle: handle.clone(),
                key: key.clone(),
            }
        } else if self.loop_bindings.contains(&k) {
            IdentKind::LoopBinding
        } else if let Some((source, imported)) = self.imports.get(&k) {
            IdentKind::Import {
                source: source.clone(),
                imported: imported.clone(),
            }
        } else {
            match self.symbols.get(k as usize).map(|s| s.kind) {
                Some(js_ast::symbol::Kind::Unbound) => IdentKind::Global,
                Some(_) => IdentKind::Local,
                None => IdentKind::Unknown,
            }
        };
        (name, kind)
    }

    /// `r` is the non-destructured props parameter, so `r.x` reads prop `x`.
    pub fn is_props_ident(&self, r: js_ast::Ref) -> bool {
        self.props_ident == Some(self.key(r))
    }

    /// `r` is the `...rest` binding of the props pattern.
    pub fn is_rest(&self, r: js_ast::Ref) -> bool {
        self.rest.is_some() && self.rest == Some(self.key(r))
    }

    /// The keys the props pattern names (what `...rest` leaves out).
    pub fn named_props(&self) -> &[String] {
        &self.named_props
    }

    /// Import binding of `r`, if any: (module path, imported name).
    pub fn import_of(&self, r: js_ast::Ref) -> Option<(&str, &str)> {
        self.imports
            .get(&self.key(r))
            .map(|(s, i)| (s.as_str(), i.as_str()))
    }

    /// `r` is the polymorphic tag local of the component (R34.28).
    pub fn set_poly(&mut self, r: js_ast::Ref, tag: PolyTag) {
        let k = self.key(r);
        self.poly.insert(k, tag);
    }

    /// The polymorphic tag `r` names, if it is the component's `Comp`.
    pub fn poly_of(&self, r: js_ast::Ref) -> Option<&PolyTag> {
        self.poly.get(&self.key(r))
    }

    pub fn mark_state(&mut self, r: js_ast::Ref) {
        let k = self.key(r);
        self.state.insert(k);
    }

    pub fn mark_snapshot_ref(&mut self, r: js_ast::Ref) {
        let k = self.key(r);
        self.snapshot_refs.insert(k);
        self.state.insert(k);
    }

    pub fn is_snapshot_ref(&self, r: js_ast::Ref) -> bool {
        self.snapshot_refs.contains(&self.key(r))
    }

    pub fn mark_setter(&mut self, r: js_ast::Ref) {
        let k = self.key(r);
        self.setters.insert(k);
    }

    /// `r` is bound by `useStore(handle)`: the view (`key == None`) or one destructured key.
    pub fn mark_store(&mut self, r: js_ast::Ref, handle: String, key: Option<String>) {
        let k = self.key(r);
        self.stores.insert(k, (handle, key));
    }

    /// The handle of the store view `r` (`s` of `const s = useStore(h)`), if it is one.
    pub fn store_view(&self, r: js_ast::Ref) -> Option<&str> {
        let k = self.key(r);
        if let Some(Alias {
            kind: Some((_, IdentKind::Store { handle, key: None })),
            ..
        }) = self.aliases.get(&k)
        {
            return Some(handle.as_str());
        }
        match self.stores.get(&k) {
            Some((handle, None)) => Some(handle.as_str()),
            _ => None,
        }
    }

    pub fn mark_loop_binding(&mut self, r: js_ast::Ref) {
        let k = self.key(r);
        self.loop_bindings.insert(k);
    }

    pub fn unmark_loop_binding(&mut self, r: js_ast::Ref) {
        let k = self.key(r);
        self.loop_bindings.remove(&k);
    }

    /// `r` names the JSX `Fragment`: the parser's generated runtime binding, or
    /// `Fragment` imported from `react` by the author.
    pub fn is_fragment(&self, r: js_ast::Ref) -> bool {
        if let Some((source, imported)) = self.import_of(r) {
            return imported == "Fragment" && source.starts_with("react");
        }
        let k = self.key(r);
        self.jsx_runtime.contains(&k)
            && self
                .symbols
                .get(k as usize)
                .is_some_and(|s| s.original_name.slice().starts_with(b"Fragment"))
    }

    /// `r` is a binding the parser generated for the JSX runtime (`jsx_*`,
    /// `jsxs_*`, `Fragment_*`): never a capture or a dependency.
    pub fn is_jsx_runtime(&self, r: js_ast::Ref) -> bool {
        self.jsx_runtime.contains(&self.key(r))
    }

    /// Renames `r` (G3): it prints as `alias.print`, and reads as `alias.kind` when set.
    pub fn set_alias(&mut self, r: js_ast::Ref, alias: Alias) {
        let k = self.key(r);
        self.printed.insert(k, alias.print.clone());
        self.aliases.insert(k, alias);
    }

    /// The renamed symbols as the printer needs them.
    pub fn print_aliases(&self) -> &Aliases {
        &self.printed
    }

    /// Every symbol name the module declares or references, as spelled in the source.
    pub fn spellings(&self) -> impl Iterator<Item = String> + '_ {
        self.symbols
            .iter()
            .map(|s| String::from_utf8_lossy(s.original_name.slice()).into_owned())
    }

    /// Whether any symbol of the module, or a name a symbol prints as (G3), is spelled `name`: a
    /// generated name must not be one (F147).
    pub fn spells(&self, name: &str) -> bool {
        self.printed.values().any(|p| p == name)
            || self
                .symbols
                .iter()
                .any(|s| s.original_name.slice() == name.as_bytes())
    }

    /// Every name the module itself declares (imports, module and nested bindings), as spelled:
    /// the module's symbols except the unbound ones (globals).
    pub fn declared_spellings(&self) -> impl Iterator<Item = String> + '_ {
        self.symbols
            .iter()
            .filter(|s| s.kind != js_ast::symbol::Kind::Unbound)
            .map(|s| String::from_utf8_lossy(s.original_name.slice()).into_owned())
    }

    /// Same symbol, links followed.
    pub fn same(&self, a: js_ast::Ref, b: js_ast::Ref) -> bool {
        a.source_index() == b.source_index() && self.key(a) == self.key(b)
    }
}

/// Every identifier a binding pattern declares, in source order.
pub fn binding_refs(b: &js_ast::Binding, out: &mut Vec<js_ast::Ref>) {
    match b.data {
        B::BIdentifier(id) => out.push(id.r#ref),
        B::BArray(arr) => {
            for item in arr.items() {
                binding_refs(&item.binding, out);
            }
        }
        B::BObject(obj) => {
            for p in obj.properties() {
                binding_refs(&p.value, out);
            }
        }
        B::BMissing(_) => {}
    }
}

/// The symbol an identifier expression names (an import binding included).
pub fn ident_ref(e: &js_ast::Expr) -> Option<js_ast::Ref> {
    match &e.data {
        E::EIdentifier(id) => Some(id.ref_),
        E::EImportIdentifier(id) => Some(id.ref_),
        _ => None,
    }
}

/// An initialiser built of literals, plain-keyed object and array literals, other names and member reads: what
/// the folder can read (it checks every name itself, so this only keeps calls and functions out of the map).
fn literal_shape(e: &js_ast::Expr, depth: u32) -> bool {
    use js_ast::expr::Data as E;
    if depth > 8 {
        return false;
    }
    match &e.data {
        E::ENumber(_) | E::EString(_) | E::EBoolean(_) | E::ENull(_) | E::EUndefined(_) => true,
        E::EIdentifier(_) => true,
        E::EDot(d) => literal_shape(&d.target, depth + 1),
        E::EArray(a) => a.items.iter().all(|i| literal_shape(i, depth + 1)),
        E::EObject(o) => o.properties.iter().all(|p| {
            !p.flags.contains(js_ast::flags::Property::IsSpread)
                && p.key
                    .as_ref()
                    .is_some_and(|k| matches!(&k.data, E::EString(_)))
                && p.value
                    .as_ref()
                    .is_some_and(|v| literal_shape(v, depth + 1))
        }),
        _ => false,
    }
}

/// Why a prop named `name` cannot be a plain template variable, as `(code, what)`; `None` = it can. A key that is not
/// an identifier prints as an expression (`data-x` reads as a subtraction); a jinja keyword is a syntax error or the
/// wrong value; `loop`, `range`, `namespace`, `caller` and `self` are names the template itself binds or calls (a loop
/// variable, `Array.from` lowers to `range(...)`), so a prop of that name would shadow them.
pub fn template_name_problem(name: &str) -> Option<(&'static str, &'static str)> {
    const KEYWORDS: &[&str] = &[
        "true", "false", "none", "True", "False", "None", "and", "or", "not", "in", "is", "if",
        "else",
    ];
    const TEMPLATE_OWN: &[&str] = &["loop", "range", "namespace", "caller", "self"];
    if name.starts_with("__ctx_") {
        return Some((
            "context-shape",
            "uses the `__ctx_` prefix, which brust reserves for context values",
        ));
    }
    let mut cs = name.chars();
    let ident = cs
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && cs.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !ident {
        Some((
            "prop-quoted-key",
            "is not a plain identifier, so it cannot name a template variable",
        ))
    } else if KEYWORDS.contains(&name) {
        Some((
            "prop-jinja-name",
            "is a keyword of the server template language, so it cannot name a template variable",
        ))
    } else if TEMPLATE_OWN.contains(&name) {
        Some((
            "prop-jinja-name",
            "is a name the server template uses itself (a loop variable or a built-in), so a prop of that name would shadow it",
        ))
    } else {
        None
    }
}
