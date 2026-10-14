//! Radix `Primitive` (shadcn S3 step 1, F153c, R34.65): `@radix-ui/react-primitive` builds its components with a
//! factory, `NODES.reduce((primitive, node) => { …forwardRef(… asChild ? Slot : node …) … }, {})`, which no general
//! reading of a component sees through. The compiler recognises that factory by its STRUCTURE (lead ruling Q1: no
//! version pin, no general factory evaluator): the declaration, printed as JavaScript (types gone), must equal the
//! known shape token for token, local names aside. `Primitive.<tag>` is then the host element `<tag>`, with `asChild`
//! resolved at the call site exactly as `Button`'s (R34.28). Any other shape is not recognised: the importer keeps
//! its React island.
//!
//! What the recognised component drops (documented in `docs/shadcn.md`, ruling Q2): the write-only marker
//! `window[Symbol.for('radix-ui')] = true`, which nothing in the installed tree reads.
use crate::analyze::component::AnalyzeOptions;
use crate::analyze::expr::{Js, print_js};
use bun_ast as js_ast;
use js_ast::b::B;
use js_ast::expr::Data as E;
use js_ast::stmt::Data as S;

/// The factory as `@radix-ui/react-primitive` 2.x declares it, printed by the compiler's printer. `$n` marks a
/// local name (bound consistently on first use); everything else must match exactly.
const SHAPE: &str = include_str!("primitive.shape.js");

/// The tags a recognised factory makes (`NODES`), when `export` of the module at `path` is one.
pub fn primitive_nodes(path: &str, export: &str, opts: &AnalyzeOptions) -> Option<Vec<String>> {
    let bytes = std::fs::read(opts.root.join(path)).ok()?;
    let parsed = crate::parse::parse_tsx(path, bytes).ok()?;
    parsed.with_ast(|ast| {
        let local = exported_local(ast, export)?;
        let mut nodes_name = None;
        let mut decl_stmt = None;
        let mut consts: Vec<(String, &js_ast::Stmt)> = Vec::new();
        for part in ast.parts.iter() {
            for stmt in part.stmts.slice() {
                let S::SLocal(l) = &stmt.data else { continue };
                if !matches!(l.kind, js_ast::S::Kind::KConst) {
                    continue;
                }
                for d in l.decls.iter() {
                    let B::BIdentifier(id) = d.binding.data else {
                        continue;
                    };
                    let name = symbol_name(ast, id.r#ref);
                    if name == local {
                        decl_stmt = Some(stmt);
                        nodes_name = d.value.and_then(|v| reduce_target(ast, &v));
                    }
                    consts.push((name, stmt));
                }
            }
        }
        let nodes_name = nodes_name?;
        // The names the shape spells are the factory's own imports: `React` (react) and `createSlot`
        // (@radix-ui/react-slot); a module that declares its own is not the factory.
        let imports = crate::analyze::names::module_imports(ast);
        let imported = |local: &str, source: &str, name: &str| {
            imports.iter().any(|(idx, (s, i))| {
                s == source
                    && i == name
                    && ast
                        .symbols
                        .get(*idx as usize)
                        .is_some_and(|sym| sym.original_name.slice() == local.as_bytes())
            })
        };
        if !imported("React", "react", "*")
            || !imported("createSlot", "@radix-ui/react-slot", "createSlot")
        {
            return None;
        }
        let printed = print_js(&parsed, ast, Js::Stmt(decl_stmt?));
        if !matches_shape(&printed, SHAPE) {
            if std::env::var_os("BRUST_DEBUG_PRIMITIVE").is_some() {
                eprintln!("[primitive] {path}#{export} not recognised:\n{printed}");
            }
            return None;
        }
        let (_, nodes_stmt) = consts.iter().find(|(n, _)| *n == nodes_name)?;
        string_array(nodes_stmt)
    })
}

/// The local name `export` is declared under: `export const X`, or `export { X as export }`.
fn exported_local(ast: &js_ast::Ast<'_>, export: &str) -> Option<String> {
    for part in ast.parts.iter() {
        for stmt in part.stmts.slice() {
            match &stmt.data {
                S::SLocal(l) if l.is_export => {
                    for d in l.decls.iter() {
                        if let B::BIdentifier(id) = d.binding.data
                            && symbol_name(ast, id.r#ref) == export
                        {
                            return Some(export.to_string());
                        }
                    }
                }
                S::SExportClause(c) => {
                    for item in c.items.slice() {
                        if item.alias.slice() == export.as_bytes() {
                            return Some(symbol_name(ast, item.name.ref_));
                        }
                    }
                }
                _ => {}
            }
        }
    }
    None
}

fn symbol_name(ast: &js_ast::Ast<'_>, r: js_ast::Ref) -> String {
    crate::analyze::stores::Module::new(ast).name(r)
}

/// `NAME.reduce(…)`: the name of the array the factory reduces.
fn reduce_target(ast: &js_ast::Ast<'_>, v: &js_ast::Expr) -> Option<String> {
    let E::ECall(call) = &v.data else { return None };
    let E::EDot(dot) = &call.target.data else {
        return None;
    };
    if dot.name.slice() != b"reduce" {
        return None;
    }
    match &dot.target.data {
        E::EIdentifier(id) => Some(symbol_name(ast, id.ref_)),
        _ => None,
    }
}

/// `const NODES = ['a', 'button', …]` (an `as const` is gone from the AST): the strings, all valid tag names.
fn string_array(stmt: &js_ast::Stmt) -> Option<Vec<String>> {
    let S::SLocal(l) = &stmt.data else {
        return None;
    };
    let d = l.decls.first()?;
    let E::EArray(arr) = &d.value?.data else {
        return None;
    };
    let mut out = Vec::new();
    for item in arr.items.iter() {
        let E::EString(s) = &item.data else {
            return None;
        };
        let tag = crate::analyze::expr::estring(s);
        if tag.is_empty()
            || !tag
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        {
            return None;
        }
        out.push(tag);
    }
    (!out.is_empty()).then_some(out)
}

/// Splits printed JS into tokens: identifiers, string/template literals, numbers, punctuation (whitespace and
/// comments dropped).
fn tokens(js: &str) -> Vec<String> {
    let b = js.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_whitespace() {
            i += 1;
        } else if c == b'/' && b.get(i + 1) == Some(&b'/') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
        } else if c == b'/' && b.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
        } else if c == b'"' || c == b'\'' || c == b'`' {
            let start = i;
            i += 1;
            while i < b.len() && b[i] != c {
                if b[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i += 1;
            out.push(js[start..i.min(b.len())].to_string());
        } else if c.is_ascii_alphanumeric() || c == b'_' || c == b'$' {
            let start = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'$') {
                i += 1;
            }
            out.push(js[start..i].to_string());
        } else {
            out.push((c as char).to_string());
            i += 1;
        }
    }
    out
}

/// Whether `printed` is `shape` with each `$name` of the shape bound to one local name (consistently, and no two
/// `$`-names to the same local).
fn matches_shape(printed: &str, shape: &str) -> bool {
    let (p, s) = (tokens(printed), tokens(shape));
    if p.len() != s.len() {
        return false;
    }
    let mut bound: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    let mut taken: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for (pt, st) in p.iter().zip(s.iter()) {
        if let Some(var) = st.strip_prefix('$').filter(|v| !v.is_empty()) {
            let ident = pt
                .bytes()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_' || c == b'$');
            if !ident {
                return false;
            }
            match bound.get(var) {
                Some(b) if *b == pt.as_str() => {}
                Some(_) => return false,
                None => {
                    if !taken.insert(pt.as_str()) {
                        return false;
                    }
                    bound.insert(var, pt.as_str());
                }
            }
        } else if st.starts_with('`') {
            // A template's `${$name}` holes read names bound earlier in the shape.
            let mut want = st.clone();
            for (var, b) in &bound {
                want = want.replace(&format!("${{${var}}}"), &format!("${{{b}}}"));
            }
            if *pt != want {
                return false;
            }
        } else if pt != st {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::{matches_shape, tokens};

    #[test]
    fn shape_binds_locals_consistently() {
        assert!(matches_shape(
            "const a = b.reduce(c)",
            "const $x = $y.reduce($z)"
        ));
        assert!(!matches_shape(
            "const a = a.reduce(c)",
            "const $x = $y.reduce($z)"
        ));
        assert!(!matches_shape(
            "const a = b.map(c)",
            "const $x = $y.reduce($z)"
        ));
        assert!(!matches_shape(
            "const a = b.reduce(c, d)",
            "const $x = $y.reduce($z)"
        ));
        assert_eq!(tokens("x /* c */ = `a${b}`"), vec!["x", "=", "`a${b}`"]);
        assert!(matches_shape("f(n => `P.${n}`)", "f($n => `P.${$n}`)"));
        assert!(!matches_shape("f(n => `P.${m}`)", "f($n => `P.${$n}`)"));
    }
}
