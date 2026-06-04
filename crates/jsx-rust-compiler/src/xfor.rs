//! x-for grammar parser (compile-time mirror of the runtime `parseFor`,
//! runtime/native/runtime.ts). Used to decide SSR-vs-client x-for and to build
//! the `{% for %}` seed. Dotted paths only (matches runtime PATH_RE `[\w.]+`).

// Pure helpers not yet wired into lowering (that lands in a later task); mirror
// the module-scoped allow used by `ir.rs` for the same staged-delivery reason.
#![allow(dead_code)]

use crate::ir::Expr;

#[derive(Debug, Clone)]
pub struct ForExpr {
    pub item_name: String,
    pub index_name: Option<String>,
    pub source_name: String,
    pub key_paths: Vec<String>,
}

// ASCII-only, matching the runtime `parseFor`'s `\w`/`PATH_RE` (ECMAScript `\w`
// is `[A-Za-z0-9_]`, NOT Unicode): the Rust parser MUST accept/reject the exact
// same strings as the JS runtime, or SSR emits a `{% for %}` the client then
// rejects (broken hydration). NOTE: ` in `/` by ` use literal single spaces;
// the surrounding `.trim()`s absorb extra spaces, but a TAB separator is a known
// minor divergence from the runtime's `\s`-class regex (authors use spaces).
fn is_path(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.')
}
fn is_ident(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Parse `(item[, index]) in source [by k0, k1, …]`. Returns None on malformed
/// input (caller falls back to opaque passthrough — NEVER hard-errors).
pub fn parse_for(raw: &str) -> Option<ForExpr> {
    let trimmed = raw.trim();
    let (head, key_part) = match trimmed.find(" by ") {
        Some(i) => (&trimmed[..i], Some(trimmed[i + 4..].trim())),
        None => (trimmed, None),
    };
    let in_idx = head.find(" in ")?;
    let item_raw = head[..in_idx].trim();
    let source_name = head[in_idx + 4..].trim().to_string();
    if !is_path(&source_name) {
        return None;
    }
    let (item_name, index_name) =
        if let Some(inner) = item_raw.strip_prefix('(').and_then(|s| s.strip_suffix(')')) {
            let mut parts = inner.split(',').map(str::trim);
            let item = parts.next()?.to_string();
            let idx = parts.next().map(str::to_string);
            // Reject a third part: the runtime `ITEM_RE` matches ONLY `(item)` or
            // `(item, index)` — `(a, b, c)` must fail here too.
            if parts.next().is_some() {
                return None;
            }
            if !is_ident(&item) || idx.as_deref().is_some_and(|s| !is_ident(s)) {
                return None;
            }
            (item, idx)
        } else {
            if !is_ident(item_raw) {
                return None;
            }
            (item_raw.to_string(), None)
        };
    let key_paths = match key_part {
        None => Vec::new(),
        Some(k) => {
            let paths: Vec<String> = k.split(',').map(|s| s.trim().to_string()).collect();
            if paths.is_empty() || paths.iter().any(|p| !is_path(p)) {
                return None;
            }
            paths
        }
    };
    Some(ForExpr {
        item_name,
        index_name,
        source_name,
        key_paths,
    })
}

/// Parse a dotted path string (`c.detailHref`) into an Expr rooted at the map
/// binding `item`. Returns None if the path's root is NOT the binding (caller
/// then bails out of SSR — conservative: SSR only when all dynamic paths root at
/// the item).
pub fn path_to_map_expr(path: &str, item: &str) -> Option<Expr> {
    if !is_path(path) {
        return None;
    }
    let mut parts = path.split('.');
    let root = parts.next()?;
    if root != item {
        return None;
    }
    let rest: Vec<String> = parts.map(str::to_string).collect();
    if rest.is_empty() {
        Some(Expr::MapBinding(root.to_string()))
    } else {
        Some(Expr::MapMember {
            root: root.to_string(),
            path: rest,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_simple() {
        let p = parse_for("c in items by c.id").unwrap();
        assert_eq!(p.item_name, "c");
        assert_eq!(p.index_name, None);
        assert_eq!(p.source_name, "items");
        assert_eq!(p.key_paths, vec!["c.id".to_string()]);
    }
    #[test]
    fn parses_index_and_composite_key() {
        let p = parse_for("(c, i) in items by c.a, c.b").unwrap();
        assert_eq!(p.item_name, "c");
        assert_eq!(p.index_name.as_deref(), Some("i"));
        assert_eq!(p.key_paths, vec!["c.a".to_string(), "c.b".to_string()]);
    }
    #[test]
    fn no_by_clause_is_ok() {
        let p = parse_for("c in items").unwrap();
        assert!(p.key_paths.is_empty());
    }
    #[test]
    fn rejects_malformed() {
        assert!(parse_for("garbage").is_none());
        assert!(parse_for("c in a+b by c.id").is_none()); // source not a path
    }
    #[test]
    fn rejects_runtime_divergences() {
        // three-part paren form — runtime ITEM_RE rejects it
        assert!(parse_for("(c, i, x) in items").is_none());
        // non-ASCII identifier — runtime `\w` is ASCII-only
        assert!(parse_for("pokémon in items").is_none());
        assert!(parse_for("c in héros").is_none());
        // empty / whitespace-only
        assert!(parse_for("").is_none());
        assert!(parse_for("   ").is_none());
        // empty key part after `by`
        assert!(parse_for("c in items by").is_none());
        assert!(parse_for("c in items by c.id,").is_none()); // trailing comma
    }
    #[test]
    fn accepts_dotted_source() {
        let p = parse_for("c in store.items by c.id").unwrap();
        assert_eq!(p.source_name, "store.items");
    }
    #[test]
    fn path_to_expr_member() {
        let e = path_to_map_expr("c.detailHref", "c").unwrap();
        assert!(matches!(e, crate::ir::Expr::MapMember { root, path }
            if root == "c" && path == vec!["detailHref".to_string()]));
    }
    #[test]
    fn path_to_expr_bare_binding() {
        let e = path_to_map_expr("c", "c").unwrap();
        assert!(matches!(e, crate::ir::Expr::MapBinding(r) if r == "c"));
    }
    #[test]
    fn path_to_expr_rejects_foreign_root() {
        assert!(path_to_map_expr("other.x", "c").is_none());
    }
}
