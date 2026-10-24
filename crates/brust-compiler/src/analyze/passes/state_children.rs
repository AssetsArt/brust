//! F404: a state whose initial value reads `children` is refused by name, `state-from-children`.
//!
//! `children` is not a value native code holds: it is the markup a caller hands to the component, which the server
//! prints where the component places it and the client never receives. `const [c] = useState(children)` made it a
//! state cell seeded with that missing value, so the page printed nothing where React prints the child. Printing the
//! slot through the cell is not supported, so the component falls back to React.
//!
//! The initial value is judged by what it reads, not by its spelling: `props.children`, a destructured or renamed
//! `children`, a local or an expression that holds it, a lazy initializer, `useReducer`'s initial state and the
//! argument of an inlined custom hook (it arrives as the state's initial value) are all the same read. A read of the
//! whole props object, or of a rest of it that cannot have left `children` out, may carry it too.
use super::PassCtx;
use super::deps::DepsCx;
use crate::ir::{ComponentIR, Diagnostic, Expr, ServerExpr};

pub fn check(ir: &mut ComponentIR, ctx: &PassCtx<'_>) {
    let cx = DepsCx::new(ir);
    let names_children = ir.props.iter().any(|p| p.name == "children");
    let mut found = Vec::new();
    for s in &ir.state {
        let at = match &s.init {
            Expr::Raw(r) | Expr::Server(ServerExpr(r)) => r.loc,
            _ => continue,
        };
        let roots = cx.deps_expr(&s.init, &[]).prop_roots();
        // `*` is the whole props object or a rest of it; a component that declares `children` itself gets the rest
        // without it.
        if roots.contains("children") || (roots.contains("*") && !names_children) {
            found.push(at);
        }
    }
    for at in found {
        ir.diagnostics.push(Diagnostic::fallback(
            "state-from-children",
            format!(
                "the initial value of a state at line {} reads `children`, which is markup the caller passes and not a value the component holds",
                ctx.line(at)
            ),
            at,
            "render {children} where it is needed, or keep this component in React",
        ));
    }
}
