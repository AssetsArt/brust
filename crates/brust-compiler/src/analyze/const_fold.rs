//! Module `const`s that fold into the template (L1: G5/G9/G10). A value built from literals and
//! other folding consts only is printed into Jinja instead of becoming a precompute slot; the
//! client chunk still reads the const. Anything else keeps today's path (a job), never a guess
//! (R0.1): calls, globals, functions, JSX, `new`, regex, `let`/`var`, destructured consts and
//! package imports.
use crate::analyze::component::AnalyzeOptions;
use crate::analyze::expr::{Js, Reader, print_js};
use crate::analyze::modules::resolve;
use crate::analyze::names::NameTable;
use crate::ir::{BinOp, ConstVal, IdentKind, ModuleDecl, RawExpr, RawKind, ServerExpr, UnOp};
use bun_ast as js_ast;
use js_ast::b::B;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;
use std::collections::HashMap;

/// Deepest chain of module consts one fold follows.
pub const FOLD_DEPTH: usize = 16;
/// A folded value printing to more than this many bytes of Jinja per use stays a slot (R1.3).
pub const FOLD_MAX_JINJA: usize = 8 * 1024;

/// Rebuilds `e` with `f` applied to every identifier; `None` from `f` keeps the identifier.
/// Functions, JSX and opaque code are left untouched.
pub fn map_idents(e: &RawExpr, f: &dyn Fn(&RawExpr) -> Option<RawExpr>) -> RawExpr {
    let b = |x: &RawExpr| Box::new(map_idents(x, f));
    let kind = match &e.kind {
        RawKind::Ident { .. } => return f(e).unwrap_or_else(|| e.clone()),
        RawKind::Member {
            target,
            name,
            optional,
        } => RawKind::Member {
            target: b(target),
            name: name.clone(),
            optional: *optional,
        },
        RawKind::Index { target, index } => RawKind::Index {
            target: b(target),
            index: b(index),
        },
        RawKind::Unary { op, value } => RawKind::Unary {
            op: *op,
            value: b(value),
        },
        RawKind::Binary { op, left, right } => RawKind::Binary {
            op: *op,
            left: b(left),
            right: b(right),
        },
        RawKind::Cond { test, yes, no } => RawKind::Cond {
            test: b(test),
            yes: b(yes),
            no: b(no),
        },
        RawKind::Template { head, parts } => RawKind::Template {
            head: head.clone(),
            parts: parts
                .iter()
                .map(|(p, t)| (map_idents(p, f), t.clone()))
                .collect(),
        },
        RawKind::Call { callee, args } => RawKind::Call {
            callee: b(callee),
            args: args.iter().map(|a| map_idents(a, f)).collect(),
        },
        RawKind::Array(items) => RawKind::Array(items.iter().map(|i| map_idents(i, f)).collect()),
        RawKind::Object(props) => RawKind::Object(
            props
                .iter()
                .map(|(k, v)| (k.clone(), map_idents(v, f)))
                .collect(),
        ),
        RawKind::Lit(_) | RawKind::Arrow { .. } | RawKind::Jsx(_) | RawKind::Opaque { .. } => {
            return e.clone();
        }
    };
    RawExpr { loc: e.loc, kind }
}

/// A value that cannot be an array or an object, so folding it freezes nothing mutable.
pub fn primitive(e: &RawExpr) -> bool {
    match &e.kind {
        RawKind::Lit(_) | RawKind::Template { .. } | RawKind::Unary { .. } => true,
        RawKind::Binary { op, .. } => !matches!(op, BinOp::And | BinOp::Or | BinOp::Nullish),
        _ => false,
    }
}

fn jinja_len(e: &RawExpr) -> usize {
    crate::lower::server_expr::to_jinja(
        &ServerExpr(e.clone()),
        &crate::lower::server_expr::JinjaCtx::plain(),
    )
    .len()
}

/// Reads the folded value of a relatively imported const: `(import source, imported name)`.
pub type ImportedConst<'a> = &'a dyn Fn(&str, &str) -> Option<RawExpr>;

/// What one fold needs to know about the module it runs in.
pub struct Folder<'a> {
    all: HashMap<&'a str, &'a ConstVal>,
    /// Names shadowed by something in a component body.
    excluded: &'a dyn Fn(&str) -> bool,
    imported: ImportedConst<'a>,
    /// Folded value and the length of the const chain behind it.
    done: HashMap<String, Option<(RawExpr, usize)>>,
    path: Vec<String>,
    /// Longest const chain the value being substituted has followed so far.
    chain: usize,
}

impl<'a> Folder<'a> {
    pub fn new(
        decls: &'a [ModuleDecl],
        excluded: &'a dyn Fn(&str) -> bool,
        imported: ImportedConst<'a>,
    ) -> Self {
        Folder {
            all: decls
                .iter()
                .flat_map(|d| d.consts.iter())
                .map(|c| (c.name.as_str(), c))
                .collect(),
            excluded,
            imported,
            done: HashMap::new(),
            path: Vec::new(),
            chain: 0,
        }
    }

    /// Every module const that folds, with its value fully substituted.
    pub fn all(mut self) -> HashMap<String, RawExpr> {
        let mut names: Vec<&str> = self.all.keys().copied().collect();
        names.sort_unstable();
        for n in names {
            self.resolve(n);
        }
        self.done
            .into_iter()
            .filter_map(|(k, v)| v.map(|(v, _)| (k, v)))
            .collect()
    }

    fn resolve(&mut self, name: &str) -> Option<RawExpr> {
        if let Some(v) = self.done.get(name) {
            let (value, depth) = v.as_ref()?;
            self.chain = self.chain.max(*depth);
            return Some(value.clone());
        }
        // A cycle is not cached: it is `None` from every entry point.
        if (self.excluded)(name) || self.path.iter().any(|p| p == name) {
            return None;
        }
        let cv = *self.all.get(name)?;
        self.path.push(name.to_string());
        let outer = std::mem::take(&mut self.chain);
        let value = self.substitute(&cv.value);
        // The chain length is a property of the value, not of where the fold started, so the
        // result never depends on the order consts are resolved in.
        let depth = self.chain + 1;
        self.chain = outer.max(depth);
        self.path.pop();
        let value = value.filter(|v| {
            depth <= FOLD_DEPTH && (!cv.mutated || primitive(v)) && jinja_len(v) <= FOLD_MAX_JINJA
        });
        self.done
            .insert(name.to_string(), value.clone().map(|v| (v, depth)));
        value
    }

    /// `e` with every const identifier replaced by its folded value; `None` when anything in it
    /// is outside the foldable set.
    fn substitute(&mut self, e: &RawExpr) -> Option<RawExpr> {
        let kind = match &e.kind {
            RawKind::Lit(_) => return Some(e.clone()),
            RawKind::Ident {
                name,
                kind: IdentKind::Local,
            } => return self.resolve(name),
            RawKind::Ident {
                name,
                kind: IdentKind::Import { source, imported },
            } => {
                let _ = name;
                return (self.imported)(source, imported);
            }
            RawKind::Member {
                target,
                name,
                optional,
            } => RawKind::Member {
                target: Box::new(self.substitute(target)?),
                name: name.clone(),
                optional: *optional,
            },
            RawKind::Index { target, index } if matches!(index.kind, RawKind::Lit(_)) => {
                RawKind::Index {
                    target: Box::new(self.substitute(target)?),
                    index: index.clone(),
                }
            }
            RawKind::Unary {
                op: op @ (UnOp::Not | UnOp::Neg),
                value,
            } => RawKind::Unary {
                op: *op,
                value: Box::new(self.substitute(value)?),
            },
            RawKind::Binary { op, left, right } => RawKind::Binary {
                op: *op,
                left: Box::new(self.substitute(left)?),
                right: Box::new(self.substitute(right)?),
            },
            RawKind::Cond { test, yes, no } => RawKind::Cond {
                test: Box::new(self.substitute(test)?),
                yes: Box::new(self.substitute(yes)?),
                no: Box::new(self.substitute(no)?),
            },
            RawKind::Template { head, parts } => RawKind::Template {
                head: head.clone(),
                parts: parts
                    .iter()
                    .map(|(p, t)| Some((self.substitute(p)?, t.clone())))
                    .collect::<Option<_>>()?,
            },
            RawKind::Array(items) => RawKind::Array(
                items
                    .iter()
                    .map(|i| self.substitute(i))
                    .collect::<Option<_>>()?,
            ),
            RawKind::Object(props) => RawKind::Object(
                props
                    .iter()
                    .map(|(k, v)| Some((k.clone(), self.substitute(v)?)))
                    .collect::<Option<_>>()?,
            ),
            _ => return None,
        };
        Some(RawExpr { loc: e.loc, kind })
    }
}

/// The folded value of `imported` exported by the module `source` names (relative to `from`),
/// or `None` when it is not a module const that folds. Package imports never fold.
pub fn imported_const(
    from: &str,
    source: &str,
    imported: &str,
    opts: &AnalyzeOptions,
    depth: usize,
) -> Option<RawExpr> {
    if depth >= FOLD_DEPTH {
        return None;
    }
    let path = resolve(from, source, opts)?;
    let bytes = std::fs::read(opts.root.join(&path)).ok()?;
    let parsed = crate::parse::parse_tsx(&path, bytes).ok()?;
    parsed.with_ast(|ast| {
        let dummy = js_ast::G::Fn::default();
        let mut names = NameTable::new(ast, &dummy);
        let print = |js: Js<'_>| print_js(&parsed, ast, js);
        let mut reader = Reader::new(&mut names, &print);
        let (_, decls) = reader.module_scope(ast);
        let local = exported_const_name(ast, imported)?;
        let nested = |src: &str, imp: &str| imported_const(&path, src, imp, opts, depth + 1);
        let none = |_: &str| false;
        let mut folder = Folder::new(&decls, &none, &nested);
        // R1.1b: another importer could mutate an array or object, so only primitives cross.
        folder.resolve(&local).filter(primitive)
    })
}

/// The module-level name `export` refers to: `export const X`, `export { X as Y }` or
/// `export default X`.
fn exported_const_name(ast: &js_ast::Ast<'_>, export: &str) -> Option<String> {
    let sym = |r: js_ast::Ref| {
        ast.symbols
            .as_slice()
            .get(r.inner_index() as usize)
            .map(|s| String::from_utf8_lossy(s.original_name.slice()).into_owned())
    };
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            match &stmt.data {
                S::SLocal(l) if l.is_export => {
                    for d in l.decls.iter() {
                        if let B::BIdentifier(id) = d.binding.data
                            && sym(id.r#ref).as_deref() == Some(export)
                        {
                            return sym(id.r#ref);
                        }
                    }
                }
                S::SExportClause(c) => {
                    for item in c.items.slice() {
                        if item.alias.slice() == export.as_bytes() {
                            return sym(item.name.ref_);
                        }
                    }
                }
                S::SExportDefault(ed) if export == "default" => {
                    if let js_ast::StmtOrExpr::Expr(e) = &ed.value
                        && let E::EIdentifier(id) = &e.data
                    {
                        return sym(id.ref_);
                    }
                }
                _ => {}
            }
        }
    }
    None
}
