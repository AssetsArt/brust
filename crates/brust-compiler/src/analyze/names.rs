//! What each identifier in a component refers to, decided from Bun's symbol
//! table and import records, never from the spelling (plan Review Focus 4).
use crate::ir::{IdentKind, PolyTag};
use bun_ast as js_ast;
use js_ast::b::B;
use std::collections::{HashMap, HashSet};

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
    /// The component's polymorphic tag local (`Comp` of `const Comp = asChild ? Slot.Root : "a"`, R34.28).
    poly: HashMap<u32, PolyTag>,
    state: HashSet<u32>,
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

impl<'a> NameTable<'a> {
    pub fn new(ast: &'a js_ast::Ast<'_>, component: &js_ast::G::Fn) -> Self {
        let mut table = Self::for_hook(ast);
        if let Some(arg) = component.args.slice().first() {
            match arg.binding.data {
                B::BIdentifier(id) => table.props_ident = Some(table.key(id.r#ref)),
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
            poly: HashMap::new(),
            state: HashSet::new(),
            setters: HashSet::new(),
            loop_bindings: HashSet::new(),
            stores: HashMap::new(),
            jsx_runtime: HashSet::new(),
            aliases: HashMap::new(),
            printed: HashMap::new(),
        };
        table.jsx_runtime = table.collect_jsx_runtime(ast);
        table
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
