//! Inlinability gate — pure-syntactic analysis of a component's function body.
//!
//! This module decides whether a component body can be inlined into the Jinja
//! template pipeline, gating only on hooks and side-effects.  Expression
//! translatability (whether individual JSX exprs can be lowered) is checked
//! separately by the translator (T5) and is not the concern of this module.
//!
//! # Input type
//!
//! [`analyze`] takes `&swc_core::ecma::ast::BlockStmt` — the *function body
//! block* reached through `find_default_export` (the same recognizer `lower`
//! uses).  That recognizer normalizes every accepted declaration shape to a
//! `Function`, synthesizing a `{ return …; }` block for an expression-bodied
//! arrow, so `BlockStmt` stays the canonical body type here no matter how the
//! component was written.
//!
//! # Visitor approach
//!
//! Uses `swc_core::ecma::visit::Visit` (available via the `ecma_visit` feature
//! already enabled in this crate's `Cargo.toml`).  An early-exit trick (an
//! `Option<FallbackReason>` accumulator that short-circuits further walking once
//! set) keeps the implementation O(first-hit) for the common fast path.

use swc_core::ecma::ast::{BlockStmt, CallExpr, Callee, Expr, MemberProp, Stmt, ThrowStmt};
use swc_core::ecma::visit::{Visit, VisitWith};

// ── Public API ────────────────────────────────────────────────────────────────

/// Why a component body cannot be inlined.
#[derive(Debug, Clone, PartialEq)]
pub enum FallbackReason {
    /// A React hook call was found, e.g. `useState`, `useEffect`.
    Hook(String),
    /// A side-effecting construct was found, e.g. `"await"`, `"throw"`, `"console.<prop>"`.
    SideEffect(String),
    /// The component reference could not be resolved (used by the caller, never
    /// produced by [`analyze`] itself).
    Unresolved(String),
}

impl std::fmt::Display for FallbackReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FallbackReason::Hook(name) => {
                write!(f, "component calls React hook `{name}` — cannot inline")
            }
            FallbackReason::SideEffect(what) => {
                write!(f, "component has side-effect `{what}` — cannot inline")
            }
            FallbackReason::Unresolved(name) => {
                write!(
                    f,
                    "component `{name}` could not be resolved — cannot inline"
                )
            }
        }
    }
}

/// Whether a component body is safe to inline into the Jinja template pipeline.
#[derive(Debug, Clone, PartialEq)]
pub enum Inlinability {
    /// The body contains no hooks or side-effects detected by this gate.
    Inlinable,
    /// The body must fall back; the reason is attached.
    Fallback(FallbackReason),
}

/// Analyze a component's function body block for hooks and side-effects.
///
/// Walk the entire `BlockStmt` (including all nested expressions, JSX
/// containers, `if` branches, `const` initialisers, etc.) and return
/// [`Inlinability::Fallback`] on the FIRST detected problem:
///
/// - Any `CallExpr` whose callee is a bare `Ident` matching `^use[A-Z]` →
///   [`FallbackReason::Hook`].
/// - Any `AwaitExpr` → [`FallbackReason::SideEffect("await")`].
/// - Any `ThrowStmt` → [`FallbackReason::SideEffect("throw")`].
/// - Any `CallExpr` whose callee is a member expression rooted at `console` →
///   [`FallbackReason::SideEffect("console.<prop>")`].
///
/// Returns [`Inlinability::Inlinable`] when none of the above are found.
pub fn analyze(body: &BlockStmt) -> Inlinability {
    let mut visitor = AnalyzeVisitor { found: None };
    body.visit_with(&mut visitor);
    match visitor.found {
        None => Inlinability::Inlinable,
        Some(reason) => Inlinability::Fallback(reason),
    }
}

// ── Visitor implementation ────────────────────────────────────────────────────

struct AnalyzeVisitor {
    found: Option<FallbackReason>,
}

impl AnalyzeVisitor {
    /// Returns `true` if we have already found a reason and should skip further
    /// work.  The visitor does not have an early-exit mechanism built in, so we
    /// check this at the top of every `visit_*` override and bail immediately.
    #[inline]
    fn done(&self) -> bool {
        self.found.is_some()
    }
}

impl Visit for AnalyzeVisitor {
    // ── Hooks: CallExpr with bare ident callee matching `^use[A-Z]` ─────────

    fn visit_call_expr(&mut self, call: &CallExpr) {
        if self.done() {
            return;
        }

        if let Callee::Expr(callee_expr) = &call.callee {
            match callee_expr.as_ref() {
                // Bare ident call: `useState(0)`, `useTheme()`, …
                Expr::Ident(id) => {
                    let name = id.sym.as_ref();
                    if is_hook_name(name) {
                        self.found = Some(FallbackReason::Hook(name.to_string()));
                        return; // no need to walk arguments
                    }
                }
                // Member expression callee: detect `console.log(…)` etc.
                Expr::Member(member) => {
                    if let Expr::Ident(obj) = member.obj.as_ref()
                        && obj.sym.as_ref() == "console"
                    {
                        let prop = match &member.prop {
                            MemberProp::Ident(id) => id.sym.to_string(),
                            MemberProp::PrivateName(p) => p.name.to_string(),
                            MemberProp::Computed(_) => "<computed>".to_string(),
                        };
                        self.found = Some(FallbackReason::SideEffect(format!("console.{prop}")));
                        return;
                    }
                }
                _ => {}
            }
        }

        // Continue walking into arguments and nested expressions.
        call.visit_children_with(self);
    }

    // ── Side-effects ─────────────────────────────────────────────────────────

    fn visit_await_expr(&mut self, node: &swc_core::ecma::ast::AwaitExpr) {
        if self.done() {
            return;
        }
        self.found = Some(FallbackReason::SideEffect("await".to_string()));
        // No need to recurse; the await itself is enough.
        let _ = node; // suppress unused warning
    }

    fn visit_stmt(&mut self, stmt: &Stmt) {
        if self.done() {
            return;
        }
        if let Stmt::Throw(ThrowStmt { .. }) = stmt {
            self.found = Some(FallbackReason::SideEffect("throw".to_string()));
            return;
        }
        // For all other statements, recurse normally.
        stmt.visit_children_with(self);
    }
}

/// True when `name` matches `^use[A-Z]` (React hook naming convention).
fn is_hook_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next() == Some('u')
        && chars.next() == Some('s')
        && chars.next() == Some('e')
        && matches!(chars.next(), Some(c) if c.is_ascii_uppercase())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser;

    /// Parse `src`, recognize the default-exported component in WHATEVER shape
    /// it was written, and return its body block. Goes through the same
    /// recognizer as the real pipeline so a shape the pipeline accepts can
    /// never be untestable here.
    fn parse_and_get_body(src: &str) -> swc_core::ecma::ast::BlockStmt {
        let parsed = parser::parse(src, "test.tsx").expect("parse failed");
        let decl = crate::lower::find_default_export(&parsed.module)
            .expect("no default-exported component found in source");
        decl.function
            .body
            .clone()
            .expect("component declaration has no body")
    }

    #[test]
    fn pure_props_jsx_inlinable() {
        let src =
            r#"export default function C({title}: {title: string}) { return <h1>{title}</h1>; }"#;
        let body = parse_and_get_body(src);
        assert_eq!(analyze(&body), Inlinability::Inlinable);
    }

    #[test]
    fn usestate_hook_fallback() {
        let src = r#"export default function C() {
            const [x, setX] = useState(0);
            return <div>{x}</div>;
        }"#;
        let body = parse_and_get_body(src);
        assert_eq!(
            analyze(&body),
            Inlinability::Fallback(FallbackReason::Hook("useState".to_string()))
        );
    }

    #[test]
    fn custom_hook_fallback() {
        let src = r#"export default function C() {
            const theme = useTheme();
            return <div>{theme}</div>;
        }"#;
        let body = parse_and_get_body(src);
        assert_eq!(
            analyze(&body),
            Inlinability::Fallback(FallbackReason::Hook("useTheme".to_string()))
        );
    }

    #[test]
    fn await_fallback() {
        let src = r#"export default async function C() {
            const data = await fetch("/api");
            return <div/>;
        }"#;
        let body = parse_and_get_body(src);
        assert_eq!(
            analyze(&body),
            Inlinability::Fallback(FallbackReason::SideEffect("await".to_string()))
        );
    }

    #[test]
    fn throw_fallback() {
        let src = r#"export default function C() {
            throw new Error("x");
        }"#;
        let body = parse_and_get_body(src);
        assert_eq!(
            analyze(&body),
            Inlinability::Fallback(FallbackReason::SideEffect("throw".to_string()))
        );
    }

    #[test]
    fn console_fallback() {
        let src = r#"export default function C() {
            console.log("x");
            return <div/>;
        }"#;
        let body = parse_and_get_body(src);
        assert_eq!(
            analyze(&body),
            Inlinability::Fallback(FallbackReason::SideEffect("console.log".to_string()))
        );
    }
}
