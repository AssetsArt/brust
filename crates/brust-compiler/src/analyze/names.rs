//! What each identifier in a component refers to, decided from Bun's symbol
//! table and import records, never from the spelling (plan Review Focus 4).
use crate::ir::IdentKind;
use bun_ast as js_ast;
use js_ast::b::B;
use std::collections::{HashMap, HashSet};

/// Symbol-indexed facts about one component. Keys are `Ref::inner_index` of the
/// symbol after following links.
pub struct NameTable<'a> {
    symbols: &'a [js_ast::Symbol],
    /// Local import binding → (module path, imported name; `default` or `*` for
    /// default and namespace imports).
    imports: HashMap<u32, (String, String)>,
    props: HashSet<u32>,
    /// The component's parameter when it is not destructured (`props`).
    props_ident: Option<u32>,
    state: HashSet<u32>,
    setters: HashSet<u32>,
    loop_bindings: HashSet<u32>,
}

impl<'a> NameTable<'a> {
    pub fn new(ast: &'a js_ast::Ast<'_>, component: &js_ast::G::Fn) -> Self {
        let records = ast.import_records.as_slice();
        let path_of = |i: u32| {
            records
                .get(i as usize)
                .map(|r| String::from_utf8_lossy(r.path.text).into_owned())
        };
        // `import` statements are the source of truth: `ast.named_imports` is a
        // bundler table and leaves out default and namespace imports.
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
        let mut table = NameTable {
            symbols: ast.symbols.as_slice(),
            imports,
            props: HashSet::new(),
            props_ident: None,
            state: HashSet::new(),
            setters: HashSet::new(),
            loop_bindings: HashSet::new(),
        };
        if let Some(arg) = component.args.slice().first() {
            match arg.binding.data {
                B::BIdentifier(id) => table.props_ident = Some(table.key(id.r#ref)),
                B::BObject(_) => {
                    let mut refs = Vec::new();
                    binding_refs(&arg.binding, &mut refs);
                    for r in refs {
                        let k = table.key(r);
                        table.props.insert(k);
                    }
                }
                B::BArray(_) | B::BMissing(_) => {}
            }
        }
        table
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
        self.symbols
            .get(self.key(r) as usize)
            .map(|s| String::from_utf8_lossy(s.original_name.slice()).into_owned())
            .unwrap_or_default()
    }

    pub fn kind_of(&self, r: js_ast::Ref) -> (String, IdentKind) {
        let name = self.name(r);
        let k = self.key(r);
        let kind = if self.props.contains(&k) {
            IdentKind::Prop
        } else if self.state.contains(&k) {
            IdentKind::State
        } else if self.setters.contains(&k) {
            IdentKind::Setter
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

    /// Import binding of `r`, if any: (module path, imported name).
    pub fn import_of(&self, r: js_ast::Ref) -> Option<(&str, &str)> {
        self.imports
            .get(&self.key(r))
            .map(|(s, i)| (s.as_str(), i.as_str()))
    }

    pub fn mark_state(&mut self, r: js_ast::Ref) {
        let k = self.key(r);
        self.state.insert(k);
    }

    pub fn mark_setter(&mut self, r: js_ast::Ref) {
        let k = self.key(r);
        self.setters.insert(k);
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
        self.symbols.get(self.key(r) as usize).is_some_and(|s| {
            s.kind == js_ast::symbol::Kind::Other
                && s.original_name.slice().starts_with(b"Fragment")
        })
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
